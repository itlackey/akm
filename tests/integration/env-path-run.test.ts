/**
 * `akm env path` / `env export` / `env run` CLI behavior — in-process only.
 *
 * All tests here run through the in-process `runCliCapture` harness: pure
 * path/export resolution plus `env run` error paths that fail BEFORE any
 * child process is spawned. The `env run` / `secret run` happy paths that
 * actually spawn a target command (whose fd-inherited stdout is the
 * contract) live in tests/integration/env-run.test.ts — only a real process
 * boundary can observe the child's output.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetGraphBoostCache } from "../../src/indexer/graph/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../src/llm/embedder";
import { runCliCapture } from "../_helpers/cli";
import { makeStashDir, type SandboxedDir, withEnv } from "../_helpers/sandbox";

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
    resetGraphBoostCache();
    const { stdout, stderr, code } = await runCliCapture(args);
    return { stdout, stderr, status: code };
  });
}

beforeEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
});

afterEach(() => {
  clearEmbeddingCache();
  resetLocalEmbedder();
  resetGraphBoostCache();
});

describe("env path", () => {
  test("returns {ok:false, error} JSON on stderr and exits 1 when the env file does not exist", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });

    const { stdout, stderr, status } = await runCli(["env", "path", "env/does-not-exist"], {
      AKM_STASH_DIR: stashDir,
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
      AKM_STASH_DIR: stashDir,
    });

    expect(status).toBe(0);
    expect(stdout.trim()).toBe(envPath);
    // The path is on stdout uncontaminated; the warning steers to `env run`.
    expect(stderr).toContain("akm env run");
  });
});

describe("env export", () => {
  test("writes safe single-quoted export lines to --out and never to stdout", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=bar\nEVIL=$(touch /tmp/akm-nope)\n", "utf8");
    const outFile = path.join(stashDir, "out.sh");

    const { stdout, status } = await runCli(["env", "export", "env/prod", "-o", outFile], { AKM_STASH_DIR: stashDir });

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
      AKM_STASH_DIR: stashDir,
    });

    expect(status).not.toBe(0);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
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
      AKM_STASH_DIR: stashDir,
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
        AKM_STASH_DIR: stashDir,
      },
    );

    expect(status).toBe(2);
    expect(stderr).toContain("only one of --only or --except");
  });
});

describe("vault run (removed in 0.9.0)", () => {
  test("the `akm vault` verb no longer exists", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=bar\nBAR=baz\n", "utf8");

    const { status } = await runCli(
      ["vault", "run", "vault:prod", "--", "bash", "-lc", 'printf \'%s %s\' "$FOO" "$BAR"'],
      {
        AKM_STASH_DIR: stashDir,
      },
    );

    // citty exits non-zero for an unknown top-level command.
    expect(status).not.toBe(0);
  });
});
