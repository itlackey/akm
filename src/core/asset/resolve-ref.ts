// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Ref RESOLUTION layer — akm 0.9.0 Chunk-5 flip, stage F1 (ref-grammar decision
 * D-R1 / D-R4).
 *
 * The 0.9.0 ref abstraction is `parse → resolve → serialize`:
 *   - parse     — `parseBundleRef` (`asset-ref.ts`), pure syntax, no I/O.
 *   - resolve   — {@link resolveRef} (this module): turn a maybe-short
 *                 {@link BundleRef} into a fully-qualified {@link ResolvedRef}
 *                 against an injected {@link RefContext}. This is the "the short
 *                 form is input sugar" rule (§11.1) made structural: only a
 *                 `ResolvedRef` ever crosses a storage boundary.
 *   - serialize — `bundleRefToString` (`asset-ref.ts`); serializing a
 *                 `ResolvedRef` always emits the fully-qualified form.
 *
 * ── Cycle-safety (HARD constraint) ──
 *
 * This is a PURE LEAF. It imports only sibling leaves (`asset-ref`,
 * `asset-placement`) and the `core/errors` sink — nothing from the indexer-db
 * SCC and no `Database`/config handle. The resolution surface is INJECTED via
 * {@link RefContext}; callers build the context from their own db handle /
 * installation list and hand it in. Keeping the resolver free of I/O is what
 * lets it stay out of every import cycle.
 *
 * ── Dual-grammar input shim (TRANSIENT — F5 deletes it) ──
 *
 * During the Chunk-5 flip the repository readers accept BOTH the new
 * `[bundle//]conceptId` grammar and the pre-0.9.0 `[origin//]type:name` grammar
 * at the input edge. {@link classifyRefGrammar} is the clean discriminator and
 * {@link legacyConceptId} is the D-R2 static-table translation. Every legacy
 * branch is marked `F5: delete` — it all disappears once the codemod (F2/F3)
 * re-keys the test literals and the old grammar is removed (F5).
 */

import { NotFoundError } from "../errors";
import { stashDirFor, typeForStashDir } from "./asset-placement";
import { type BundleRef, isBundleSlug, parseAssetRef, parseBundleRef } from "./asset-ref";

// ── Resolution surface (D-R4) ───────────────────────────────────────────────

/**
 * One bundle in the injected resolution surface: its workspace slug plus a
 * membership probe. `hasConcept(conceptId)` answers "does this bundle contain a
 * concept with this exact id?" — the callers build it over their index (a
 * `SELECT … WHERE bundle_id = ? AND concept_id = ?` existence check) or their
 * installation list.
 */
export interface RefResolutionBundle {
  id: string;
  hasConcept(conceptId: string): boolean;
}

/**
 * The injected resolution context (D-R4). Pure data + callbacks — no db/config
 * handle leaks in here.
 *   - `bundles`       — candidate bundles in INSTALLATION PRIORITY ORDER (the
 *                       same order origin-less lookups walk today).
 *   - `defaultBundle` — the workspace default; a short ref resolves here first
 *                       when this bundle contains the conceptId.
 *   - `only`          — restrict resolution to a single bundle id (content-
 *                       internal resolution against the CONTAINING bundle is
 *                       `resolveRef(short, { only: containingBundle })`).
 */
export interface RefContext {
  bundles: readonly RefResolutionBundle[];
  defaultBundle?: string;
  only?: string;
}

/**
 * A fully-qualified ref: a {@link BundleRef} whose `bundle` is known.
 * Structurally narrowed — `bundleRefToString(resolved)` always emits the
 * fully-qualified `bundle//conceptId[#fragment]` form.
 */
export type ResolvedRef = BundleRef & { bundle: string };

/**
 * Resolve a maybe-short input ref to a fully-qualified {@link ResolvedRef}
 * against `ctx`, implementing D-R4 exactly:
 *
 *   1. Already-qualified input (`bundle//…`) → that bundle (passthrough). When
 *      `ctx.only` is set and disagrees, that is a not-found (the ref names a
 *      bundle the caller scoped out).
 *   2. Short input, `only` set → resolve to `only` iff it contains the concept.
 *   3. Short input, no `only` → `defaultBundle` if it contains the concept,
 *      otherwise the FIRST bundle (priority order) that contains it.
 *   4. No match → {@link NotFoundError} naming the forms tried.
 *
 * The `#fragment` is carried through untouched.
 */
export function resolveRef(input: string | BundleRef, ctx: RefContext): ResolvedRef {
  const ref = typeof input === "string" ? parseBundleRef(input) : input;
  const { conceptId, fragment } = ref;

  // 1. Qualified passthrough — an explicit bundle prefix wins.
  if (ref.bundle !== undefined) {
    if (ctx.only !== undefined && ref.bundle !== ctx.only) {
      throw notFound(conceptId, [`${ref.bundle}//${conceptId}`], ctx);
    }
    return { bundle: ref.bundle, conceptId, fragment };
  }

  // `only` scoping restricts the candidate set to a single bundle.
  const candidates = ctx.only !== undefined ? ctx.bundles.filter((b) => b.id === ctx.only) : ctx.bundles;

  // 2/3. defaultBundle wins over priority order for a short ref (but only when
  // not `only`-scoped; an `only` request never falls back to the default).
  if (ctx.only === undefined && ctx.defaultBundle !== undefined) {
    const def = ctx.bundles.find((b) => b.id === ctx.defaultBundle);
    if (def?.hasConcept(conceptId)) return { bundle: def.id, conceptId, fragment };
  }

  // First candidate (priority order) that contains the concept.
  for (const b of candidates) {
    if (b.hasConcept(conceptId)) return { bundle: b.id, conceptId, fragment };
  }

  throw notFound(conceptId, [conceptId], ctx);
}

function notFound(conceptId: string, triedForms: string[], ctx: RefContext): NotFoundError {
  const scope = ctx.only !== undefined ? ` in bundle "${ctx.only}"` : "";
  const forms = triedForms.map((f) => `"${f}"`).join(", ");
  return new NotFoundError(`No bundle contains concept "${conceptId}"${scope} (tried ${forms}).`, "ASSET_NOT_FOUND");
}

// ── Dual-grammar input dispatch (TRANSIENT SHIM — F5 deletes all of this) ─────

/** Which ref grammar a raw input string is written in. */
export type RefGrammar = "bundle" | "legacy";

/**
 * Classify a raw ref string as the new `[bundle//]conceptId` grammar or the
 * pre-0.9.0 `[origin//]type:name` grammar (D-R5 charset dispatch).
 *
 * NEW grammar iff EITHER:
 *   - it has a `prefix//tail` split whose `prefix` is a LEGAL bundle slug (no
 *     `/ : . #` or whitespace) AND `tail` carries no `type:`-style colon; OR
 *   - it is a bare conceptId (no `//`, no `:`).
 *
 * LEGACY otherwise. This cleanly routes the tricky both-`//`-and-`:` shapes to
 * legacy: `owner/repo//skill:x` and `npm:@scope/pkg//skill:x` have ILLEGAL
 * bundle-slug prefixes (they contain `/`, `:`, or `.`), and `local//skill:x`
 * has a legal prefix but a colon in the tail — all three land as legacy.
 *
 * F5: delete — after the flip every ref is the new grammar and this dispatch,
 * with its whole legacy arm, is removed.
 */
export function classifyRefGrammar(raw: string): RefGrammar {
  const trimmed = raw.trim();
  const boundary = trimmed.indexOf("//");
  if (boundary >= 0) {
    const prefix = trimmed.slice(0, boundary);
    const tail = trimmed.slice(boundary + 2);
    // Legal slug prefix + colon-free tail ⇒ new grammar; anything else legacy.
    return isBundleSlug(prefix) && !tail.includes(":") ? "bundle" : "legacy";
  }
  // No `//`: a bare conceptId has no colon; a `type:name` legacy ref does.
  return trimmed.includes(":") ? "legacy" : "bundle";
}

/**
 * D-R2 static-table translation of a legacy `type`/`name` pair to its qualified
 * conceptId `<stash-subdir>/<name>` (bare-name fallback for a foreign type with
 * no placement stash-subdir — the same edge the indexer's `item_ref` writer
 * handles). Mirrors `indexer.ts`'s conceptId derivation exactly.
 *
 * F5: delete — the codemod re-keys `type:name` literals to conceptIds directly.
 */
export function legacyConceptId(type: string, name: string): string {
  const stashDir = stashDirFor(type);
  return stashDir !== undefined ? `${stashDir}/${name}` : name;
}

/** The legacy `type`/`name` a qualified conceptId maps back to, or `undefined`. */
export interface LegacyRefParts {
  type: string;
  name: string;
}

/**
 * Reverse of {@link legacyConceptId}: split a qualified conceptId
 * (`<stash-subdir>/<name>`) back to its legacy `type`/`name`, or `undefined`
 * when the leading segment is not a known stash subdir (a bare-name conceptId
 * from a foreign type — no legacy predicate applies).
 *
 * F5: delete — the dual-keyed readers use this only to keep NULL-`item_ref`
 * rows findable by a new-grammar ref; after the flip every row carries
 * `item_ref` and the legacy fallback is gone.
 */
export function conceptIdToLegacy(conceptId: string): LegacyRefParts | undefined {
  const slash = conceptId.indexOf("/");
  if (slash <= 0) return undefined;
  const type = typeForStashDir(conceptId.slice(0, slash));
  if (type === undefined) return undefined;
  return { type, name: conceptId.slice(slash + 1) };
}

/**
 * Translate a raw legacy `[origin//]type:name` ref to its {@link BundleRef}
 * spelling: conceptId via {@link legacyConceptId}, and `bundle` from the origin
 * when the origin is a legal bundle slug (a `registryId`, D-R5 rule 2). A
 * `local`/`stash`/path origin is not a stored bundle id, so it stays short
 * (`bundle` undefined) for the caller to resolve.
 *
 * F5: delete.
 */
export function legacyRefToBundleRef(raw: string): BundleRef {
  const parsed = parseAssetRef(raw);
  const conceptId = legacyConceptId(parsed.type, parsed.name);
  const bundle =
    parsed.origin !== undefined && parsed.origin !== "local" && parsed.origin !== "stash" && isBundleSlug(parsed.origin)
      ? parsed.origin
      : undefined;
  return { bundle, conceptId };
}
