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
 * ── Input-boundary parser (new-grammar only) ──
 *
 * {@link parseRefInput} parses a RAW user/CLI/API ref in the 0.9.0
 * `[bundle//]conceptId` grammar and returns today's {@link AssetRef} shape via
 * the permanent D-R2 reverse table {@link typeNameFromConceptId}. STORED durable
 * refs keep the pre-0.9.0 spelling until the Chunk-8 re-key and are parsed by
 * `parseStoredRef` (src/migrate/legacy-ref-grammar.ts), NOT here.
 */

import type { AssetRef } from "../../migrate/legacy-ref-grammar";
import { NotFoundError, UsageError } from "../errors";
import { stashDirFor, typeForStashDir } from "./asset-placement";
import { type BundleRef, isBundleSlug, parseBundleRef } from "./asset-ref";

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
 * rule — does not depend on the transient legacy shims.
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
 *   - An item whose bundle id is a registry origin that is NOT a legal bundle
 *     slug (`github:owner/repo`, `npm:@scope/pkg`, `owner/repo` — they carry
 *     `:` / `.` / `/`) keeps the legacy `origin//type:name` display. F4c DECISION
 *     (ref-grammar decision D-R5): a registryId that is not a legal slug cannot be
 *     re-keyed to `bundle//conceptId` without INVENTING a slugging scheme, which
 *     D-R5 forbids — the slug-clean → `bundle//conceptId` mapping is the Chunk-8
 *     config `bundles` key (D-R5 rule 1), assigned when the config migration
 *     lands. Until then this branch is byte-identical to today's qualified output
 *     and the codemod's origin-qualified skips stay consistent with it.
 */
export function displayRef(item: DisplayRefItem, defaultBundleId?: string): string {
  const conceptId = item.conceptId ?? conceptIdFromTypeName(item.type, item.name);
  const { bundleId } = item;
  // Default/primary bundle → SHORT conceptId (the flip). `"local"`/`"stash"` are
  // the primary-stash origin sentinels (never real bundle slugs — they name the
  // workspace's own stash, exactly where the pre-0.9.0 output was un-qualified),
  // so they display short too.
  if (bundleId === undefined || bundleId === defaultBundleId || bundleId === "local" || bundleId === "stash")
    return conceptId;
  // Slug-clean non-default bundle (e.g. a named filesystem source) → the new
  // fully-qualified grammar.
  if (isBundleSlug(bundleId)) return `${bundleId}//${conceptId}`;
  // Registry origin whose registryId is not a legal bundle slug (`:` / `.` / `/`)
  // keeps the legacy `origin//type:name` display (Chunk-8: config bundle key).
  // Index item names are already canonical, so the legacy spelling is inline.
  return `${bundleId}//${item.type}:${item.name}`;
}

// ── D-R2 reverse table + input-boundary parser (new grammar only) ────────────

/** The legacy `type`/`name` a qualified conceptId maps back to, or `undefined`. */
export interface LegacyRefParts {
  type: string;
  name: string;
}

/**
 * Split a qualified conceptId (`<stash-subdir>/<name>`) back to its legacy
 * `type`/`name`, or `undefined` when the leading segment is not a known stash
 * subdir (a bare-name conceptId from a foreign type — no legacy predicate
 * applies). The PERMANENT D-R2 reverse table: the input boundary uses it to map
 * a new-grammar conceptId onto today's {@link AssetRef} shape. (The migrate home
 * keeps a private transient copy for stored-ref parsing.)
 */
export function typeNameFromConceptId(conceptId: string): LegacyRefParts | undefined {
  const slash = conceptId.indexOf("/");
  if (slash <= 0) return undefined;
  const type = typeForStashDir(conceptId.slice(0, slash));
  if (type === undefined) return undefined;
  return { type, name: conceptId.slice(slash + 1) };
}

/**
 * Parse a RAW user / CLI / API ref string in the 0.9.0 `[bundle//]conceptId`
 * grammar, returning it in today's {@link AssetRef} value-object shape
 * (ref-grammar decision D-R1 / D-R4). Input boundaries are NEW-GRAMMAR ONLY: a
 * legacy `type:name` input now fails as an unknown-conceptId not-found. STORED
 * durable refs keep the legacy spelling until the Chunk-8 re-key and are parsed
 * by `parseStoredRef` (src/migrate/legacy-ref-grammar.ts) instead.
 *
 * Mapping (new grammar → {@link AssetRef}):
 *   - `conceptId` → `type`/`name` via {@link typeNameFromConceptId} (the D-R2
 *     static stash-subdir table). A conceptId whose leading segment is not a
 *     known stash subdir has no legacy `type` predicate — the same outcome an
 *     unknown asset type produces today (a not-found).
 *   - `bundle`    → `origin`. A new-grammar bundle slug is a registryId-shaped
 *     id by construction, so it flows straight into the legacy origin channel
 *     that `resolveSourcesForOrigin` matches on `registryId`. The SHORT form (no
 *     bundle) leaves `origin` undefined = search-all-sources.
 *   - `#fragment` → rejected. No input boundary consumes an export fragment.
 */
export function parseRefInput(raw: string): AssetRef {
  const ref = parseBundleRef(raw);
  if (ref.fragment !== undefined) {
    throw new UsageError(
      `Export fragment "#${ref.fragment}" is not accepted here — drop it from "${raw.trim()}".`,
      "INVALID_FLAG_VALUE",
    );
  }
  const legacy = typeNameFromConceptId(ref.conceptId);
  if (legacy === undefined) {
    throw new NotFoundError(
      `Unrecognized asset ref "${raw.trim()}": conceptId "${ref.conceptId}" has no known asset-type prefix.`,
      "ASSET_NOT_FOUND",
    );
  }
  return { type: legacy.type, name: legacy.name, origin: ref.bundle };
}

/**
 * Parse a CLI/API ref that MAY be qualified by a NON-slug origin — a registry
 * ref (`github:owner/repo`, `npm:@scope/pkg`, `git:host/path`), a bare path, or
 * a URL — as its `origin//conceptId` prefix. Such an origin carries `:`/`.`/`/`
 * so it is not a legal bundle slug and the strict {@link parseRefInput} rejects
 * it; but it is still a valid SOURCE origin that `resolveSourcesForOrigin`
 * matches by registry-id / path and the remote-fetch fallback can install. The
 * conceptId body is parsed under the strict new grammar; the raw origin is kept
 * as-is — the symmetric input side of {@link displayRef}, which likewise keeps
 * `origin//…` for exactly these non-slug origins (ref-grammar decision D-R5).
 *
 * A short ref (no origin) or a slug-origin ref is delegated verbatim to
 * {@link parseRefInput}, so this is a safe superset for origin-accepting
 * commands (`show`, `clone`, `graph`, `history`).
 */
export function parseQualifiedRefInput(raw: string): AssetRef {
  const trimmed = raw.trim();
  const boundary = trimmed.indexOf("//");
  if (boundary > 0) {
    const origin = trimmed.slice(0, boundary);
    if (!isBundleSlug(origin)) {
      return { ...parseRefInput(trimmed.slice(boundary + 2)), origin };
    }
  }
  return parseRefInput(trimmed);
}

/**
 * Does `raw` already read as a COMPLETE new-grammar asset ref, as opposed to a
 * bare asset name that a boundary would prefix with a default type (the
 * `env`/`secret`/`akm mv` "bare name" convenience)?
 *
 * True when `raw` is a `[bundle//]conceptId` whose conceptId leads with a KNOWN
 * stash subdir ({@link typeNameFromConceptId} resolves it). A bare name like
 * `prod` or `projectA/new-note` is neither — its leading segment maps to no
 * type — so it stays a bare name for the caller to qualify.
 */
export function isFullRefInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    return typeNameFromConceptId(parseBundleRef(trimmed).conceptId) !== undefined;
  } catch {
    return false;
  }
}
