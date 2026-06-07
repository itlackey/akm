/**
 * `akm env path` / `env export` / `env run` CLI behavior.
 *
 * `env run` MUST keep spawning a real subprocess: the CLI spawns the target
 * command with stdout/stderr inherited to the real file descriptors, so the
 * injected-env output is the child's, not the parent's, and the in-process
 * console-capture harness cannot observe it. A real process boundary is the
 * whole point. Pure path/export resolution runs in-process.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resetGraphBoostCache } from "../src/indexer/graph/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../src/llm/embedder";
import { runCliCapture } from "./_helpers/cli";
import { makeStashDir, type SandboxedDir, withEnv } from "./_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

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

function spawnCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
  stdinInput?: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
    input: stdinInput,
    env: {
      ...process.env,
      AKM_STASH_DIR: undefined,
      ...extraEnv,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
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

    const { stdout, stderr, status } = await runCli(["env", "path", "env:does-not-exist"], {
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

    const { stdout, stderr, status } = await runCli(["env", "path", "env:myenv"], {
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

    const { stdout, status } = await runCli(["env", "export", "env:prod", "-o", outFile], { AKM_STASH_DIR: stashDir });

    expect(status).toBe(0);
    expect(stdout).not.toContain("$(touch");
    const script = fs.readFileSync(outFile, "utf8");
    expect(script).toContain("export FOO='bar'");
    expect(script).toContain("export EVIL='$(touch /tmp/akm-nope)'");
  });
});

describe("env run", () => {
  // KEPT AS A SUBPROCESS: `env run` spawns the target with stdout inherited to
  // the real fd; the injected-env output is the child's, not visible in-process.
  test("runs a command with the whole env file injected", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=bar\nBAR=baz\n", "utf8");

    const { stdout, stderr, status } = spawnCli(
      ["env", "run", "env:prod", "--", "bash", "-lc", 'printf \'%s %s\' "$FOO" "$BAR"'],
      { AKM_STASH_DIR: stashDir },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("bar baz");
    expect(stderr.trim()).toBe("");
  });

  test("substitutes ${secret:NAME} tokens with the sibling secret value", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.mkdirSync(path.join(stashDir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "secrets", "my_api_token"), "s3cr3t", "utf8");
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=Bearer ${secret:my_api_token}\n", "utf8");

    const { stdout, status } = spawnCli(["env", "run", "env:prod", "--", "bash", "-lc", "printf '%s' \"$API_KEY\""], {
      AKM_STASH_DIR: stashDir,
    });

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("Bearer s3cr3t");
  });

  test("substitutes multiple tokens embedded in a value and leaves ${HOME} untouched", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.mkdirSync(path.join(stashDir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "secrets", "a"), "AAA", "utf8");
    fs.writeFileSync(path.join(stashDir, "secrets", "b"), "BBB", "utf8");
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "PAIR=${secret:a}:${secret:b}\nKEEP=${HOME}\n", "utf8");

    const { stdout, status } = spawnCli(
      ["env", "run", "env:prod", "--", "bash", "-lc", 'printf \'%s|%s\' "$PAIR" "$KEEP"'],
      { AKM_STASH_DIR: stashDir },
    );

    expect(status).toBe(0);
    // PAIR fully substituted; KEEP left as the literal token (no secret named HOME).
    expect(stdout.trim()).toBe("AAA:BBB|${HOME}");
  });

  test("exits non-zero and injects nothing when a referenced secret is missing", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=${secret:absent}\n", "utf8");

    const { stdout, stderr, status } = await runCli(["env", "run", "env:prod", "--", "true"], {
      AKM_STASH_DIR: stashDir,
    });

    expect(status).not.toBe(0);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("secret:absent");
    expect(parsed.error).toContain("env:prod");
    // No value content leaked to stdout.
    expect(stdout.trim()).toBe("");
  });

  test("rejects the removed single-key `<ref>/KEY` form with a signpost to secrets", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=bar\n", "utf8");

    const { stderr, status } = await runCli(["env", "run", "env:prod/FOO", "--", "true"], {
      AKM_STASH_DIR: stashDir,
    });

    expect(status).toBe(2);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("akm secret run");
  });

  test("warns but injects when a first-party env file contains a hijack var", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    // EDITOR is on the dangerous-key list (RCE vector when sourced from an
    // untrusted stash) but, unlike PATH, does not break command resolution —
    // so this exercises the warn-and-inject path for a first-party stash.
    fs.writeFileSync(path.join(stashDir, "env", "danger.env"), "EDITOR=/evil\nFOO=ok\n", "utf8");

    const { stdout, stderr, status } = spawnCli(
      ["env", "run", "env:danger", "--", "bash", "-lc", "printf '%s' \"$FOO\""],
      { AKM_STASH_DIR: stashDir },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("ok");
    expect(stderr).toContain("EDITOR");
  });

  test("--only injects just the named keys", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=foo\nBAR=bar\nBAZ=baz\n", "utf8");

    const { stdout, status } = spawnCli(
      ["env", "run", "env:prod", "--only", "FOO,BAZ", "--", "bash", "-lc", 'printf \'%s|%s|%s\' "$FOO" "$BAR" "$BAZ"'],
      { AKM_STASH_DIR: stashDir },
    );

    expect(status).toBe(0);
    // FOO and BAZ injected; BAR excluded.
    expect(stdout.trim()).toBe("foo||baz");
  });

  test("--except injects all but the named keys", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=foo\nBAR=bar\n", "utf8");

    const { stdout, status } = spawnCli(
      ["env", "run", "env:prod", "--except", "BAR", "--", "bash", "-lc", 'printf \'%s|%s\' "$FOO" "$BAR"'],
      { AKM_STASH_DIR: stashDir },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("foo|");
  });

  test("--only and --except together is rejected", async () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=foo\n", "utf8");

    const { stderr, status } = await runCli(
      ["env", "run", "env:prod", "--only", "FOO", "--except", "BAR", "--", "true"],
      {
        AKM_STASH_DIR: stashDir,
      },
    );

    expect(status).toBe(2);
    expect(stderr).toContain("only one of --only or --except");
  });
});

describe("vault run (removed in 0.9.0)", () => {
  // KEPT AS A SUBPROCESS: child-process stdout boundary, same as env run.
  test("the `akm vault` verb no longer exists", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=bar\nBAR=baz\n", "utf8");

    const { status } = spawnCli(["vault", "run", "vault:prod", "--", "bash", "-lc", 'printf \'%s %s\' "$FOO" "$BAR"'], {
      AKM_STASH_DIR: stashDir,
    });

    expect(status).not.toBe(0);
  });
});
