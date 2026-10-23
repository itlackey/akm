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
import { makeStashDir, type SandboxedDir, writeSandboxConfig } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterAll(() => {
  for (const d of disposers) d.cleanup();
  disposers.length = 0;
});

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
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
      AKM_BUNDLE_DIR: undefined,
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
      ["env", "run", "env/prod", "--", "bash", "-lc", 'printf \'%s %s\' "$FOO" "$BAR"'],
      { AKM_BUNDLE_DIR: stashDir },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("bar baz");
    expect(stderr.trim()).toBe("");
  });

  test("substitutes ${secrets/name} tokens with the secret value", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.mkdirSync(path.join(stashDir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "secrets", "my_api_token"), "s3cr3t", "utf8");
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=Bearer ${secrets/my_api_token}\n", "utf8");

    const { stdout, status } = spawnCli(["env", "run", "env/prod", "--", "bash", "-lc", "printf '%s' \"$API_KEY\""], {
      AKM_BUNDLE_DIR: stashDir,
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
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "PAIR=${secrets/a}:${secrets/b}\nKEEP=${HOME}\n", "utf8");

    const { stdout, status } = spawnCli(
      ["env", "run", "env/prod", "--", "bash", "-lc", 'printf \'%s|%s\' "$PAIR" "$KEEP"'],
      { AKM_BUNDLE_DIR: stashDir },
    );

    expect(status).toBe(0);
    // PAIR fully substituted; KEEP left as the literal token (no secret named HOME).
    expect(stdout.trim()).toBe("AAA:BBB|${HOME}");
  });

  test("reads a secret trimmed: a trailing newline never reaches the child", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.mkdirSync(path.join(stashDir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "secrets", "tok"), "  s3cr3t\n\n", "utf8");
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "API_KEY=${secrets/tok}\n", "utf8");

    const { stdout, status } = spawnCli(["env", "run", "env/prod", "--", "bash", "-lc", "printf '[%s]' \"$API_KEY\""], {
      AKM_BUNDLE_DIR: stashDir,
    });

    expect(status).toBe(0);
    expect(stdout).toBe("[s3cr3t]");
  });

  test("a secrets ref qualified with another bundle resolves there, and a script ref yields its path", () => {
    const primaryDir = makeStash();
    const teamDir = makeStash();
    fs.mkdirSync(path.join(primaryDir, "env"), { recursive: true });
    fs.mkdirSync(path.join(teamDir, "secrets"), { recursive: true });
    fs.mkdirSync(path.join(teamDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(teamDir, "secrets", "discord"), "from-team", "utf8");
    fs.writeFileSync(path.join(teamDir, "scripts", "fetch.sh"), "#!/bin/sh\n", "utf8");
    fs.writeFileSync(
      path.join(primaryDir, "env", "prod.env"),
      "TOKEN=${team//secrets/discord}\nTOOL=${team//scripts/fetch.sh}\n",
      "utf8",
    );
    writeSandboxConfig({ bundles: { team: { path: teamDir } } });

    const { stdout, status } = spawnCli(
      ["env", "run", "env/prod", "--", "bash", "-lc", 'printf \'%s|%s\' "$TOKEN" "$TOOL"'],
      { AKM_BUNDLE_DIR: primaryDir },
    );

    expect(status).toBe(0);
    expect(stdout).toBe(`from-team|${path.join(teamDir, "scripts", "fetch.sh")}`);
  });

  test("a bare name is a usage error naming the full ref", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=bar\n", "utf8");

    const { stderr, status } = spawnCli(["env", "run", "prod", "--", "true"], { AKM_BUNDLE_DIR: stashDir });

    expect(status).toBe(2);
    expect(JSON.parse(stderr.trim()).error).toContain("env/prod");
  });

  test("injects a hijack var from the primary stash with no block or warning (#1237)", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "danger.env"), "GIT_SSH_COMMAND=/evil\nFOO=ok\n", "utf8");

    const { stdout, stderr, status } = spawnCli(
      ["env", "run", "env/danger", "--", "bash", "-lc", 'printf \'%s|%s\' "$FOO" "$GIT_SSH_COMMAND"'],
      { AKM_BUNDLE_DIR: stashDir },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("ok|/evil");
    expect(stderr).not.toContain("process-hijacking");
  });

  test("injects a hijack var from a non-primary (installed) bundle with no block and no flag (#1237)", () => {
    const primaryDir = makeStash();
    const vendorDir = makeStash();
    fs.mkdirSync(path.join(vendorDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(vendorDir, "env", "danger.env"), "GIT_SSH_COMMAND=/vendor\n", "utf8");
    writeSandboxConfig({ bundles: { vendor: { path: vendorDir } } });

    const { stdout, stderr, status } = spawnCli(
      ["env", "run", "vendor//env/danger", "--", "bash", "-lc", 'printf "%s" "$GIT_SSH_COMMAND"'],
      { AKM_BUNDLE_DIR: primaryDir },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("/vendor");
    expect(stderr).not.toContain("Refusing to inject");
  });

  test("--allow-dangerous-env-keys is accepted as a deprecated no-op (#1237)", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "danger.env"), "GIT_SSH_COMMAND=/evil\n", "utf8");

    const { stdout, status } = spawnCli(
      ["env", "run", "env/danger", "--allow-dangerous-env-keys", "--", "bash", "-lc", 'printf "%s" "$GIT_SSH_COMMAND"'],
      { AKM_BUNDLE_DIR: stashDir },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("/evil");
  });

  test("--only injects just the named keys", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=foo\nBAR=bar\nBAZ=baz\n", "utf8");

    const { stdout, status } = spawnCli(
      ["env", "run", "env/prod", "--only", "FOO,BAZ", "--", "bash", "-lc", 'printf \'%s|%s|%s\' "$FOO" "$BAR" "$BAZ"'],
      { AKM_BUNDLE_DIR: stashDir },
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
      ["env", "run", "env/prod", "--except", "BAR", "--", "bash", "-lc", 'printf \'%s|%s\' "$FOO" "$BAR"'],
      { AKM_BUNDLE_DIR: stashDir },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("foo|");
  });

  test("--clean does not inherit unrelated parent env vars", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=foo\n", "utf8");

    const { stdout, status } = spawnCli(
      ["env", "run", "env/prod", "--clean", "--", "bash", "-lc", 'printf "%s|%s" "$FOO" "${PARENT_ONLY:-}"'],
      { AKM_BUNDLE_DIR: stashDir, PARENT_ONLY: "sentinel" },
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
        "env/prod",
        "--clean",
        "--inherit",
        "PARENT_ONLY",
        "--",
        "bash",
        "-lc",
        'printf "%s|%s" "$FOO" "${PARENT_ONLY:-}"',
      ],
      { AKM_BUNDLE_DIR: stashDir, PARENT_ONLY: "sentinel" },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("foo|sentinel");
  });

  // R-067 regression: `runEnvInjected` (src/commands/env/env-cli.ts) used to
  // `process.exit(result.status ?? 0)` unconditionally after the child ran —
  // including on success — which skips the `finally { await
  // disposeDispatchResources(); }` cleanup in src/cli.ts's `runCommand`. The
  // fix (`process.exitCode = result.status ?? 0; return;`) must still
  // propagate the child's exact exit status, non-zero included. Assert that
  // invariant end-to-end through a real subprocess.
  test("propagates a non-zero child exit code", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "env"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "env", "prod.env"), "FOO=foo\n", "utf8");

    const { status } = spawnCli(["env", "run", "env/prod", "--", "/bin/sh", "-c", "exit 3"], {
      AKM_BUNDLE_DIR: stashDir,
    });

    expect(status).toBe(3);
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
        "secrets/token",
        "API_TOKEN",
        "--clean",
        "--",
        "bash",
        "-lc",
        'printf "%s|%s" "$API_TOKEN" "${PARENT_ONLY:-}"',
      ],
      { AKM_BUNDLE_DIR: stashDir, PARENT_ONLY: "sentinel" },
    );

    expect(status).toBe(0);
    expect(stdout.trim()).toBe("sekret|");
  });

  // R-067 regression: `secretRunCommand`'s `run` (src/commands/env/secret-cli.ts)
  // used to `process.exit(result.status ?? 0)` unconditionally, skipping
  // src/cli.ts's `finally { await disposeDispatchResources(); }`. The fix
  // (`process.exitCode = result.status ?? 0; return;`) must still propagate
  // the child's exact exit status, non-zero included.
  test("propagates a non-zero child exit code", () => {
    const stashDir = makeStash();
    fs.mkdirSync(path.join(stashDir, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(stashDir, "secrets", "token"), "sekret", "utf8");

    const { status } = spawnCli(["secret", "run", "secrets/token", "API_TOKEN", "--", "/bin/sh", "-c", "exit 3"], {
      AKM_BUNDLE_DIR: stashDir,
    });

    expect(status).toBe(3);
  });
});
