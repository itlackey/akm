// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `scheduler-binary` advisory for `akm health` (#953).
 *
 * `akm doctor scheduler sync` records an absolute akm invocation path in the one OS
 * scheduler entry (`src/tasks/resolve-akm-bin.ts`) because cron/launchd/schtasks
 * all run jobs with a minimal PATH. A field report showed that path going
 * stale after upgrading akm through a different installer than the one
 * active at the last `doctor scheduler sync` (e.g. npm-global to a standalone binary):
 * the schedule kept invoking a version behind, with nothing in `akm health`
 * surfacing it, until an unrelated failure (a rejected `${ref}` engine
 * key on the stale binary) surfaced the drift.
 *
 * Modelled 1:1 on `version-drift.ts`'s shape: an injectable seam,
 * best-effort, `--probe`-gated so an air-gapped host's `--no-probe` habit
 * suppresses this too, and `unknown` on any uncertainty rather than a false
 * `pass`/`warn`. Reads the scheduler's recorded binding via
 * `SchedulerBackend.inspect()` — the same reader `akm task doctor` uses — never
 * a second crontab/launchd/schtasks text parser.
 */

import { spawnSync } from "node:child_process";
import { selectBackend } from "../../tasks/backends";
import type { SchedulerBackend } from "../../tasks/backends/types";
import { movedLocations } from "../../tasks/installation";
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
  /** The environment the installation is judged by. */
  env?: NodeJS.ProcessEnv;
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

  // An installation that moves its locations has no entry of its own in the OS scheduler (its supervisor runs
  // `akm task dispatch`), and the entry there belongs to the default installation: nothing to compare.
  if (movedLocations(deps.env ?? process.env).length > 0) {
    return {
      name: "scheduler-binary",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "This installation does not own the OS scheduler entry.",
    };
  }
  let installed: Awaited<ReturnType<SchedulerBackend["inspect"]>>;
  try {
    installed = await (deps.backend ?? selectBackend()).inspect();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      name: "scheduler-binary",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      // A host without the scheduler's own binary (no crontab) runs no scheduled task: nothing is drifting there.
      message: /not found on PATH/.test(detail)
        ? `No scheduler is available on this host (${detail}), so no scheduled task is installed or runs here.`
        : `The scheduler entry could not be inspected: ${detail}`,
    };
  }
  const [binaryPath, ...leadingArgs] = installed.entry?.launcher ?? [];
  if (!installed.entry || !binaryPath) {
    return {
      name: "scheduler-binary",
      kind: "deterministic",
      status: "unknown",
      confidence: "high",
      message: "No scheduler entry is installed.",
    };
  }
  const binding = installed.entry.launcher;

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
      message: "The scheduler entry's akm binary could not be executed.",
      evidence: { binding },
    };
  }

  if (scheduledVersion === cliVersion) {
    return {
      name: "scheduler-binary",
      kind: "deterministic",
      status: "pass",
      confidence: "high",
      message: `The scheduler entry is bound to akm v${scheduledVersion}, matching the running CLI.`,
      evidence: { binding, scheduledVersion, cliVersion },
    };
  }

  return {
    name: "scheduler-binary",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message: `The scheduler entry is bound to akm v${scheduledVersion}, but the running CLI is v${cliVersion} — run \`akm doctor scheduler sync --rebind\` to rebind it.`,
    evidence: { binding, scheduledVersion, cliVersion },
  };
}
