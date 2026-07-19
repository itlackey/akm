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

import { NotFoundError, UsageError } from "../errors";
import { stashDirFor, typeForStashDir } from "./asset-placement";
import { type AssetRef, type BundleRef, isBundleSlug, makeAssetRef, parseAssetRef, parseBundleRef } from "./asset-ref";

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

// ── Display-ref emission (Chunk-5 flip F4b — the output-spelling rule) ────────

/**
 * The fields {@link displayRef} needs from an indexed item to build its
 * user-facing / envelope ref string. Supplied by every emission site (search
 * hit, show/curate response, workflow status, improve REPORT envelope, …).
 */
export interface DisplayRefItem {
  /** Legacy asset type — supplies the conceptId stash-subdir when `conceptId` is absent. */
  type: string;
  /** Bare canonical name — the conceptId tail when `conceptId` is absent. */
  name: string;
  /**
   * The row's stored conceptId (`concept_id` / the `item_ref` tail). Derived
   * from `type`/`name` (D-R2 `stashDirFor(type)/name`) when absent — the
   * NULL-`item_ref` write-back-row fallback.
   */
  conceptId?: string;
  /**
   * The item's bundle id — the search source's `registryId`, or the row's
   * `bundle_id`. `undefined` means the default/primary bundle (the un-qualified
   * display case).
   */
  bundleId?: string;
}

/**
 * D-R2 conceptId derivation from a legacy `type`/`name` pair
 * (`stashDirFor(type)/name`; bare name for a foreign type with no placement
 * stash-subdir). Kept self-contained so {@link displayRef} — a PERMANENT display
 * rule — does not depend on the `F5: delete` legacy shims below.
 */
function conceptIdFromTypeName(type: string, name: string): string {
  const stashDir = stashDirFor(type);
  return stashDir !== undefined ? `${stashDir}/${name}` : name;
}

/**
 * Build the USER-FACING / envelope ref string for an indexed item, applying the
 * Chunk-5 flip F4b output-spelling rule (orchestrator decision; ref-grammar
 * decision D-R2 / D-R3). This is the ONE place the rule lives — every emission
 * site calls it instead of hand-building a ref from an entry.
 *
 * The rule mirrors TODAY'S origin-qualification UX, transposed to the 0.9.0
 * grammar:
 *
 *   - An item in the **default/primary bundle** (`bundleId` undefined, or equal
 *     to `defaultBundleId`) emits the SHORT conceptId (`knowledge/http-caching`)
 *     — exactly where the pre-0.9.0 output emitted an un-qualified `type:name`.
 *   - An item in a slug-clean **non-default bundle** emits the fully-qualified
 *     `bundle//conceptId`.
 *   - An item whose bundle id is a registry origin that is NOT YET a legal
 *     bundle slug (`github:owner/repo`, `npm:@scope/pkg`, `owner/repo` — they
 *     carry `:` / `/`) keeps the legacy `origin//type:name` display THIS STAGE.
 *     The registry-origin display re-key is F4c / Chunk-8 (bundle-identity
 *     slugging), so this branch is byte-identical to today's qualified output
 *     and the codemod's origin-qualified skips stay consistent with it.
 *     // F4c: unify onto bundle//conceptId
 */
export function displayRef(item: DisplayRefItem, defaultBundleId?: string): string {
  const conceptId = item.conceptId ?? conceptIdFromTypeName(item.type, item.name);
  const { bundleId } = item;
  // Default/primary bundle → SHORT conceptId (the flip).
  if (bundleId === undefined || bundleId === defaultBundleId) return conceptId;
  // Slug-clean non-default bundle → the new fully-qualified grammar.
  if (isBundleSlug(bundleId)) return `${bundleId}//${conceptId}`;
  // Registry origin not yet a legal bundle slug — legacy display until F4c.
  return makeAssetRef(item.type, item.name, bundleId); // F4c: unify onto bundle//conceptId
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

// ── Input-boundary parser (TRANSIENT SHIM — F5 deletes it) ───────────────────

/**
 * Parse a RAW user / CLI / API ref string that may be written in EITHER the new
 * `[bundle//]conceptId` grammar OR the pre-0.9.0 `[origin//]type:name` grammar,
 * returning it in today's {@link AssetRef} value-object shape (Chunk-5 flip
 * stage F1b, ref-grammar decision D-R1 / D-R4).
 *
 * This is the ADDITIVE bridge that lets an input boundary accept both grammars
 * without changing what its downstream consumers see: every existing call site
 * that parses a user-typed ref and then reads `{ type, name, origin }` keeps
 * working, and F2's re-keyed test literals (`knowledge/guide`,
 * `bundle//knowledge/guide`) no longer THROW at the parse edge before reaching
 * the F1 dual-keyed readers.
 *
 * Mapping (new grammar → {@link AssetRef}):
 *   - `conceptId` → `type`/`name` via {@link conceptIdToLegacy} (the D-R2 static
 *     stash-subdir table). A conceptId whose leading segment is not a known
 *     stash subdir has no legacy `type` predicate — that is the same outcome an
 *     unknown asset type produces today (a not-found), so we raise a
 *     {@link NotFoundError} naming the ref rather than inventing a bare-name row.
 *   - `bundle` → `origin`. A new-grammar bundle slug is a registryId-shaped id
 *     by construction (D-R5: the workspace bundle id is `registryId` /
 *     `slugForPath`, both legal origin tokens), so it flows straight into the
 *     legacy origin channel that `resolveSourcesForOrigin` already matches on
 *     `registryId`. The SHORT form (no bundle) leaves `origin` undefined =
 *     search-all-sources, matching D-R4's defaultBundle-then-priority order.
 *   - `#fragment` → rejected. No input boundary consumes an export fragment
 *     today; a clear usage error beats silently folding it into the name.
 *
 * Legacy input is handed to {@link parseAssetRef} unchanged (byte-identical) —
 * the existing suite is the proof.
 *
 * F5: delete — once F2/F3 re-key the literals and the old grammar is removed,
 * boundaries parse `parseBundleRef` directly.
 */
export function parseRefInput(raw: string): AssetRef {
  if (classifyRefGrammar(raw) === "legacy") {
    return parseAssetRef(raw);
  }
  const ref = parseBundleRef(raw);
  if (ref.fragment !== undefined) {
    throw new UsageError(
      `Export fragment "#${ref.fragment}" is not accepted here — drop it from "${raw.trim()}".`,
      "INVALID_FLAG_VALUE",
    );
  }
  const legacy = conceptIdToLegacy(ref.conceptId);
  if (legacy === undefined) {
    throw new NotFoundError(
      `Unrecognized asset ref "${raw.trim()}": conceptId "${ref.conceptId}" has no known asset-type prefix.`,
      "ASSET_NOT_FOUND",
    );
  }
  return { type: legacy.type, name: legacy.name, origin: ref.bundle };
}

/**
 * Does `raw` already read as a COMPLETE asset ref (in either grammar), as
 * opposed to a bare asset name that a boundary would prefix with a default type
 * (the `env`/`secret`/`akm mv` "bare name" convenience)?
 *
 * True when `raw` is a legacy `[origin//]type:name` (it carries a `type:`
 * colon) OR a new-grammar `[bundle//]conceptId` whose conceptId leads with a
 * KNOWN stash subdir (`conceptIdToLegacy` resolves it). A bare name like
 * `prod` or `projectA/new-note` is neither — its leading segment maps to no
 * type — so it stays a bare name for the caller to qualify.
 *
 * F5: delete — folds into each caller once the old grammar is gone.
 */
export function isFullRefInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (classifyRefGrammar(trimmed) === "legacy") return true;
  try {
    return conceptIdToLegacy(parseBundleRef(trimmed).conceptId) !== undefined;
  } catch {
    return false;
  }
}
