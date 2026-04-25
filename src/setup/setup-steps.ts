/**
 * Composable runner abstraction for `akm setup`.
 *
 * The interactive wizard in `setup.ts` historically ran a fixed series of
 * step functions (`stepStashDir`, `stepOllama`, `stepLlm`, ...) inline.
 * This module formalizes that pattern so steps can be:
 *   - reused by `akm init` (non-interactive preset, see Finding 31),
 *   - tested in isolation by passing a stub `SetupContext`, and
 *   - extended by plugins without touching the wizard call site.
 *
 * Steps mutate state through `SetupContext.apply()`, which accumulates a
 * delta on top of the original config. `stepLlm` reading the embedding
 * endpoint that `stepSemanticSearch` produced is the canonical example of
 * why mutable accumulation is preferred over immutable returns.
 */

import type { AkmConfig } from "../core/config";

/**
 * Context handed to each `SetupStep.run()`. Steps read the in-progress
 * config via `ctx.config` and write changes via `ctx.apply()`.
 */
export interface SetupContext {
  /**
   * The current accumulated config. Always reflects every prior step's
   * `apply()` calls. Treated as read-only by callers.
   */
  readonly config: Readonly<AkmConfig>;

  /**
   * `true` when running in `akm init` mode (or any other unattended
   * caller). Steps that require user prompts should bail when this is set
   * unless they are explicitly marked `nonInteractive`.
   */
  readonly nonInteractive: boolean;

  /** Merge a partial delta into the accumulated config. */
  apply(delta: Partial<AkmConfig>): void;
}

/**
 * A single, composable step in the setup wizard.
 *
 * Steps are identified by `id` (stable, machine-readable) and `label`
 * (human-friendly). `nonInteractive` marks steps safe to run in
 * `akm init` mode; the runner skips interactive-only steps when
 * `ctx.nonInteractive` is set.
 */
export interface SetupStep<TResult = void> {
  readonly id: string;
  readonly label: string;
  /** When true, the step participates in non-interactive runs (akm init). */
  readonly nonInteractive?: boolean;
  run(ctx: SetupContext): Promise<TResult>;
}

/**
 * Build a fresh `SetupContext` over a starting config. The returned context
 * applies deltas in-place onto an internal accumulator and exposes the
 * latest snapshot via `ctx.config`.
 */
export function createSetupContext(initial: AkmConfig, options: { nonInteractive: boolean }): SetupContext {
  let acc: AkmConfig = { ...initial };
  return {
    get config() {
      return acc;
    },
    nonInteractive: options.nonInteractive,
    apply(delta) {
      acc = { ...acc, ...delta };
    },
  };
}

/**
 * Run a list of steps against a context. Steps marked interactive-only are
 * skipped when `ctx.nonInteractive` is true. Returns the final accumulated
 * config so callers can persist it without re-reading the context.
 */
export async function runSetupSteps(steps: SetupStep[], ctx: SetupContext): Promise<AkmConfig> {
  for (const step of steps) {
    if (ctx.nonInteractive && !step.nonInteractive) continue;
    await step.run(ctx);
  }
  return ctx.config;
}
