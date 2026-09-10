// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `scheduler-binary` advisory for `akm health` (#953).
 *
 * `akm task sync` records an absolute akm invocation path in the OS
 * scheduler (`src/tasks/resolve-akm-bin.ts`) because cron/launchd/schtasks
 * all run jobs with a minimal PATH. A field report showed that path going
 * stale after upgrading akm through a different installer than the one
 * active at the last `task sync` (e.g. npm-global to a standalone binary):
 * the schedule kept invoking a version behind, with nothing in `akm health`
 * surfacing it, until an unrelated failure (a rejected `secret://` engine
 * key on the stale binary) surfaced the drift.
 *
 * Modelled 1:1 on `version-drift.ts`'s shape: an injectable seam,
 * best-effort, `--probe`-gated so an air-gapped host's `--no-probe` habit
 * suppresses this too, and `unknown` on any uncertainty rather than a false
 * `pass`/`warn`. Reads the scheduler's recorded binding via
 * `SchedulerBackend.list()` — the same reader `akm task doctor` uses — never
 * a second crontab/launchd/schtasks text parser.
 */

import { spawnSync } from "node:child_process";
import { selectBackend } from "../../tasks/backends";
import type { SchedulerBackend } from "../../tasks/backends/types";
import { pkgVersion } from "../../version";
import type { HealthCheckResult } from "./types";

/**
 * Bound on the scheduler-recorded binary's `--version` probe. Matches the
 * `--version` timeout the engine-reachability checks already use
 * (checks.ts's `runConfiguredEngineProbe`), so a wedged or missing binary
 * degrades this advisory to `unknown` in seconds rather than blocking
 * `akm health --probe`.
 */
const SCHEDULER_BINARY_VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Options for {@link collectSchedulerBinaryAdvisory}. */
export interface SchedulerBinaryDriftDependencies {
  /** Injectable scheduler backend; defaults to the real platform backend. */
  backend?: SchedulerBackend;
  /** Injectable process runner for the `--version` probe. */
  spawnSync?: typeof spawnSync;
  /** The running akm-cli version to compare against. Defaults to {@link pkgVersion}. */
  cliVersion?: string;
}

/**
 * Build the `scheduler-binary` advisory. `probe` mirrors the
 * engine-reachability and `cli-version` checks' `--probe`/`--no-probe`
 * gating: only inspects the scheduler and spawns a process when `true`;
 * otherwise `unknown` with "not probed", never touching the OS scheduler.
 */
export async function collectSchedulerBinaryAdvisory(
  probe: boolean,
  deps: SchedulerBinaryDriftDependencies = {},
): Promise<HealthCheckResult> {
  const cliVersion = deps.cliVersion ?? pkgVersion;
  if (!probe) {
    return {
      name: "scheduler-binary",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "Scheduler binary version drift was not probed.",
    };
  }

  let installed: Awaited<ReturnType<SchedulerBackend["list"]>>;
  try {
    installed = await (deps.backend ?? selectBackend()).list();
  } catch (error) {
    return {
      name: "scheduler-binary",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: `Installed scheduled tasks could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // task sync rewrites every installed binding to the same current
  // invocation atomically, so the first entry's binding represents the
  // whole schedule under normal operation.
  const [firstInstalled] = installed;
  const [binaryPath, ...leadingArgs] = firstInstalled?.binding ?? [];
  if (!firstInstalled || !binaryPath) {
    return {
      name: "scheduler-binary",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "No scheduled task is installed.",
    };
  }
  const binding = firstInstalled.binding;

  const run = deps.spawnSync ?? spawnSync;
  let scheduledVersion: string | undefined;
  try {
    const result = run(binaryPath, [...leadingArgs, "--version"], {
      encoding: "utf8",
      timeout: SCHEDULER_BINARY_VERSION_PROBE_TIMEOUT_MS,
    });
    if ((result.status ?? 1) === 0) scheduledVersion = result.stdout?.trim() || undefined;
  } catch {
    scheduledVersion = undefined;
  }

  if (!scheduledVersion) {
    return {
      name: "scheduler-binary",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "The scheduler's recorded akm binary could not be executed.",
      evidence: { binding },
    };
  }

  if (scheduledVersion === cliVersion) {
    return {
      name: "scheduler-binary",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: `Scheduled tasks are bound to akm v${scheduledVersion}, matching the running CLI.`,
      evidence: { binding, scheduledVersion, cliVersion },
    };
  }

  return {
    name: "scheduler-binary",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message: `Scheduled tasks are bound to akm v${scheduledVersion}, but the running CLI is v${cliVersion} — run \`akm task sync\` to rebind the schedule.`,
    evidence: { binding, scheduledVersion, cliVersion },
  };
}
