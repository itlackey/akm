// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The single, keyed-on-ref implementation of "is this a derived memory?" and
 * "which parent does it derive from?" (R12).
 *
 * Two divergent copies previously lived side by side — the CONSUMER
 * (`memory-improve.ts`, keyed on the memory name) and the PRODUCER
 * (`memory-contradiction-detect.ts`, keyed on the file path). The producer's
 * copy was strictly narrower: it ignored `derivedFrom` entirely and matched
 * `source:` only via a raw `startsWith("memory:")` (so a whitespace- or
 * origin-prefixed `source:` fell through to the filename heuristic). That let
 * the producer and consumer disagree on a memory's parent — the exact defect
 * plan §6 calls out ("producer/consumer cannot disagree").
 *
 * Both sides now share this one impl, keyed on the memory NAME (the stash-
 * relative path without the `.md` extension, e.g. `nested/foo.derived`). The
 * producer converts its file path to a name via `toMemoryRef` before calling
 * in. Adopting it on the producer side is an INTENTIONAL widening, pinned by
 * `tests/commands/improve/derived-ref.test.ts`:
 *   - `derivedFrom`-keyed families now resolve a parent (and so participate in
 *     contradiction detection); and
 *   - `source:` is normalised through `parseRefInput` (trim + origin) so a
 *     `source: " team//memory:parent "` resolves to `memory:parent` instead of
 *     silently degrading to the filename.
 *
 * Resolution order (source → derivedFrom → `.derived` suffix) matches the
 * consumer's prior behaviour exactly, so the consumer side is a pure move.
 */

import { conceptIdFromTypeName, parseRefInput } from "../../../core/asset/resolve-ref";
import { asNonEmptyString } from "../../../core/common";
import { DERIVED_SUFFIX } from "../../../core/recognition-util";

/**
 * Parse an arbitrary `source:`/edge string to the BARE memory name (no type
 * prefix), or `undefined` when it is empty, unparseable, or not a memory ref.
 * Trims whitespace and drops any origin/bundle prefix.
 *
 * READ tolerance is intentionally dual-grammar: the value may carry the legacy
 * `[origin//]memory:<name>` spelling (un-migrated stash content in the wild) OR
 * the 0.9.0 `[bundle//]memories/<name>` conceptId. Callers format the bare name
 * into whichever CHANNEL grammar they compare against:
 *   - the `derived_from` channel → `memories/<name>` conceptId (see
 *     {@link parseMemoryRef} / {@link resolveParentRef});
 *   - the belief-edge / identity channel → `memory:<name>` (memory-improve's
 *     `refArray`, compared against a derived memory's own `memory:<name>` ref,
 *     a separate legacy remnant Group-C item 2 does NOT touch).
 */
export function parseMemoryName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  try {
    const parsed = parseRefInput(trimmed);
    return parsed.type === "memory" ? parsed.name : undefined;
  } catch {
    // Legacy `[origin//]memory:<name>` — strip the origin, keep memory refs only.
    const boundary = trimmed.indexOf("//");
    const body = boundary >= 0 ? trimmed.slice(boundary + 2) : trimmed;
    const MEMORY_PREFIX = "memory:";
    return body.startsWith(MEMORY_PREFIX) ? body.slice(MEMORY_PREFIX.length) : undefined;
  }
}

/**
 * Normalise an arbitrary `source:` derived_from backref to the canonical 0.9.0
 * `memories/<name>` conceptId, or `undefined` when it is not a memory ref
 * (Group-C item 2 flip). Tolerant of BOTH grammars on input (see
 * {@link parseMemoryName}), but the NORMALISED OUTPUT is always the conceptId —
 * so every consumer that compares against the `derived_from` channel (the
 * parentRef filter, inference dedup, eligibility) speaks one grammar. The
 * content-migration folds the on-disk legacy spelling forward; this reader keeps
 * tolerating it until the 0.10.0 grammar removal.
 */
export function parseMemoryRef(value: string | undefined): string | undefined {
  const name = parseMemoryName(value);
  return name === undefined ? undefined : conceptIdFromTypeName("memory", name);
}

/**
 * Format a bare memory name into the belief-edge IDENTITY channel ref
 * `memory:<name>` — the ONE implementation of that spelling.
 *
 * DOCUMENTED EXCEPTION (ref-grammar decision D-R3): the belief-edge / identity
 * channel (`contradictedBy` / `supersededBy` / `currentBeliefRefs`, and a derived
 * memory's own `record.ref`) deliberately stays in `memory:<name>` grammar — it
 * is compared against a derived memory's own identity ref, a channel DECOUPLED
 * from the `derived_from` record refs that Group-C item 2 flipped to
 * `memories/<name>`. Both `memory-improve.ts` (`refArray`) and
 * `memory-contradiction-detect.ts` (`toMemoryRef`) emit through here so the
 * exception has exactly one home instead of three hand-rolled copies.
 */
export function memoryIdentityRef(name: string): string {
  return `memory:${name}`;
}

/**
 * True when the named memory is a derived/inferred child — either it carries
 * `inferred: true` in its frontmatter or its name ends with the structural
 * `.derived` suffix.
 */
export function isDerivedMemory(name: string, frontmatter: Record<string, unknown>): boolean {
  return frontmatter.inferred === true || name.endsWith(DERIVED_SUFFIX);
}

/**
 * Resolve the parent (source) memory ref for a derived memory as the canonical
 * `memories/<name>` conceptId (Group-C item 2 flip), or `undefined` when none
 * can be determined. Precedence:
 *   1. `frontmatter.source` (normalised through {@link parseMemoryRef});
 *   2. `frontmatter.derivedFrom` (a bare memory name → `memories/<name>`);
 *   3. the `.derived` name suffix, stripped → `memories/<name>`.
 */
export function resolveParentRef(name: string, frontmatter: Record<string, unknown>): string | undefined {
  const fromSource = parseMemoryRef(asNonEmptyString(frontmatter.source));
  if (fromSource) return fromSource;

  const derivedFrom = asNonEmptyString(frontmatter.derivedFrom);
  if (derivedFrom) return conceptIdFromTypeName("memory", derivedFrom);

  if (name.endsWith(DERIVED_SUFFIX)) {
    return conceptIdFromTypeName("memory", name.slice(0, -DERIVED_SUFFIX.length));
  }

  return undefined;
}
