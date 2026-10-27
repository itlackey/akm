// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `models.json`, and an engine's own `model`, folded into the `models` of the connections
 * and harnesses the engines became. See `convert-engines.ts`.
 */

import { getHarness } from "../../integrations/harnesses";
import { isRecord } from "../common";
import type { LlmInference } from "../llm-inference";
import { type Conversion, type Dict, type Entries, str, wireFieldsOf } from "./convert-engines-shared";
import { modelForEveryAlias } from "./model-aliases";

const allAliases = (model: string | undefined): Dict | undefined =>
  model === undefined ? undefined : modelForEveryAlias(model);

/** An overlay entry as a model entry: the bare name, or `{ model, ...fields }` when it sets more. */
function modelEntry(model: string, fields: Dict): unknown {
  return Object.keys(fields).length > 0 ? { model, ...fields } : model;
}

// ── models.json folds into the models of what it named ───────────────────────

/** The models of `entry`, made on it when it has none yet. */
function modelsOf(entry: Dict): Dict {
  entry.models ??= {};
  return entry.models as Dict;
}

const hasModel = (entry: unknown, alias: string): boolean =>
  isRecord(entry) && isRecord(entry.models) && alias in entry.models;

/**
 * The overlay's rows: one per alias and column, the runtime's column first (it is the weakest, naming OpenCode's own
 * models), then a connection's own, then `*`, which fills what is left. The flat shorthand is the `*` column.
 */
function overlayRows(modelsOverlay: unknown): Array<{ alias: string; column: string; profile: unknown }> {
  const overlay = isRecord(modelsOverlay) && isRecord(modelsOverlay.aliases) ? modelsOverlay.aliases : {};
  const rows = Object.entries(overlay as Dict).flatMap(([alias, columns]) => {
    if (!isRecord(columns)) return [];
    const flat = Object.fromEntries(
      Object.entries(columns).filter(([k]) => k === "model" || k === "inference" || k === "engine"),
    );
    const perColumn = Object.entries(columns).filter(([k]) => !(k in flat));
    return [...perColumn, ...(Object.keys(flat).length > 0 ? [["*", flat] as const] : [])].map(([column, profile]) => ({
      alias,
      column,
      profile,
    }));
  });
  const rank = (column: string): number => (column === "opencode-sdk" ? 0 : column === "*" ? 2 : 1);
  return rows.sort((a, b) => rank(a.column) - rank(b.column));
}

/** The engines' own models by the name their entry has now: what an alias nothing else names falls back to. */
export type OwnModels = { readonly connections: Map<string, string>; readonly harnesses: Map<string, string> };

/** What the models.json fold reads: the entries as the file will read them, the file's own and its base's, and where a column lands. */
export interface ModelsFold {
  readonly conversion: Conversion;
  readonly merged: Entries;
  /** What the file itself writes under `connections` / `harnesses`. */
  readonly written: Entries;
  /** What an `extends` base defines. */
  readonly inherited: Entries;
  readonly ownModels: OwnModels;
  /** The names the connections the engines became have now: those a removed runtime pointed at, and the one an engine maps to. */
  readonly renamed: {
    readonly runtime: readonly string[];
    readonly connection: (engine: string) => string | undefined;
  };
}

/**
 * `models.json`: an alias is set by, nearest first, the config's own `models`, models.json's column for that
 * connection or harness, models.json's `*` column (and the flat shorthand, which is that), the engine's own model.
 */
export function foldModelsOverlay(modelsOverlay: unknown, fold: ModelsFold): void {
  const { conversion, merged, written, inherited, ownModels, renamed } = fold;
  const { notes } = conversion;
  const mergedConnections = merged.connections;
  const mergedHarnesses = merged.harnesses;
  const inheritedConnections = inherited.connections;
  const inheritedHarnesses = inherited.harnesses;
  const writtenConnections = written.connections;
  const writtenHarnesses = written.harnesses;
  /** Whether the config itself, the file or its base, already names a model for the alias. */
  const configNames = (own: Dict, base: Dict, name: string, alias: string): boolean =>
    hasModel(own[name], alias) || hasModel(base[name], alias);
  const platformOf = (name: string): string =>
    String(((mergedHarnesses[name] ?? inheritedHarnesses[name]) as Dict | undefined)?.platform ?? name);
  let folded = false;
  for (const { alias, column, profile } of overlayRows(modelsOverlay)) {
    const p: Dict = typeof profile === "string" ? { model: profile } : isRecord(profile) ? profile : {};
    const { effort, ...portable } = (isRecord(p.inference) ? p.inference : {}) as LlmInference & { effort?: string };
    const where = `models.json ${alias}.${column === "*" ? "(all)" : column}`;
    const wire = wireFieldsOf({ ...portable, reasoningEffort: portable.reasoningEffort ?? effort }, where, notes);
    if (p.engine !== undefined) {
      notes.push(`${where}: an engine indirection is not carried over.`);
      continue;
    }
    const candidates =
      column === "*"
        ? [...new Set([...Object.keys(mergedConnections), ...Object.keys(inheritedConnections)])]
        : column === "opencode-sdk"
          ? [...renamed.runtime]
          : renamed.connection(column) !== undefined
            ? [renamed.connection(column) as string]
            : column in writtenConnections || column in inheritedConnections
              ? [column]
              : [];
    const harnessNamed = [...new Set([...Object.keys(mergedHarnesses), ...Object.keys(inheritedHarnesses)])].filter(
      (name) => platformOf(name) === column,
    );
    if (candidates.length === 0 && harnessNamed.length === 0) {
      notes.push(`${where}: names no configured connection or harness, so it is not carried over.`);
      continue;
    }
    // The config's own choice stands, and `*` leaves what an explicit column already set.
    const connectionNames = candidates.filter(
      (name) =>
        !configNames(writtenConnections, inheritedConnections, name, alias) &&
        !(column === "*" && hasModel(mergedConnections[name], alias)),
    );
    const harnessNames = harnessNamed.filter((name) => !configNames(writtenHarnesses, inheritedHarnesses, name, alias));
    if (connectionNames.length === 0 && harnessNames.length === 0) {
      // Only the config's own choice is worth a note; an explicit column that came first is the overlay's own.
      const keptByConfig =
        candidates.some((name) => configNames(writtenConnections, inheritedConnections, name, alias)) ||
        harnessNamed.some((name) => configNames(writtenHarnesses, inheritedHarnesses, name, alias));
      if (keptByConfig) notes.push(`${where}: the config already names a model for it, so it is not carried over.`);
      continue;
    }
    for (const name of connectionNames) {
      const current = (mergedConnections[name] as Dict | undefined)?.models as Dict | undefined;
      const existing = current?.[alias];
      const model =
        str(p.model) ?? str(isRecord(existing) ? existing.model : existing) ?? ownModels.connections.get(name);
      if (model === undefined) continue;
      // A connection only the base defines gets a partial entry here; the base completes it.
      mergedConnections[name] ??= {};
      modelsOf(mergedConnections[name] as Dict)[alias] = modelEntry(model, wire);
      folded = true;
    }
    for (const name of harnessNames) {
      const model = str(p.model) ?? str(getHarness(platformOf(name))?.models?.[alias]);
      if (model === undefined) continue;
      mergedHarnesses[name] ??= {};
      modelsOf(mergedHarnesses[name] as Dict)[alias] = model;
      folded = true;
      if (Object.keys(wire).length > 0)
        notes.push(`${where}: a harness takes the model only; the inference settings are not carried over.`);
    }
  }
  if (folded) conversion.changed = true;
}

/** An engine's `model`: every alias nothing else named is that model, on the entry the engine became. */
export function foldEngineModels(merged: Entries, ownModels: OwnModels): void {
  for (const [kind, entries] of [
    ["connections", merged.connections],
    ["harnesses", merged.harnesses],
  ] as const) {
    for (const [name, model] of ownModels[kind]) {
      const entry = entries[name];
      if (!isRecord(entry)) continue;
      for (const [alias, value] of Object.entries(allAliases(model) ?? {})) {
        if (!hasModel(entry, alias)) modelsOf(entry)[alias] = value;
      }
    }
  }
}
