// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The single inventory of retired config-schema surface: every config key
 * akm has ever stopped reading, and every config object that tightened from
 * open (`.passthrough()`) to closed (`.strict()`).
 *
 * Before this file, the same knowledge was split across three places that
 * could each drift independently: `RETIRED_TOP_LEVEL_CONFIG_KEYS`
 * (`./config.ts`), `RETIRED_EXPERIMENTAL_KEYS`
 * (`./retired-experimental-keys-shim.ts`), and the `extraParams` lift table
 * (`../extra-params.ts`). `experimental.workflowEngine` shipped without an
 * entry anywhere — `ExperimentalConfigSchema` going `.strict()` in 0.9.16
 * (`cc6152e02`) then failed every command for anyone whose 0.9.15-written
 * config still carried it, until `./retired-experimental-keys-shim.ts` was
 * added after the outage.
 *
 * `./config.ts` (`stripRetiredConfigKeys`, `warnUnknownTopLevelConfigKeys`)
 * and `../../../scripts/akm-migrate/migrate/config-retired-experimental-keys.ts`
 * read `RETIRED_CONFIG_KEYS` instead of keeping their own lists.
 * `../../../scripts/lint-config-schema-compat.ts` reads both arrays to tell
 * an intentional retirement from an accidental schema regression.
 */

/**
 * `"ignored"` — the key is dropped in memory before validation; nothing
 * reads its value. `"lifted"` — the key's value is moved onto a first-class
 * field instead of being dropped (the `extraParams` entries below); the
 * move itself is `liftLegacyEngineExtraParams` (`../extra-params.ts`), not
 * `stripRetiredConfigKeys` — a `"lifted"` entry here is read-only
 * documentation for the schema-compat lint, never stripped by the shim.
 */
export type RetiredConfigKeyDisposition = "ignored" | "lifted";

export interface RetiredConfigKey {
  /** Dotted path from the config root, e.g. `"agent"` or `"experimental.workflowEngine"`. */
  readonly path: string;
  /** First akm version this path stopped being read. */
  readonly since: string;
  readonly disposition: RetiredConfigKeyDisposition;
}

export const RETIRED_CONFIG_KEYS: readonly RetiredConfigKey[] = [
  // The pre-bundles flat vocabulary, retired wholesale by the 0.9.0 config
  // schema rewrite (bundles/defaultBundle superseded all of it). Moved here
  // from `RETIRED_TOP_LEVEL_CONFIG_KEYS` (`./config.ts`).
  { path: "agent", since: "0.9.0", disposition: "ignored" },
  { path: "bindings", since: "0.9.0", disposition: "ignored" },
  { path: "features", since: "0.9.0", disposition: "ignored" },
  { path: "installed", since: "0.9.0", disposition: "ignored" },
  { path: "llm", since: "0.9.0", disposition: "ignored" },
  { path: "modelAliases", since: "0.9.0", disposition: "ignored" },
  { path: "profiles", since: "0.9.0", disposition: "ignored" },
  { path: "sources", since: "0.9.0", disposition: "ignored" },
  { path: "stashDir", since: "0.9.0", disposition: "ignored" },
  { path: "stashes", since: "0.9.0", disposition: "ignored" },
  { path: "writable", since: "0.9.0", disposition: "ignored" },
  // Removed from `ExperimentalConfigSchema` in `e0655d13c`, before that
  // schema went `.strict()` — a config a pre-0.9.1 release wrote can still
  // carry it. Moved here from `RETIRED_EXPERIMENTAL_KEYS`
  // (`./retired-experimental-keys-shim.ts`).
  { path: "experimental.workflowEngine", since: "0.9.1", disposition: "ignored" },
  // `extraParams` keys `liftLegacyEngineExtraParams` (`../extra-params.ts`,
  // `LIFTABLE_EXTRA_PARAMS_KEYS`) moves onto a first-class engine field
  // instead of dropping (#852). Listed here — `path` uses `*` for "any
  // engine name" — so the schema-compat lint knows these were a deliberate
  // retirement, not a regression; the lift itself stays in `extra-params.ts`
  // and is not re-implemented by `stripRetiredConfigKeys`.
  { path: "engines.*.extraParams.temperature", since: "0.9.2", disposition: "lifted" },
  { path: "engines.*.extraParams.maxtokens", since: "0.9.2", disposition: "lifted" },
  { path: "engines.*.extraParams.enablethinking", since: "0.9.2", disposition: "lifted" },
  { path: "engines.*.extraParams.reasoningeffort", since: "0.9.2", disposition: "lifted" },
];

export interface StrictenedConfigObject {
  /** Dotted path from the config root; an array item schema ends in `"[]"`. */
  readonly path: string;
  /** First akm version this object's `additionalProperties` became `false`. */
  readonly since: string;
}

/**
 * Every config object that turned from open (no `additionalProperties`, or
 * `.passthrough()`) to closed (`.strict()`). Verified by diffing
 * `git show v0.9.15:schemas/akm-config.json` against HEAD's: both below
 * went `.passthrough()` -> `.strict()` in the same commit, `cc6152e02`
 * (0.9.16, "fix: align bundle and execution trust boundaries").
 * `execution` is also `.strict()` as of that commit but is a brand-new
 * schema module added in it (26 insertions, no prior version) — it never
 * had an open shape to regress from, so it is not listed here; the
 * schema-compat lint only flags a path that existed with a looser
 * `additionalProperties` in the previous schema. `scheduler` and
 * `scheduler.enabled[]` are absent from v0.9.15's schema entirely (zero
 * occurrences of "scheduler") — they were born `.strict()` in the same
 * commit and are excluded here for the identical reason as `execution`.
 * `improve-processes.ts`'s two `.strict()` calls predate 0.9.15 (0.9.2,
 * `5608efbd1`/`9992446d5`) and are already reflected in the baseline the
 * lint compares against, so they need no entry either.
 */
export const STRICTENED_CONFIG_OBJECTS: readonly StrictenedConfigObject[] = [
  { path: "experimental", since: "0.9.16" },
  { path: "search.curateRerank", since: "0.9.16" },
];
