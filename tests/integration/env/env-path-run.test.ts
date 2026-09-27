/**
 * `akm env path` / `env export` / `env run` CLI behavior — in-process only,
 * with ONE exception.
 *
 * Most tests here run through the in-process `runCliCapture` harness: pure
 * path/export resolution plus `env run` error paths that fail BEFORE any
 * child process is spawned. The `env run` / `secret run` happy paths that
 * actually spawn a target command (whose fd-inherited stdout is the
 * contract) live in tests/integration/env-run.test.ts — only a real process
 * boundary can observe the child's output.
 *
 * Exception: the "format-exempt" warning test below needs a real subprocess.
 * That warning is emitted by `src/cli.ts`'s startup block (`isFormatExemptCommand`),
 * which `runCliCapture` (tests/_helpers/cli.ts) deliberately does not
 * replicate — see that harness's own module doc.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../../src/llm/embedder";
import { runCliCapture } from "../../_helpers/cli";
import { makeStashDir, type SandboxedDir, withEnv } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

function makeStash(): string {
  const stash = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

async function runCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_CONFIG_DIR: undefined, ...extraEnv }, async () => {
    clearEmbeddingCache();
    resetLocalEmbedder();
    const { stdout, stderr, code } = await runCliCapture(args);
    return { stdout, stderr, status: code };
  });
}

beforeEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
});

afterEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
});

describe("env path", () => {
  test("returns {ok:false, error} JSON on stderr and exits 1 when the env file does not exist", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });

    const { stdout, stderr, status } = await runCli(["env", "path", "env/does-not-exist"], {
      AKM_BUNDLE_DIR: stashDir,
    });

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toContain("Env not found");
    expect(stdout.trim()).toBe("");
  });

  test("prints the absolute env path on stdout (with a stderr unsafe-source warning)", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    const envPath = path.join(stashDir, "env", "myenv.env");
    fs.writeFileSync(envPath, "FOO=bar\n", "utf8");

    const { stdout, stderr, status } = await runCli(["env", "path", "env/myenv"], {
      AKM_BUNDLE_DIR: stashDir,
    });

    expect(status).toBe(0);
    expect(stdout.trim()).toBe(envPath);
    // The path is on stdout uncontaminated; the warning steers to `env run`.
    expect(stderr).toContain("akm env run");
  });

  // B3/B4 (W1-F): a first attempt at this fix routed `env path` through
  // `output()` so `--format` "worked" — but the CLI's default format is
  // `json`, so a bare `akm env path <ref>` (exactly how `$(akm env path
  // foo)` is always written) started emitting `{"path":"..."}` instead of
  // the raw path, silently breaking every existing shell substitution. The
  // correct fix is declaring `env path` format-exempt
  // (src/output/format-exempt.ts) like `env run`/`secret run`/`hints`: the
  // bare path IS the payload, so `--format` cannot do anything useful to it.
  // This pins the exempt contract from STABILITY.md: passing `--format`
  // warns on stderr, but stdout — the thing a script actually captures via
  // `$(...)` — is untouched. NOTE: `runCliCapture` (tests/_helpers/cli.ts)
  // does not run `src/cli.ts`'s startup block, where the exempt-format
  // warning is emitted (`isFormatExemptCommand`) — so this needs a real
  // subprocess, unlike the rest of this file.
  test("--format json warns on stderr but stdout stays the bare path (format-exempt)", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    const envPath = path.join(stashDir, "env", "myenv.env");
    fs.writeFileSync(envPath, "FOO=bar\n", "utf8");

    const result = spawnSync(
      "bun",
      [path.join(import.meta.dir, "..", "..", "..", "src", "cli.ts"), "env", "path", "env/myenv", "--format", "json"],
      { encoding: "utf8", env: { ...process.env, AKM_BUNDLE_DIR: stashDir, AKM_CONFIG_DIR: undefined } },
    );

    expect(result.status).toBe(0);
    expect((result.stdout ?? "").trim()).toBe(envPath);
    expect(result.stderr ?? "").toContain("'--format' has no effect on 'akm env path'");
  });
});

describe("env export", () => {
  test("writes safe single-quoted export lines to --out and never to stdout", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=bar\nEVIL=$(touch /tmp/akm-nope)\n", "utf8");
    const outFile = path.join(stashDir, "out.sh");

    const { stdout, status } = await runCli(["env", "export", "env/prod", "-o", outFile], { AKM_BUNDLE_DIR: stashDir });

    expect(status).toBe(0);
    expect(stdout).not.toContain("$(touch");
    const script = fs.readFileSync(outFile, "utf8");
    expect(script).toContain("export FOO='bar'");
    expect(script).toContain("export EVIL='$(touch /tmp/akm-nope)'");
  });
});

describe("env run", () => {
  // Only pre-spawn error paths run here; the spawn-and-observe-child-output
  // tests live in tests/integration/env-run.test.ts.
  test("exits non-zero and injects nothing when a referenced secret is missing", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=${secret:absent}\n", "utf8");

    const { stdout, stderr, status } = await runCli(["env", "run", "env/prod", "--", "true"], {
      AKM_BUNDLE_DIR: stashDir,
    });

    // NotFoundError (referenced secret missing) -> exit 1 / FILE_NOT_FOUND.
    // Ground-truthed by probing the actual CLI output before pinning.
    expect(status).toBe(1);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("FILE_NOT_FOUND");
    expect(parsed.error).toContain("secrets/absent");
    expect(parsed.error).toContain("env/prod");
    // No value content leaked to stdout.
    expect(stdout.trim()).toBe("");
  });

  test("rejects the removed single-key `<ref>/KEY` form with a signpost to secrets", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=bar\n", "utf8");

    const { stderr, status } = await runCli(["env", "run", "env/prod/FOO", "--", "true"], {
      AKM_BUNDLE_DIR: stashDir,
    });

    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("akm secret run");
  });

  test("--only and --except together is rejected", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=foo\n", "utf8");

    const { stderr, status } = await runCli(
      ["env", "run", "env/prod", "--only", "FOO", "--except", "BAR", "--", "true"],
      {
        AKM_BUNDLE_DIR: stashDir,
      },
    );

    expect(status).toBe(2);
    expect(stderr).toContain("only one of --only or --except");
  });
});
