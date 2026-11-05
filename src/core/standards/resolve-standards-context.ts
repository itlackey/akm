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

import { resolveStashStandards } from "./resolve-stash-standards";
import { resolveTypeConventions, typeConventionRef } from "./resolve-type-conventions";

/**
 * Resolve the standards context for a write target of the given asset type.
 *
 * @param type      The write target's asset type, from its indexed entry or the
 *                  command that names it. When undefined, the target is a general
 *                  authoring flow. The per-type resolver validates it against
 *                  `placementTypes()`, so a bogus type simply yields no convention.
 * @param stashRoot Stash root directory.
 */
export function resolveStandardsContext(type: string | undefined, stashRoot: string): string {
  // General stash standards plus the per-type SOFT conventions layer (#646),
  // type-scoped to the write target.
  const general = resolveStashStandards(stashRoot);

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
