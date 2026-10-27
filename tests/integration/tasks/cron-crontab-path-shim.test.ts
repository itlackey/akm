// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #910: exercises the cron backend's REAL exec path (`defaultCronExec`,
 * which shells out via `node:child_process.spawnSync("crontab", ...)`) —
 * not the in-memory `CronExec` mock the rest of `tasks-cron-backend.test.ts`
 * injects. This is the only way to prove `spawnSync`'s ENOENT is actually
 * detected and distinguished from a fake `crontab` binary on PATH that
 * merely exits nonzero, so it belongs under `tests/integration/` per the
 * "spawns a real process" rule rather than
 * beside the mocked-exec cases.
 *
 * A REAL SUBPROCESS is required (not just a real `spawnSync` call in this
 * test's own process): Bun's `spawnSync` resolves a bare command name (no
 * `env` override) against the PATH captured at ITS OWN process start, not a
 * later mutation of `process.env.PATH` in the same process — mutating PATH
 * here and calling `CRON_BACKEND()` in-process would silently keep
 * resolving against this test runner's original PATH. So each case spawns a
 * small Bun child (mirroring `tests/integration/env/env-run.test.ts`'s
 * `spawnCli`) with `env.PATH` set at that child's own creation, exactly like
 * a container sets PATH before ever starting the `akm` process.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeSandboxDir } from "../../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cronBackendModule = path.join(repoRoot, "src", "tasks", "backends", "cron.ts");

/** A tiny Bun script that calls the real `CRON_BACKEND().list()` and reports the outcome as JSON. */
const PROBE_SCRIPT = `
import { CRON_BACKEND } from ${JSON.stringify(cronBackendModule)};
try {
  const backend = CRON_BACKEND({
    akmArgv: ["/usr/local/bin/akm"],
    logDir: "/tmp/akm-cron-shim-test/logs",
    fs: { ensureDir() {} },
    scheduledContext: {
      AKM_BUNDLE_DIR: "/srv/akm-stash",
      AKM_CONFIG_DIR: "/srv/akm-config",
      AKM_DATA_DIR: "/srv/akm-data",
      AKM_CACHE_DIR: "/srv/akm-cache",
      AKM_STATE_DIR: "/srv/akm-state",
    },
  });
  const result = backend.list();
  console.log(JSON.stringify({ ok: true, result }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err), hint: typeof err?.hint === "function" ? err.hint() : undefined }));
}
`;

function writeFakeCrontab(dir: string, script: string): void {
  fs.writeFileSync(path.join(dir, "crontab"), script, { mode: 0o755 });
}

/**
 * Run the probe script as a real Bun child process with PATH set at ITS OWN
 * startup. The child is launched via `process.execPath` (this test's own
 * absolute Bun binary), NOT the bare name "bun" — overriding the child's
 * `env.PATH` to the fake-crontab-only directory would otherwise make this
 * spawnSync unable to resolve "bun" itself.
 */
function runProbe(pathDir: string): { ok: boolean; result?: unknown; message?: string; hint?: string } {
  const probeDir = makeSandboxDir("akm-cron-probe");
  try {
    const scriptFile = path.join(probeDir.dir, "probe.ts");
    fs.writeFileSync(scriptFile, PROBE_SCRIPT, "utf8");
    const proc = spawnSync(process.execPath, [scriptFile], {
      encoding: "utf8",
      timeout: 15_000,
      cwd: repoRoot,
      env: { ...process.env, PATH: pathDir },
    });
    if (proc.error) throw proc.error;
    const stdout = proc.stdout?.trim();
    if (!stdout) {
      throw new Error(`probe produced no stdout (status=${proc.status}, stderr=${proc.stderr})`);
    }
    return JSON.parse(stdout);
  } finally {
    probeDir.cleanup();
  }
}

describe("cron backend — real crontab exec (#910)", () => {
  test("no crontab binary anywhere on PATH (ENOENT) reports a missing binary", () => {
    const empty = makeSandboxDir("akm-cron-empty-path");
    try {
      const outcome = runProbe(empty.dir);
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toMatch(/crontab.*binary was not found on PATH/i);
      expect(outcome.hint).toMatch(/install.*crontab.*binary|add one to PATH/i);
    } finally {
      empty.cleanup();
    }
  });

  test("a supercronic-style PATH shim that exits nonzero with empty output is an empty crontab, not an error", () => {
    const shimDir = makeSandboxDir("akm-cron-shim-path");
    // Mirrors OpenPalm's `/tmp/openpalm-bin/crontab`: present, executable,
    // but there is no real spool yet.
    writeFakeCrontab(shimDir.dir, "#!/bin/sh\nexit 1\n");
    try {
      const outcome = runProbe(shimDir.dir);
      expect(outcome).toEqual({ ok: true, result: [] });
    } finally {
      shimDir.cleanup();
    }
  });

  test("a crontab binary that is present but genuinely fails still errors without claiming it's missing", () => {
    const shimDir = makeSandboxDir("akm-cron-broken-path");
    // Nonempty stdout distinguishes this from the "empty crontab" shim case
    // above — this crontab clearly ran and reported a real failure.
    writeFakeCrontab(shimDir.dir, '#!/bin/sh\necho "permission denied"\nexit 2\n');
    try {
      const outcome = runProbe(shimDir.dir);
      expect(outcome.ok).toBe(false);
      expect(outcome.message).not.toMatch(/binary.*missing|was not found on PATH/i);
      expect(outcome.hint ?? "").not.toMatch(/install.*crontab.*binary|add one to PATH/i);
    } finally {
      shimDir.cleanup();
    }
  });
});
