// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Secret `path`/`remove` removal (D-49) and `run` validation (in-process).
 *
 *   - `secret path` and `secret remove` were REMOVED from the CLI in 0.9.0
 *     (R-027 / D-49): an audit found `path` resolved a ref through the
 *     read-side, all-sources resolver while `remove` resolved it through the
 *     write-target resolver, so the two spellings could silently name
 *     DIFFERENT files for the same ref. The owner's ruling was to drop both
 *     subcommands rather than reconcile the resolvers (src/commands/env/secret-cli.ts).
 *     The regression tests below prove the removed spellings fail LOUDLY —
 *     exit 2, citty's "Unknown command" — via a REAL subprocess. citty's own
 *     CLIError (thrown because "path"/"remove" are no longer keys in
 *     secretCommand.subCommands) is only reclassified from exit 1 to the
 *     documented exit 2 in the real entry point (`src/cli.ts`'s
 *     `import.meta.main`-gated startup block, R-032); the in-process harness
 *     (`runCliCapture`) drives citty's `runCommand` directly and does not run
 *     that reclassification, so it would misreport the exit code here. See
 *     tests/integration/cli-errors.test.ts's "R-032" describe block for the
 *     same real-subprocess-required pattern applied to other removed surfaces.
 *   - `secret run` validation failures (LD_PRELOAD rejection, invalid var
 *     name, missing command) run in-process — they fail before any child
 *     spawn.
 *   - The happy-path `secret run` injection test lives in
 *     tests/integration/secret-run.test.ts: it needs a real process boundary
 *     to observe the CHILD's env.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setSecret } from "../../../src/commands/env/secret";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../../src/llm/embedder";
import { runCliCapture } from "../../_helpers/cli";
import { makeStashDir, type SandboxedDir, withEnv, writeSandboxConfig } from "../../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

/** Real-subprocess runner — see the module docstring for why this is required. */
function spawnCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
    env: { ...process.env, AKM_BUNDLE_DIR: undefined, ...extraEnv },
  });
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
  extraEnv: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; status: number }> {
  return withEnv({ AKM_CONFIG_DIR: undefined, ...extraEnv }, async () => {
    clearEmbeddingCache();
    resetLocalEmbedder();
    const { stdout, stderr, code } = await runCliCapture(args);
    return { stdout, stderr, status: code };
  });
}

describe("secret path / secret remove — removed in 0.9.0 (R-027 / D-49)", () => {
  test("`akm secret path <ref>` fails loudly: exit 2, citty's Unknown command, no path printed", () => {
    const stashDir = makeStash();
    const fp = path.join(stashDir, "secrets", "demo");
    setSecret(fp, Buffer.from("super-secret-token-value"));

    const { stdout, stderr, status } = spawnCli(["secret", "path", "secrets/demo"], { AKM_BUNDLE_DIR: stashDir });

    expect(status).toBe(2);
    expect(stderr).toContain("Unknown command");
    expect(stderr).toContain("path");
    // Not a silent no-op: no path on stdout, and the value never leaks either way.
    expect(stdout).not.toContain(fp);
    expect(stdout).not.toContain("super-secret-token-value");
    expect(stderr).not.toContain("super-secret-token-value");
  });

  test("`akm secret remove <ref>` fails loudly: exit 2, citty's Unknown command, secret left untouched", () => {
    const stashDir = makeStash();
    const fp = path.join(stashDir, "secrets", "demo");
    setSecret(fp, Buffer.from("v"));

    const { stderr, status } = spawnCli(["secret", "remove", "secrets/demo", "--yes"], { AKM_BUNDLE_DIR: stashDir });

    expect(status).toBe(2);
    expect(stderr).toContain("Unknown command");
    expect(stderr).toContain("remove");
    // Not a silent no-op: the file must still exist — a removed verb must
    // never fall through to some other mutation path.
    expect(fs.existsSync(fp)).toBe(true);
  });
});

describe("secret run", () => {
  // The happy-path injection test (secret value visible in the CHILD's env)
  // lives in tests/integration/secret-run.test.ts — it requires a real
  // subprocess. The cases below fail validation before any child spawn.
  test("warns and still runs for a dangerous target variable name on a first-party (primary) stash", async () => {
    const stashDir = makeStash();
    setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("v"));
    const { status, stdout, stderr } = await runCli(["secret", "run", "secrets/demo", "LD_PRELOAD", "--", "true"], {
      AKM_BUNDLE_DIR: stashDir,
    });
    expect(stderr).toContain("LD_PRELOAD");
    expect(stderr).toContain("Injecting anyway");
    expect(stdout).not.toContain("LD_PRELOAD is a known");
    expect(status).toBe(0);
  });

  test("blocks a dangerous target variable name for a third-party (named, non-primary) stash", async () => {
    const primaryStashDir = makeStash();
    const vendorStashDir = makeStash();
    setSecret(path.join(vendorStashDir, "secrets", "demo"), Buffer.from("v"));
    writeSandboxConfig({ bundles: { vendor: { path: vendorStashDir } } });

    const { status, stderr } = await runCli(["secret", "run", "vendor//secrets/demo", "LD_PRELOAD", "--", "true"], {
      AKM_BUNDLE_DIR: primaryStashDir,
    });

    expect(status).toBe(2);
    expect(JSON.parse(stderr.trim()).error).toContain("Refusing to inject a secret from a third-party stash");
    expect(JSON.parse(stderr.trim()).error).toContain("LD_PRELOAD");
  });

  test("rejects an invalid env var name", async () => {
    const stashDir = makeStash();
    setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("v"));
    const { status } = await runCli(["secret", "run", "secrets/demo", "not a var", "--", "true"], {
      AKM_BUNDLE_DIR: stashDir,
    });
    expect(status).toBe(2);
  });

  test("errors when no command is supplied after --", async () => {
    const stashDir = makeStash();
    setSecret(path.join(stashDir, "secrets", "demo"), Buffer.from("v"));
    const { status } = await runCli(["secret", "run", "secrets/demo", "TOKEN"], { AKM_BUNDLE_DIR: stashDir });
    expect(status).toBe(2);
  });
});
