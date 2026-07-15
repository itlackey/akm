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
 *   - `source:` is normalised through `parseAssetRef` (trim + origin) so a
 *     `source: " team//memory:parent "` resolves to `memory:parent` instead of
 *     silently degrading to the filename.
 *
 * Resolution order (source → derivedFrom → `.derived` suffix) matches the
 * consumer's prior behaviour exactly, so the consumer side is a pure move.
 */

import { makeAssetRef, parseAssetRef } from "../../../core/asset/asset-ref";
import { asNonEmptyString } from "../../../core/common";

/** Structural marker suffix for a derived (inferred) memory's canonical name. */
export const DERIVED_SUFFIX = ".derived";

/**
 * Normalise an arbitrary `source:`/edge string to a canonical `memory:<name>`
 * ref, or `undefined` when it is empty, unparseable, or not a memory ref.
 * Trims whitespace and drops any origin prefix via {@link parseAssetRef}.
 */
export function parseMemoryRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = parseAssetRef(value.trim());
    if (parsed.type !== "memory") return undefined;
    return makeAssetRef(parsed.type, parsed.name);
  } catch {
    return undefined;
  }
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
 * Resolve the parent (source) memory ref for a derived memory, or `undefined`
 * when none can be determined. Precedence:
 *   1. `frontmatter.source` (normalised through {@link parseMemoryRef});
 *   2. `frontmatter.derivedFrom` (a bare memory name);
 *   3. the `.derived` name suffix, stripped.
 */
export function resolveParentRef(name: string, frontmatter: Record<string, unknown>): string | undefined {
  const fromSource = parseMemoryRef(asNonEmptyString(frontmatter.source));
  if (fromSource) return fromSource;

  const derivedFrom = asNonEmptyString(frontmatter.derivedFrom);
  if (derivedFrom) return makeAssetRef("memory", derivedFrom);

  if (name.endsWith(DERIVED_SUFFIX)) {
    return makeAssetRef("memory", name.slice(0, -DERIVED_SUFFIX.length));
  }

  return undefined;
}
