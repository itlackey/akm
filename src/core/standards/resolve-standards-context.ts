// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Dispatch resolver for the standards prompt seam.
 *
 * The wiki `schema.md` injection (former "Feature A") was collapsed in chunk 4
 * with the wiki asset-type death (plan §11 Chunk 4): LLM Wiki content is served
 * by the `llm-wiki` adapter, which owns its own `schema.md` contract. What
 * remains is **stash standards**: for any write target, return the concatenated
 * `category: convention`/`meta` fact bodies plus the per-type SOFT conventions
 * layer (#646), type-scoped to the write target. The underlying readers degrade
 * to `""` on missing/malformed input and never throw, so this resolver never
 * throws.
 */

import { typeNameFromConceptId } from "../asset/resolve-ref";
import { resolveStashStandards } from "./resolve-stash-standards";
import { resolveTypeConventions, typeConventionRef } from "./resolve-type-conventions";

/**
 * Extract the asset type from a write-target ref without throwing. Returns
 * `undefined` for refs that carry no recognizable type. Kept local and lenient —
 * the per-type resolver validates the result against `placementTypes()`, so a
 * bogus prefix here simply yields no convention.
 */
function refType(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const body = ref.includes("//") ? ref.slice(ref.indexOf("//") + 2) : ref;
  // 0.9.0 conceptId `<stash-subdir>/<name>`: delegate to the D-R2 reverse table
  // so the leading stash subdir maps back to its asset type (the canonical path).
  const conceptType = typeNameFromConceptId(body)?.type;
  if (conceptType !== undefined) return conceptType;
  // DOCUMENTED EXCEPTION (ref-grammar decision D-R3 migration window): a tolerant
  // legacy `type:name` arm survives ONLY because live callers still hand this
  // recognition-only seam the old spelling — `propose.ts` builds
  // `${options.type}:${options.name}`, and a pre-migration stored ref may still
  // reach here before the 0.10.0 grammar removal. It never crosses a storage
  // boundary, so it stays until those feeders flip.
  const colon = body.indexOf(":");
  if (colon > 0) return body.slice(0, colon).trim() || undefined;
  return undefined;
}

/**
 * Resolve the standards context for a write target identified by its asset ref.
 *
 * @param ref       Canonical asset ref of the write target (e.g. `skill:foo`).
 *                  When undefined, the target is a general authoring flow.
 * @param stashRoot Stash root directory.
 */
export function resolveStandardsContext(ref: string | undefined, stashRoot: string): string {
  // General stash standards plus the per-type SOFT conventions layer (#646),
  // type-scoped to the write target.
  const general = resolveStashStandards(stashRoot);

  const type = refType(ref);
  // A non-empty body here guarantees `type` is a `placementTypes()`-validated
  // string (the resolver returns "" otherwise).
  const typeConventions = type ? resolveTypeConventions(stashRoot, type) : "";
  if (!typeConventions || !type) return general;

  // Soft, type-scoped guidance — clearly labeled and kept separate from the
  // HARD (validator-enforced) rules that `authoringRulesForType` injects
  // downstream. These facts are advice only; they never weaken the gate.
  const softSection = [
    `# ${typeConventionRef(type)} (soft per-type conventions — guidance, not enforced)`,
    typeConventions,
  ].join("\n");

  return general ? `${general}\n\n${softSection}` : softSection;
}
