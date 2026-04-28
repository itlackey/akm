/**
 * Tests for the `akm distill --exclude-feedback-from` CLI flag (#267).
 *
 * The flag and the `AKM_DISTILL_EXCLUDE_FEEDBACK_FROM` env var both feed
 * the same `excludeFeedbackFromRefs` option on `akmDistill`. We exercise
 * the CLI dispatcher as a real subprocess so flag parsing + validation
 * runs end-to-end, including the UsageError → exit 2 contract for invalid
 * refs.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

function makeTempDir(prefix = "akm-distill-cli-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function runCli(
  args: string[],
  options?: { env?: Record<string, string | undefined> },
): { stdout: string; stderr: string; status: number } {
  const xdgCache = makeTempDir("akm-distill-cli-cache-");
  const xdgConfig = makeTempDir("akm-distill-cli-config-");
  const home = makeTempDir("akm-distill-cli-home-");
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
    env: {
      ...process.env,
      AKM_STASH_DIR: undefined,
      HOME: home,
      XDG_CACHE_HOME: xdgCache,
      XDG_CONFIG_HOME: xdgConfig,
      ...options?.env,
    },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

describe("akm distill --exclude-feedback-from flag (#267)", () => {
  test("invalid ref in --exclude-feedback-from → exits 2 (USAGE)", () => {
    const result = runCli(["distill", "skill:foo", "--exclude-feedback-from", "not-a-ref"]);
    expect(result.status).toBe(2);
    // Error envelope is JSON on stderr.
    expect(result.stderr).toContain("Invalid --exclude-feedback-from ref");
    expect(result.stderr).toContain("not-a-ref");
  });

  test("invalid ref in env var fallback → also exits 2", () => {
    const result = runCli(["distill", "skill:foo"], {
      env: { AKM_DISTILL_EXCLUDE_FEEDBACK_FROM: "this-is-not-a-ref" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid --exclude-feedback-from ref");
  });

  test("multiple invalid refs surface the first failure", () => {
    const result = runCli(["distill", "skill:foo", "--exclude-feedback-from", "skill:ok,bad-ref,memory:also-ok"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("bad-ref");
  });

  test("valid CSV refs parse without flag-parse panic (smoke)", () => {
    // The command will likely fail downstream because no llm config exists
    // and no asset is indexed, but flag parsing must not be the failure
    // mode — assert exit != 2 (anything but USAGE), or accept 0/1.
    const result = runCli(["distill", "skill:foo", "--exclude-feedback-from", "skill:bar,memory:baz"]);
    expect(result.status).not.toBe(2);
  });

  test("env var with valid CSV parses without crash", () => {
    const result = runCli(["distill", "skill:foo"], {
      env: { AKM_DISTILL_EXCLUDE_FEEDBACK_FROM: "skill:a,memory:b" },
    });
    expect(result.status).not.toBe(2);
  });

  test("origin-prefixed refs are accepted", () => {
    const result = runCli(["distill", "skill:foo", "--exclude-feedback-from", "team//skill:bar,npm:pkg//memory:baz"]);
    expect(result.status).not.toBe(2);
  });

  test("empty --exclude-feedback-from value is treated as no exclusion (no parse error)", () => {
    const result = runCli(["distill", "skill:foo", "--exclude-feedback-from", ""]);
    expect(result.status).not.toBe(2);
  });

  test("CLI flag takes precedence over env var (the flag is parsed regardless of env value)", () => {
    // If precedence were wrong, the invalid env var would surface first.
    // With correct precedence, the valid flag wins and no UsageError fires.
    const result = runCli(["distill", "skill:foo", "--exclude-feedback-from", "skill:valid"], {
      env: { AKM_DISTILL_EXCLUDE_FEEDBACK_FROM: "this-would-be-invalid" },
    });
    expect(result.status).not.toBe(2);
  });
});
