// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Chunk 1.5 (WI-1.5.1, D1.5-4) — the §2.3 "compile-time safety mitigation"
 * table for AKM's own presentation metadata.
 *
 * The open type token (this chunk) trades the deleted closed asset-type
 * union's exhaustiveness checking for a runtime lookup. `TYPE_PRESENTATION`
 * restores that exhaustiveness for AKM's OWN 14 known types (the compiler
 * demands an entry whenever {@link KnownType} gains a member), while
 * {@link presentationFor} stays open over `string` so foreign/adapter types
 * still resolve to a sane generic fallback instead of `undefined`/a throw.
 *
 * Deliberately NOT `core/asset/asset-registry.ts` (deleted whole in Chunk 3)
 * and NOT `output/renderers.ts` (same fate) — this module is the durable
 * home Chunk 2/3 can point per-adapter `TYPE_PRESENTATION` tables at later.
 * `label` is the only field minted now; Chunk 2/3 own extending this shape
 * with real renderer/action wiring (asset-registry's `TYPE_TO_RENDERER`/
 * `ACTION_BUILDERS` still own that job until then — this module does not
 * replace them yet).
 */

import { isKnownType, type KnownType } from "./recognition-util";

export interface Presentation {
  /** Human-readable label for this asset type (e.g. "Skill", "Knowledge"). */
  label: string;
}

/**
 * Exhaustive over {@link KnownType} — a HAND-WRITTEN literal, not derived
 * from `KNOWN_TYPES` programmatically, so the compiler rejects this object
 * if a `KNOWN_TYPES` member is added without a corresponding entry here
 * (TypeScript's version of the `§7.3 shipped-assets lint` cross-check the
 * plan describes for later — "adding a KNOWN_TYPE forces a decision").
 */
export const TYPE_PRESENTATION: Record<KnownType, Presentation> = {
  skill: { label: "Skill" },
  command: { label: "Command" },
  agent: { label: "Agent" },
  knowledge: { label: "Knowledge" },
  workflow: { label: "Workflow" },
  script: { label: "Script" },
  memory: { label: "Memory" },
  env: { label: "Env" },
  secret: { label: "Secret" },
  wiki: { label: "Wiki" },
  lesson: { label: "Lesson" },
  task: { label: "Task" },
  session: { label: "Session" },
  fact: { label: "Fact" },
};

/** Generic fallback for a type outside {@link KNOWN_TYPES} — never `undefined`, never a throw. */
const DEFAULT_PRESENTATION: Presentation = { label: "Asset" };

/**
 * Open-string lookup with a generic, non-`undefined` fallback (plan §2.3).
 * `undefined` (no type known yet) and any foreign/adapter type both resolve
 * to {@link DEFAULT_PRESENTATION}; only AKM's own {@link KNOWN_TYPES} get a
 * type-specific presentation.
 */
export function presentationFor(type: string | undefined): Presentation {
  if (type !== undefined && isKnownType(type)) return TYPE_PRESENTATION[type];
  return DEFAULT_PRESENTATION;
}
