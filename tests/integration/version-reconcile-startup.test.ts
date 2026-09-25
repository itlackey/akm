// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// INTEGRATION (real subprocess required): spawns `bun src/cli.ts` as a real
// child process, per AGENTS.md's classification rule.

/**
 * Ungated end-to-end acceptance for startup reconciliation (upgrade-B r2-3).
 * `tests/core/version-reconcile.test.ts` injects `runTool` and
 * `tests/cli/should-reconcile-on-startup.test.ts` covers the predicate only
 * — neither exercises the real `src/cli.ts` hook, the real `akm-migrate`
 * child process, or a real crontab. The only prior end-to-end coverage is
 * the upgrade rehearsal, gated behind `AKM_UPGRADE_REHEARSAL=1`.
 *
 * Scenario: a crontab row for an ungranted task in an enabled bundle (the
 * shape `akm task sync` wrote before host-local scheduler-grant tracking
 * existed on this host), plus a version-4 task file carrying the retired
 * `schedule[].enabled` marker. A single ordinary command
 * (`akm search x`) must reconcile host-local state ahead of itself: the
 * grant lands back in `config.json`, the task file is untouched byte for
 * byte (host-local mode never rewrites bundle content), and the version
 * stamp names the running version. A second invocation must not reconcile
 * again.
 */

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../_helpers/sandbox";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(argv: string[], env: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
}

function expectSuccess(result: RunResult, label: string): void {
  expect(result.status, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

test("a crontab row for an ungranted task and a retired schedule[].enabled marker reconcile on the next command, once", () => {
  const sandbox = makeSandboxDir("akm-version-reconcile-startup");
  const id = `legacy-${process.pid}-${Date.now()}`;
  const fakeBin = path.join(sandbox.dir, "fake-bin");
  const fakeCrontab = path.join(sandbox.dir, "crontab");
  const home = path.join(sandbox.dir, "home");
  const configHome = path.join(sandbox.dir, "config");
  const dataHome = path.join(sandbox.dir, "data");
  const cacheHome = path.join(sandbox.dir, "cache");
  const stateHome = path.join(sandbox.dir, "state");
  const stashDir = path.join(sandbox.dir, "stash");

  for (const dir of [fakeBin, home, path.join(configHome, "akm"), dataHome, cacheHome, stateHome, stashDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Same fake crontab shim `tests/integration/linux-standalone-scheduler.test.ts`
  // uses: reads/writes `$FAKE_CRONTAB` instead of touching the real spool.
  fs.writeFileSync(
    path.join(fakeBin, "crontab"),
    [
      "#!/bin/sh",
      `if [ "\${1:-}" = "-l" ]; then`,
      '  if [ -f "$FAKE_CRONTAB" ]; then cat "$FAKE_CRONTAB"; exit 0; fi',
      '  echo "no crontab for sandbox" >&2',
      "  exit 1",
      "fi",
      `if [ "\${1:-}" = "-" ]; then cp /dev/stdin "$FAKE_CRONTAB"; exit 0; fi`,
      "exit 2",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(configHome, "akm", "config.json"),
    `${JSON.stringify({
      configVersion: "0.9.0",
      bundles: { stash: { path: stashDir } },
      defaultBundle: "stash",
      semanticSearchMode: "off",
    })}\n`,
    { mode: 0o600 },
  );

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["AKM_CONFIG_DIR", "AKM_DATA_DIR", "AKM_CACHE_DIR", "AKM_STATE_DIR"]) delete env[key];
  env.HOME = home;
  env.XDG_CONFIG_HOME = configHome;
  env.XDG_DATA_HOME = dataHome;
  env.XDG_CACHE_HOME = cacheHome;
  env.XDG_STATE_HOME = stateHome;
  env.AKM_BUNDLE_DIR = stashDir;
  env.FAKE_CRONTAB = fakeCrontab;
  // Prepend the fake crontab ahead of the real one; keep the rest of the
  // ambient PATH so `bun` itself still resolves (unlike the standalone
  // binary acceptance, this spawns `bun src/cli.ts` directly).
  env.PATH = [fakeBin, env.PATH ?? ""].join(path.delimiter);
  env.NO_COLOR = "1";

  try {
    const cli = path.resolve("src/cli.ts");
    const configPath = path.join(configHome, "akm", "config.json");
    const taskPath = path.join(stashDir, "tasks", `${id}.yml`);
    const stampPath = path.join(stateHome, "akm", "version-reconcile.json");
    const ref = `stash//tasks/${id}`;

    // Step 1: install a real task the ordinary way, so the crontab row and
    // config grant are byte-real, not hand-authored.
    const add = run(["bun", cli, "task", "add", id, "--schedule", "@daily", "--command", "/bin/echo legacy-task"], env);
    expectSuccess(add, "task add");

    const configAfterAdd = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      scheduler?: { enabled?: Array<{ kind: string; ref: string }> };
    };
    expect(configAfterAdd.scheduler?.enabled).toContainEqual(expect.objectContaining({ kind: "task", ref }));
    const crontabAfterAdd = fs.readFileSync(fakeCrontab, "utf8");
    expect(crontabAfterAdd).toContain(`# akm:task ${id} BEGIN`);

    // Step 2: rewrite the task file to the shape a pre-0.9.17 host could
    // have on disk — `schedule:` as a list, one entry still carrying the
    // retired `enabled` key (0.9.15's v4 grammar accepted it; this
    // release's parser strips it in memory and never rewrites the file).
    fs.writeFileSync(
      taskPath,
      'version: 4\nrun: /bin/echo legacy-task\nschedule:\n  - cron: "@daily"\n    enabled: true\n',
    );
    const expectedTaskBytes = fs.readFileSync(taskPath);

    // Step 3: strip the grant `task add` just wrote, so config.json is
    // back to the pre-grant-tracking shape — a crontab row the operator
    // installed, with no host-local record of it.
    const configBeforeStrip = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      scheduler: { enabled: Array<{ kind: string; ref: string }> };
    };
    configBeforeStrip.scheduler.enabled = configBeforeStrip.scheduler.enabled.filter((a) => a.ref !== ref);
    expect(configBeforeStrip.scheduler.enabled).not.toContainEqual(expect.objectContaining({ ref }));
    fs.writeFileSync(configPath, `${JSON.stringify(configBeforeStrip, null, 2)}\n`, { mode: 0o600 });

    // Step 4: `task add` itself already reconciled once for this fresh
    // state dir (nothing was pending at that point). Clear the stamp so
    // the test's own `akm search x` below is the first reconcile against
    // the ungranted row and the retired-marker task file — the scenario an
    // actual post-upgrade host is in.
    fs.rmSync(stampPath, { force: true });

    const pkgVersion = (JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as { version: string })
      .version;

    // Step 5: the hook under test.
    const first = run(["bun", cli, "search", "x"], env);
    expectSuccess(first, "akm search x (first, reconciling)");

    const configAfterReconcile = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      scheduler?: { enabled?: Array<{ kind: string; ref: string }> };
    };
    expect(configAfterReconcile.scheduler?.enabled).toContainEqual(expect.objectContaining({ kind: "task", ref }));

    expect(fs.readFileSync(taskPath)).toEqual(expectedTaskBytes);

    const stampAfterFirst = JSON.parse(fs.readFileSync(stampPath, "utf8")) as {
      version?: string;
      reconciledAt?: string;
    };
    expect(stampAfterFirst.version).toBe(pkgVersion);
    expect(typeof stampAfterFirst.reconciledAt).toBe("string");
    const reconciledAtFirst = stampAfterFirst.reconciledAt;
    const mtimeFirst = fs.statSync(stampPath).mtimeMs;

    // Step 6: a second invocation must not reconcile again — this is what
    // fails if the `if (shouldReconcileOnStartup(...)) await
    // runStartupReconciliation();` hook at src/cli.ts:1085 is removed (the
    // first assertions above would already fail that way too, but this
    // pins the "once per version" half of the contract independently).
    const second = run(["bun", cli, "search", "x"], env);
    expectSuccess(second, "akm search x (second, no-op)");
    const stampAfterSecond = JSON.parse(fs.readFileSync(stampPath, "utf8")) as { reconciledAt?: string };
    expect(stampAfterSecond.reconciledAt).toBe(reconciledAtFirst);
    expect(fs.statSync(stampPath).mtimeMs).toBe(mtimeFirst);
  } finally {
    sandbox.cleanup();
  }
}, 120_000);
