// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `experimental.*` retired-key shim.
 *
 * `ExperimentalConfigSchema` (`./schema/experimental.ts`) moved from
 * `.passthrough()` to `.strict()` in 0.9.16 (`cc6152e02`) so a typo in an
 * authority flag (e.g. `improveAutonomyy`) fails loudly instead of silently
 * doing nothing. `workflowEngine` was removed from that block earlier, in
 * `e0655d13c`, but 0.9.15's passthrough still accepted it — so a real config
 * written by 0.9.15 can carry `experimental.workflowEngine` and now fails
 * every command with `Invalid config: experimental: Unrecognized key(s)`.
 *
 * Per AGENTS.md "Reading persisted data": a reader tolerates what older
 * releases wrote, converts in memory, warns once, and leaves the on-disk
 * rewrite to `akm migrate apply`. This mirrors `./legacy-source-shape-shim.ts`
 * exactly — strip the retired key(s) before schema validation, warn once
 * naming the key and the migrate command — rather than reintroducing
 * `.passthrough()`, which would also let a live key typo through silently.
 */

import { isRecord } from "../common";
import { warnOnce } from "../warn";

/**
 * Every `experimental.*` key `ExperimentalConfigSchema` has ever retired.
 * `workflowEngine` (removed in `e0655d13c`) is the only one so far — kept as
 * a list because the shim and `akm migrate apply`
 * (`scripts/akm-migrate/migrate/config-retired-experimental-keys.ts`) share
 * it.
 */
export const RETIRED_EXPERIMENTAL_KEYS = ["workflowEngine"] as const;

/**
 * Which `RETIRED_EXPERIMENTAL_KEYS` are present in a raw config's
 * `experimental` section. Returns `[]` when `raw.experimental` is missing or
 * not a record. Shared by `stripRetiredExperimentalKeys` below and by
 * `akm migrate apply`'s on-disk counterpart
 * (`scripts/akm-migrate/migrate/config-retired-experimental-keys.ts`).
 */
export function retiredExperimentalKeysIn(raw: Record<string, unknown>): string[] {
  const experimental = raw.experimental;
  if (!isRecord(experimental)) return [];
  return RETIRED_EXPERIMENTAL_KEYS.filter((key) => key in experimental);
}

/**
 * Drop retired `experimental.*` keys from a raw parsed config object before
 * schema validation, warning once per source when any were present. Live
 * keys (including an unrecognized one, e.g. a typo) are left untouched for
 * `ExperimentalConfigSchema.strict()` to reject as before.
 */
export function stripRetiredExperimentalKeys(
  raw: Record<string, unknown>,
  sourcePath?: string,
): Record<string, unknown> {
  const present = retiredExperimentalKeysIn(raw);
  if (present.length === 0) return raw;
  const original = raw.experimental as Record<string, unknown>;

  const experimental = { ...original };
  for (const key of present) delete experimental[key];

  const where = sourcePath ? ` at ${sourcePath}` : "";
  warnOnce(
    `config:retired-experimental-key${sourcePath ? `:${sourcePath}` : ""}`,
    `Config${where} uses the retired experimental key(s) ${present.join(", ")} — ignored in memory. Run \`akm migrate apply\` to remove ${present.length === 1 ? "it" : "them"} from the config file and silence this warning.`,
  );

  return { ...raw, experimental };
}
