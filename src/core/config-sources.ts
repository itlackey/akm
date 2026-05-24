// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Runtime helpers that derive {@link ConfiguredSource} values from the
 * persisted {@link SourceConfigEntry} / {@link InstalledStashEntry} shapes
 * in an {@link AkmConfig}.
 */
import { createHash } from "node:crypto";
import type { AkmConfig, ConfiguredSource, SourceConfigEntry, SourceSpec } from "./config-types";

/**
 * Synthesize a stable identifier when a {@link SourceConfigEntry} omits its
 * `name`. Uses a short hash of the discriminating fields so two equivalent
 * entries collapse to the same generated name.
 */
function deriveStashEntryName(entry: SourceConfigEntry): string {
  if (entry.name) return entry.name;
  const seed = JSON.stringify({
    type: entry.type,
    path: entry.path ?? null,
    url: entry.url ?? null,
  });
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `${entry.type}-${hash}`;
}

/**
 * Convert a persisted {@link SourceConfigEntry} into the runtime
 * {@link SourceSpec} discriminated union. Returns `undefined` when the entry
 * is missing the fields its provider type requires (e.g. a `filesystem`
 * entry with no `path`); callers should drop or warn for those.
 */
export function parseSourceSpec(entry: SourceConfigEntry): SourceSpec | undefined {
  switch (entry.type) {
    case "filesystem":
      return entry.path ? { type: "filesystem", path: entry.path } : undefined;
    case "git":
      return entry.url ? { type: "git", url: entry.url } : undefined;
    case "website":
      return entry.url
        ? {
            type: "website",
            url: entry.url,
            ...(typeof entry.options?.maxPages === "number" ? { maxPages: entry.options.maxPages as number } : {}),
          }
        : undefined;
    case "npm":
      return entry.path ? { type: "npm", package: entry.path } : undefined;
    default:
      // Unknown provider — best-effort fallback so callers still get something.
      return entry.path ? { type: "filesystem", path: entry.path } : undefined;
  }
}

/**
 * Build the full ordered list of runtime {@link ConfiguredSource} values from
 * a loaded {@link AkmConfig}:
 *   1. The entry marked `primary: true` (or a synthetic entry from `stashDir`).
 *   2. Remaining `sources[]` entries in declared order.
 *   3. Legacy `installed[]` entries, mapped into runtime entries.
 *
 * Entries with `enabled: false` are still emitted — callers decide whether to
 * honour the flag. Entries that fail {@link parseSourceSpec} drop silently.
 */
export function resolveConfiguredSources(config: AkmConfig): ConfiguredSource[] {
  const entries: ConfiguredSource[] = [];
  const sources = config.sources ?? [];

  let primary = sources.find((entry) => entry.primary === true);
  if (!primary && config.stashDir) {
    primary = { type: "filesystem", path: config.stashDir, primary: true };
  }
  if (primary) {
    const runtime = toConfiguredSource(primary, true);
    if (runtime) entries.push(runtime);
  }

  for (const entry of sources) {
    if (entry === primary) continue;
    const runtime = toConfiguredSource(entry, false);
    if (runtime) entries.push(runtime);
  }

  for (const installed of config.installed ?? []) {
    entries.push({
      name: installed.id,
      type: "filesystem",
      source: { type: "filesystem", path: installed.stashRoot },
      enabled: true,
      writable: installed.writable,
      ...(installed.wikiName ? { wikiName: installed.wikiName } : {}),
    });
  }

  return entries;
}

function toConfiguredSource(persisted: SourceConfigEntry, isPrimary: boolean): ConfiguredSource | undefined {
  const source = parseSourceSpec(persisted);
  if (!source) return undefined;
  return {
    name: deriveStashEntryName(persisted),
    type: persisted.type,
    source,
    ...(persisted.enabled !== undefined ? { enabled: persisted.enabled } : {}),
    ...(persisted.writable !== undefined ? { writable: persisted.writable } : {}),
    ...(isPrimary || persisted.primary ? { primary: true } : {}),
    ...(persisted.options ? { options: persisted.options } : {}),
    ...(persisted.wikiName ? { wikiName: persisted.wikiName } : {}),
  };
}
