// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One generic retired-config-key read shim, driven by `RETIRED_CONFIG_KEYS`
 * (`./retired-keys.ts`).
 *
 * Generalized from the `experimental.*`-only `stripRetiredExperimentalKeys`
 * (formerly `./retired-experimental-keys-shim.ts`, folded into this file).
 * That shim existed because `ExperimentalConfigSchema` moved from
 * `.passthrough()` to `.strict()` in 0.9.16 (`cc6152e02`) with no list of
 * the keys earlier releases accepted under it — the retired
 * `experimental.workflowEngine` then failed every command for anyone whose
 * config still carried it. The same gap existed, unaddressed, for every
 * retired top-level key (`agent`, `llm`, `profiles`, ...): nothing stripped
 * them before validation, they only rode along inertly under the top-level
 * schema's own `.passthrough()`.
 *
 * Per AGENTS.md "Reading persisted data": a reader tolerates what older
 * releases wrote, converts in memory, warns once, and leaves the on-disk
 * rewrite to `akm migrate apply`. This drops every registered `"ignored"`
 * path before schema validation, warning once per source naming every key
 * found and the migrate command — rather than leaving each object to its
 * own `.passthrough()`, which would also let a live key typo through
 * silently once that object goes `.strict()`.
 *
 * `retiredConfigKeysIn`/`withoutRetiredConfigKeys` are the shared path
 * walker: `stripRetiredConfigKeys` (below) uses them for the in-memory
 * shim, and `scripts/akm-migrate/migrate/config-retired-keys.ts` reuses the
 * same two functions for the on-disk `akm migrate apply` rewrite, so there
 * is exactly one implementation of "find/remove a registered retired path"
 * shared by both.
 */

import { isRecord } from "../common";
import { warnOnce } from "../warn";
import { RETIRED_CONFIG_KEYS } from "./retired-keys";

/** Does `raw` carry a value (including `undefined`-valued, via `in`) at this dotted path? */
function retiredKeyPresent(raw: Record<string, unknown>, segments: readonly string[]): boolean {
  let cursor: unknown = raw;
  for (const segment of segments) {
    if (!isRecord(cursor) || !(segment in cursor)) return false;
    cursor = cursor[segment];
  }
  return true;
}

/** Return a copy of `raw` with the dotted path removed, rebuilding only the touched branch. */
function withoutRetiredKey(raw: Record<string, unknown>, segments: readonly string[]): Record<string, unknown> {
  const [head, ...rest] = segments;
  if (head === undefined) return raw;
  if (rest.length === 0) {
    const { [head]: _dropped, ...remainder } = raw;
    return remainder;
  }
  const child = raw[head];
  if (!isRecord(child)) return raw;
  return { ...raw, [head]: withoutRetiredKey(child, rest) };
}

/** Registered `"ignored"` `RETIRED_CONFIG_KEYS` dotted paths present in a raw parsed config object. */
export function retiredConfigKeysIn(raw: Record<string, unknown>): string[] {
  return RETIRED_CONFIG_KEYS.filter(
    (entry) => entry.disposition === "ignored" && retiredKeyPresent(raw, entry.path.split(".")),
  ).map((entry) => entry.path);
}

/** Return a copy of `raw` with every dotted path in `paths` removed. */
export function withoutRetiredConfigKeys(
  raw: Record<string, unknown>,
  paths: readonly string[],
): Record<string, unknown> {
  let result = raw;
  for (const path of paths) {
    result = withoutRetiredKey(result, path.split("."));
  }
  return result;
}

/**
 * Drop every registered `"ignored"` `RETIRED_CONFIG_KEYS` path present in a
 * raw parsed config object before schema validation, warning once per
 * source naming all of them together. `"lifted"` entries are left
 * untouched here — `liftLegacyEngineExtraParams` (`../extra-params.ts`)
 * already moved their value onto a first-class field earlier in
 * `runConfigFilePipeline`. A live, unregistered key (including a typo) is
 * left for the object's own schema to reject as before.
 */
export function stripRetiredConfigKeys(raw: Record<string, unknown>, sourcePath?: string): Record<string, unknown> {
  const present = retiredConfigKeysIn(raw);
  if (present.length === 0) return raw;

  const result = withoutRetiredConfigKeys(raw, present);

  const where = sourcePath ? ` at ${sourcePath}` : "";
  warnOnce(
    `config:retired-keys:${sourcePath ?? "inline"}`,
    `Config${where} uses the retired config key(s) ${present.join(", ")} — ignored in memory. Run \`akm migrate apply\` to remove ${present.length === 1 ? "it" : "them"} from the config file and silence this warning.`,
  );

  return result;
}
