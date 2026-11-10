// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setSecret } from "../../../src/commands/env/secret";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../../src/llm/embedder";
import { runCliCapture } from "../../_helpers/cli";
import {
  makeStashDir,
  type SandboxedDir,
  withBundle,
  withBundleSync,
  withEnv,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

/**
 * `secret run` happy path — REQUIRES a real subprocess.
 *
 * `secret run` spawns the target command with stdout inherited to the real fd;
 * the secret value is injected into the CHILD process's environment. That
 * injection is unobservable from an in-process harness (the value never enters
 * this process's env or capture buffers), so this test spawns the real CLI and
 * reads what the child prints. The validation-failure `secret run` cases
 * (which fail before any spawn) remain in-process in tests/secret.test.ts.
 */

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

const disposers: SandboxedDir[] = [];
function makeStash(): string {
  const stash = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

function spawnCli(
  args: string[],
  options: { stashDir?: string; env?: Record<string, string | undefined> } = {},
): { stdout: string; stderr: string; status: number } {
  const result = withBundleSync(options.stashDir, () =>
    spawnSync("bun", [cliPath, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      cwd: repoRoot,
      env: { ...process.env, ...options.env },
    }),
  );
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

describe("secret run", () => {
  // KEPT AS A SUBPROCESS: the value is injected into the CHILD process env.
  test("injects the secret value into the named env var of the child", () => {
    const stashDir = makeStash();
    setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("super-secret-token"));

    const { stdout, status } = spawnCli(
      ["secret", "run", "secrets/demo", "TOKEN", "--", "bash", "-lc", 'printf "%s" "$TOKEN"'],
      { stashDir: stashDir },
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("super-secret-token");
  });

  test("injects the trimmed value: a trailing newline never reaches the child", () => {
    const stashDir = makeStash();
    setSecret(path.join(stashDir, "secrets", "padded"), Buffer.from("tok\n\n"));

    const { stdout, status } = spawnCli(
      ["secret", "run", "secrets/padded", "TOKEN", "--", "bash", "-lc", "printf '[%s]' \"$TOKEN\""],
      { stashDir: stashDir },
    );
    expect(status).toBe(0);
    expect(stdout).toBe("[tok]");
  });

  test("a bare name is a usage error naming the full ref", () => {
    const stashDir = makeStash();
    setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("v"));

    const { stderr, status } = spawnCli(["secret", "run", "demo", "TOKEN", "--", "true"], { stashDir: stashDir });
    expect(status).toBe(2);
    expect(JSON.parse(stderr.trim()).error).toContain("secrets/demo");
  });
});

describe("secret-stdin", () => {
  /**
   * Secret CLI — stdin path.
   *
   * These tests MUST spawn a real Bun subprocess: the default `secret set`
   * reads the value from process.stdin, and the in-process harness
   * (runCliCapture) has no way to feed stdin. Everything else about the
   * secret surface is covered in-process in tests/secret.test.ts.
   */

  const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
  const cliPath = path.join(repoRoot, "src", "cli.ts");

  const disposers: SandboxedDir[] = [];
  function makeStash(): string {
    const stash = makeStashDir();
    disposers.push(stash);
    return stash.dir;
  }

  afterAll(() => {
    for (const d of disposers) d.cleanup();
    disposers.length = 0;
  });

  function spawnCli(
    args: string[],
    options: { stashDir?: string; env?: Record<string, string | undefined> } = {},
    stdinInput?: string,
  ): { stdout: string; stderr: string; status: number } {
    const result = withBundleSync(options.stashDir, () =>
      spawnSync("bun", [cliPath, ...args], {
        encoding: "utf8",
        timeout: 15_000,
        cwd: repoRoot,
        input: stdinInput,
        env: { ...process.env, ...options.env },
      }),
    );
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
  }

  describe("secret set (stdin)", () => {
    test("reads the value from stdin and stores it", () => {
      const stashDir = makeStash();
      const { stderr, status } = spawnCli(["secret", "set", "secrets/demo"], { stashDir: stashDir }, "tok-from-stdin");
      expect(status).toBe(0);
      expect(stderr.trim()).toBe("");
      const fp = path.join(stashDir, "secrets", "demo");
      expect(fs.readFileSync(fp, "utf8")).toBe("tok-from-stdin");
    });

    test("strips a single trailing newline from the stdin value", () => {
      const stashDir = makeStash();
      withBundleSync(stashDir, () => spawnCli(["secret", "set", "secrets/demo"], {}, "tok\n"));
      expect(fs.readFileSync(path.join(stashDir, "secrets", "demo"), "utf8")).toBe("tok");
    });
  });
});

describe("secret-path-run", () => {
  /**
   * Secret `path` removal (D-49) and `run` validation (in-process).
   *
   *   - `secret path` was REMOVED from the CLI in 0.9.0 (R-027 / D-49), with
   *     `secret remove` (back in 0.10, see tests/secret.test.ts): an audit found
   *     `path` resolved a ref through the read-side, all-sources resolver while
   *     `remove` resolved it through the write-target resolver. The regression
   *     test below proves the removed spelling fails LOUDLY —
   *     exit 2, citty's "Unknown command" — via a REAL subprocess. citty's own
   *     CLIError (thrown because "path" is no longer a key in
   *     secretCommand.subCommands) is only reclassified from exit 1 to the
   *     documented exit 2 in the real entry point (`src/cli.ts`'s
   *     `import.meta.main`-gated startup block, R-032); the in-process harness
   *     (`runCliCapture`) drives citty's `runCommand` directly and does not run
   *     that reclassification, so it would misreport the exit code here. See
   *     tests/integration/cli-errors.test.ts's "R-032" describe block for the
   *     same real-subprocess-required pattern applied to other removed surfaces.
   *   - `secret run` validation failures (invalid var name, missing command)
   *     run in-process — they fail before any child spawn. Dangerous-key
   *     injection (no block, #1237) also runs in-process; the child writes the
   *     value it saw to a file instead of inheriting stdio.
   *   - The happy-path `secret run` injection test lives in
   *     tests/integration/secret/secret-run.test.ts: it needs a real process boundary
   *     to observe the CHILD's env.
   */

  const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
  const cliPath = path.join(repoRoot, "src", "cli.ts");

  /** Real-subprocess runner — see the module docstring for why this is required. */
  function spawnCli(
    args: string[],
    options: { stashDir?: string; env?: Record<string, string | undefined> } = {},
  ): { stdout: string; stderr: string; status: number } {
    const result = withBundleSync(options.stashDir, () =>
      spawnSync("bun", [cliPath, ...args], {
        encoding: "utf8",
        timeout: 15_000,
        cwd: repoRoot,
        env: { ...process.env, ...options.env },
      }),
    );
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
  }

  const disposers: SandboxedDir[] = [];
  function makeStash(): string {
    const stash = makeStashDir();
    disposers.push(stash);
    return stash.dir;
  }

  afterAll(() => {
    for (const d of disposers) d.cleanup();
    disposers.length = 0;
  });

  beforeEach(() => {
    clearEmbeddingCache();
    resetLocalEmbedder();
  });
  afterEach(() => {
    clearEmbeddingCache();
    resetLocalEmbedder();
  });

  async function runCli(
    args: string[],
    options: { stashDir?: string; env?: Record<string, string | undefined> } = {},
  ): Promise<{ stdout: string; stderr: string; status: number }> {
    return withEnv({ ...options.env }, () =>
      withBundle(options.stashDir, async () => {
        clearEmbeddingCache();
        resetLocalEmbedder();
        const { stdout, stderr, code } = await runCliCapture(args);
        return { stdout, stderr, status: code };
      }),
    );
  }

  describe("secret path — removed in 0.9.0", () => {
    test("`akm secret path <ref>` fails loudly: exit 2, citty's Unknown command, no path printed", () => {
      const stashDir = makeStash();
      const fp = path.join(stashDir, "secrets", "demo");
      setSecret(fp, Buffer.from("super-secret-token-value"));

      const { stdout, stderr, status } = withBundleSync(stashDir, () => spawnCli(["secret", "path", "secrets/demo"]));

      expect(status).toBe(2);
      expect(stderr).toContain("Unknown command");
      expect(stderr).toContain("path");
      // Not a silent no-op: no path on stdout, and the value never leaks either way.
      expect(stdout).not.toContain(fp);
      expect(stdout).not.toContain("super-secret-token-value");
      expect(stderr).not.toContain("super-secret-token-value");
    });
  });

  describe("secret run", () => {
    // The happy-path injection test (secret value visible in the CHILD's env)
    // lives in tests/integration/secret/secret-run.test.ts — it requires a real
    // subprocess. The cases below fail validation before any child spawn.
    test("injects a dangerous target variable name from the primary stash with no block or warning (#1237)", async () => {
      const stashDir = makeStash();
      setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("v"));
      const out = path.join(stashDir, "out.txt");
      const { status, stderr } = await runCli(
        [
          "secret",
          "run",
          "secrets/demo",
          "GIT_SSH_COMMAND",
          "--",
          "/bin/sh",
          "-c",
          `printf %s "$GIT_SSH_COMMAND" > ${out}`,
        ],
        { stashDir: stashDir },
      );
      expect(status).toBe(0);
      expect(stderr).not.toContain("Injecting anyway");
      expect(fs.readFileSync(out, "utf8")).toBe("v");
    });

    test("injects a dangerous target variable name from a non-primary (installed) bundle with no block (#1237)", async () => {
      const primaryStashDir = makeStash();
      const vendorStashDir = makeStash();
      setSecret(path.join(vendorStashDir, "secrets", "demo"), Buffer.from("v"));
      writeSandboxConfig({ bundles: { vendor: { path: vendorStashDir } } });
      const out = path.join(primaryStashDir, "out.txt");

      const { status, stderr } = await runCli(
        [
          "secret",
          "run",
          "vendor//secrets/demo",
          "GIT_SSH_COMMAND",
          "--",
          "/bin/sh",
          "-c",
          `printf %s "$GIT_SSH_COMMAND" > ${out}`,
        ],
        { stashDir: primaryStashDir },
      );

      expect(status).toBe(0);
      expect(stderr).not.toContain("Refusing to inject");
      expect(fs.readFileSync(out, "utf8")).toBe("v");
    });

    test("rejects an invalid env var name", async () => {
      const stashDir = makeStash();
      setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("v"));
      const { status } = await runCli(["secret", "run", "secrets/demo", "not a var", "--", "true"], {
        stashDir: stashDir,
      });
      expect(status).toBe(2);
    });

    test("errors when no command is supplied after --", async () => {
      const stashDir = makeStash();
      setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("v"));
      const { status } = await withBundle(stashDir, () => runCli(["secret", "run", "secrets/demo", "TOKEN"]));
      expect(status).toBe(2);
    });
  });
});
