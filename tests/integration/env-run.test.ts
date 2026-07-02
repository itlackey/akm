// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm env run` / `secret run` — REAL-SUBPROCESS integration tests.
 *
 * These tests MUST spawn a real CLI process: `env run` (and `secret run`)
 * spawn the target command with stdio inherited to the real file
 * descriptors, so the injected-env output belongs to the CHILD process, not
 * the CLI. The in-process console-capture harness cannot observe it — only a
 * real process boundary can. Moved here from tests/env-path-run.test.ts;
 * the in-process env path/export/error-path tests remain in the unit file.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeStashDir, type SandboxedDir } from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function makeStash(): string {
  const stash = makeStashDir();
  disposers.push(stash);
  return stash.dir;
}

function spawnCli(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: repoRoot,
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

describe("env run", () => {
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

  test("--clean does not inherit unrelated parent env vars", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=foo\n", "utf8");

    const { stdout, status } = spawnCli(
      ["env", "run", "env:prod", "--clean", "--", "bash", "-lc", 'printf "%s|%s" "$FOO" "${PARENT_ONLY:-}"'],
      { AKM_STASH_DIR: stashDir, PARENT_ONLY: "sentinel" },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("foo|");
  });

  test("--clean --inherit passes through selected parent env vars", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=foo\n", "utf8");

    const { stdout, status } = spawnCli(
      [
        "env",
        "run",
        "env:prod",
        "--clean",
        "--inherit",
        "PARENT_ONLY",
        "--",
        "bash",
        "-lc",
        'printf "%s|%s" "$FOO" "${PARENT_ONLY:-}"',
      ],
      { AKM_STASH_DIR: stashDir, PARENT_ONLY: "sentinel" },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("foo|sentinel");
  });
});

describe("secret run", () => {
  test("--clean does not inherit unrelated parent env vars", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "secrets", "token"), "sekret", "utf8");

    const { stdout, status } = spawnCli(
      [
        "secret",
        "run",
        "secret:token",
        "API_TOKEN",
        "--clean",
        "--",
        "bash",
        "-lc",
        'printf "%s|%s" "$API_TOKEN" "${PARENT_ONLY:-}"',
      ],
      { AKM_STASH_DIR: stashDir, PARENT_ONLY: "sentinel" },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("sekret|");
  });
});
