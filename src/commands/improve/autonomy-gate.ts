// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm improve` autonomy gate (D8).
 *
 * `akm improve` stays ON by default. What this gates is **autonomy** — the lanes
 * that mutate a user's assets without review. A blanket experimental gate on the
 * whole feature was rejected because it would have turned installed schedules
 * into no-ops and removed the only normal producer of memory inference; gating
 * the autonomy resolves that without removing the feature.
 *
 * Three lanes are gated. `triagePromote` is gated only when the triage stage has
 * its judgment tier on (#1143): a deterministic-only promote (`proposal drain
 * --promote` without judgment) runs without the opt-in, because only the
 * judged drain caused harm (#1132). `sync.push` deliberately is NOT: it publishes
 * already-committed content to a remote the user configured for that purpose and
 * has its own `sync.push: false` / `--no-push` controls.
 *
 * Two lanes are reachable through the strategy config, so the gate downgrades
 * that config in one place ({@link applyAutonomyGate}) rather than scattering
 * checks through the run. Memory cleanup bypasses the plan entirely, so it asks
 * {@link isAutonomyLaneAllowed} directly at its call site.
 *
 * **A gated lane must never become a silent no-op.** That is the whole design
 * constraint: `applyAutonomyGate` returns every downgrade it made so the caller
 * can emit an `improve_skipped` event naming the lane and the config key, and so
 * `akm task doctor` and the health advisory can report it. Whatever a user would
 * have seen happen, they now see explained.
 */

import type { ImproveProfileConfig } from "../../core/config/config";
import {
  type ExperimentalConfigHolder,
  IMPROVE_AUTONOMY_CONFIG_KEY,
  isImproveAutonomyEnabled,
} from "../../core/config/experimental";

/** The lanes `experimental.improveAutonomy` gates. */
export const AUTONOMY_LANES = ["memoryInference", "triagePromote", "memoryCleanup"] as const;

export type AutonomyLane = (typeof AUTONOMY_LANES)[number];

/** One downgrade the gate applied, in the form the skip event needs. */
export interface GatedLane {
  lane: AutonomyLane;
  /** The config key that would enable it — user-facing, so it comes from one constant. */
  configKey: string;
  /** Why it was skipped, phrased for an operator reading `tasks doctor`. */
  reason: string;
}

const LANE_REASONS: Record<AutonomyLane, string> = {
  memoryInference: "writes derived memory children and rewrites parent frontmatter",
  triagePromote: "auto-accepts queued proposals the triage judgment tier approves (downgraded to queue)",
  memoryCleanup: "rewrites belief-state frontmatter and moves files into the cleanup archive",
};

/**
 * The lanes that bypass the strategy config and ask the gate at their own call
 * site. They have no `processes.<name>.enabled` flag to downgrade, so
 * {@link applyAutonomyGate} cannot see them — anything reporting the full gated
 * set has to add these.
 */
export const DIRECT_AUTONOMY_LANES = ["memoryCleanup"] as const;

function gatedLane(lane: AutonomyLane): GatedLane {
  return { lane, configKey: IMPROVE_AUTONOMY_CONFIG_KEY, reason: LANE_REASONS[lane] };
}

/**
 * Describe lanes for reporting — the warning line, the `improve_skipped` event,
 * and `akm task doctor` all render the same {@link GatedLane} shape, so the
 * lane name, config key, and reason cannot drift between the three surfaces.
 */
export function describeGatedLanes(lanes: readonly AutonomyLane[]): GatedLane[] {
  return lanes.map(gatedLane);
}

/** Configured capabilities that tasks doctor reports behind the autonomy gate. */
export function configuredDirectAutonomyLanes(): AutonomyLane[] {
  return [...DIRECT_AUTONOMY_LANES];
}

/**
 * True when a lane may mutate. Used by the lane that bypasses the strategy
 * config; the other three are handled by {@link applyAutonomyGate}.
 */
export function isAutonomyLaneAllowed(_lane: AutonomyLane, config: ExperimentalConfigHolder | undefined): boolean {
  // Every lane shares one opt-in today. The parameter is kept so a call site
  // names the lane it is asking about — that name is what reaches the operator
  // in the skip event — and so a future per-lane split does not have to revisit
  // every caller.
  return isImproveAutonomyEnabled(config);
}

/**
 * Downgrade a strategy config to review-first unless autonomy is opted into.
 *
 * Returns the config to actually run plus every downgrade made. With autonomy on
 * the input is returned untouched and `gated` is empty.
 */
export function applyAutonomyGate(
  strategy: ImproveProfileConfig,
  config: ExperimentalConfigHolder | undefined,
): { config: ImproveProfileConfig; gated: GatedLane[] } {
  if (isImproveAutonomyEnabled(config)) return { config: strategy, gated: [] };

  const gated: GatedLane[] = [];
  const processes = { ...(strategy.processes ?? {}) };

  if (processes.memoryInference?.enabled === true) {
    processes.memoryInference = { ...processes.memoryInference, enabled: false };
    gated.push(gatedLane("memoryInference"));
  }
  // Triage stays ENABLED — queued proposals are still triaged, they just are not
  // auto-accepted. Disabling it would remove review work the user asked for,
  // which is the opposite of what a review-first default should do. Only a
  // promote that runs the judgment tier is gated (#1143); a deterministic-only
  // promote is the default and needs no opt-in.
  if (processes.triage?.applyMode === "promote" && processes.triage.judgment?.enabled === true) {
    processes.triage = { ...processes.triage, applyMode: "queue" };
    gated.push(gatedLane("triagePromote"));
  }

  return { config: { ...strategy, processes }, gated };
}
