// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The model aliases akm itself speaks: a call asks for a model by one of these
 * (or by an exact name), and each connection or harness says which of its own
 * models answers to them.
 */
export const STANDARD_ALIASES = ["fast", "balanced", "reasoning"] as const;

export type StandardAlias = (typeof STANDARD_ALIASES)[number];

/**
 * The alias each kind of call asks for when nothing nearer (an asset, a process,
 * a flag) names a model. It is the farthest layer of the call.
 */
export const SHIPPED_ALIAS = {
  /** Improve's passes: reflect, distill, consolidate, memory inference, validation. */
  improve: "fast",
  /** Judges: the reflect and distill quality gates, the triage judgment, a workflow gate. */
  judge: "balanced",
  /** Agent work: `akm agent`, `command run`, `proposal new`, task dispatch, workflow agent units. */
  agent: "balanced",
  extract: "fast",
  enrich: "fast",
  /** The index passes. */
  index: "fast",
} as const satisfies Record<string, StandardAlias>;

/** One model answering to every standard alias: what a connection with a single model has. */
export function modelForEveryAlias(model: string): Record<StandardAlias, string> {
  return { fast: model, balanced: model, reasoning: model };
}
