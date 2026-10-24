// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Readers for the `experimental` config section (D8).
 *
 * These exist so no call site writes `config.experimental?.improveAutonomy ===
 * true` by hand. The distinction that matters is that **absent and `false` are
 * the same answer** — a half-written config, a config from an older version, or
 * a typo'd section must all read as OFF. A call site that reached for the raw
 * field could accidentally treat `undefined` as permissive; going through a
 * named predicate makes the safe default the only default.
 */

/**
 * The minimum shape these readers need. Deliberately NOT `Pick<AkmConfig,
 * "experimental">` — that makes the property required, which would force every
 * caller holding a partial config (tests, the strategy resolver) to supply it.
 */
export interface ExperimentalConfigHolder {
  experimental?: { improveAutonomy?: boolean | undefined } | undefined;
}

/**
 * True only when the user has explicitly opted into autonomous `akm improve`
 * mutation.
 *
 * Accepts a partial config so callers holding a plain object (tests, the
 * strategy resolver) do not need a fully-parsed one.
 */
export function isImproveAutonomyEnabled(config: ExperimentalConfigHolder | undefined): boolean {
  return config?.experimental?.improveAutonomy === true;
}

/**
 * The config key an operator sets to enable a gated lane.
 *
 * Named rather than inlined because it is user-facing text: it goes into the
 * `improve_skipped` event metadata, the `akm task doctor` output, and the
 * health advisory, and those three must name the same key as the schema.
 */
export const IMPROVE_AUTONOMY_CONFIG_KEY = "experimental.improveAutonomy";
