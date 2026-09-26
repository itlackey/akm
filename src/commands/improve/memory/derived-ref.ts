// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The one implementation of "is this a derived memory, and what is its parent?" (R12), keyed on the memory name. */

import { conceptIdFromTypeName, parseRefInput } from "../../../core/asset/resolve-ref";
import { asNonEmptyString } from "../../../core/common";
import { DERIVED_SUFFIX } from "../../../core/recognition-util";

/**
 * A belief edge (`supersededBy` / `contradictedBy` / `currentBeliefRefs`) as a
 * bare memory name. Both spellings occur: `memory:<name>` (pre-0.9 edges) and
 * `[bundle//]memories/<name>` (what `--supersedes` writes today); accepting only
 * the first once read every superseded memory back as active.
 */
export function parseMemoryName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("memory:")) return trimmed.slice("memory:".length) || undefined;
  try {
    const parsed = parseRefInput(trimmed);
    return parsed.type === "memory" && parsed.name.length > 0 ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/** A `source:` backref as a memory conceptId, or `undefined` when it is not a memory ref. */
export function parseMemoryRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = parseRefInput(value.trim());
    return parsed.type === "memory" ? conceptIdFromTypeName("memory", parsed.name) : undefined;
  } catch {
    return undefined;
  }
}

/** The belief-edge identity spelling, `memory:<name>` (separate from `source:` asset refs). */
export function memoryIdentityRef(name: string): string {
  return `memory:${name}`;
}

/** Inferred (`inferred: true`) or named with the `.derived` suffix. */
export function isDerivedMemory(name: string, frontmatter: Record<string, unknown>): boolean {
  return frontmatter.inferred === true || name.endsWith(DERIVED_SUFFIX);
}

/** A derived memory's parent conceptId: from `source`, else `derivedFrom`, else the name minus `.derived`. */
export function resolveParentRef(name: string, frontmatter: Record<string, unknown>): string | undefined {
  const fromSource = parseMemoryRef(asNonEmptyString(frontmatter.source));
  if (fromSource) return fromSource;
  const derivedFrom = asNonEmptyString(frontmatter.derivedFrom);
  if (derivedFrom) return conceptIdFromTypeName("memory", derivedFrom);
  if (name.endsWith(DERIVED_SUFFIX)) return conceptIdFromTypeName("memory", name.slice(0, -DERIVED_SUFFIX.length));
  return undefined;
}
