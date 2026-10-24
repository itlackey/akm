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
 * `[bundle//]conceptId` grammar and returns an {@link AssetRef} value object via
 * the permanent D-R2 reverse table {@link typeNameFromConceptId}. Post-Chunk-8
 * every durable ref reaching a reader is already the new grammar, so this is the
 * ONE ref parser outside the frozen migrator — there is no stored-ref dual
 * grammar to bridge any more.
 */

import { NotFoundError, UsageError } from "../errors";
import {
  deriveCanonicalAssetNameFromStashRoot,
  placementSpecFor,
  stashDirFor,
  typeForStashDir,
} from "./asset-placement";
import { type BundleRef, isBundleSlug, parseBundleRef } from "./asset-ref";

// ── Parsed-ref value object (the `type`/`name`/`origin` decomposition) ────────

/**
 * The decomposed form of a parsed ref — the return shape of {@link parseRefInput}
 * / {@link parseQualifiedRefInput}. `type`/`name` are the asset-type projection
 * and canonical name (D-R2 reverse of the conceptId); `origin` is the bundle
 * slug (or non-slug source origin) when the ref was qualified, else undefined.
 * (The frozen migrator keeps its own private copy of this shape.)
 */
export interface AssetRef {
  type: string;
  name: string;
  origin?: string;
}

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
  /** Asset type used to derive the conceptId stash-subdir when needed. */
  type: string;
  /** Bare canonical name — the conceptId tail when `conceptId` is absent. */
  name: string;
  /**
   * The row's stored conceptId (`concept_id` / the `item_ref` tail). Derived
   * from `type`/`name` (D-R2 `stashDirFor(type)/name`) when absent.
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
 * D-R2 conceptId derivation from an asset `type`/`name` pair
 * (`stashDirFor(type)/name`; bare name for a foreign type with no placement
 * stash-subdir). Kept self-contained so {@link displayRef} — a PERMANENT display
 * rule remains independent of input parsing.
 *
 * Exported (Chunk-8 WI-8.5c) as the ONE conceptId derivation the improve
 * correlation sites (`eligibility.ts` candidate refs, `salience.ts`
 * last-use lookup) share with the
 * display rule — the permanent successor to the retired transient
 * `legacyConceptId`.
 */
export function conceptIdFromTypeName(type: string, name: string): string {
  const stashDir = stashDirFor(type);
  return stashDir !== undefined ? `${stashDir}/${name}` : name;
}

/**
 * User-facing conceptId for a file on disk, derived through the placement
 * spec's canonical-name rule — the ONE way a diagnostic should spell a ref it
 * expects the user to paste into `akm show`. (The dangerous-env-key lint used
 * to hand-build `env:<base>` colon refs the parser rejects; both its emission
 * sites now route through here.) For a type with no placement spec — which no
 * built-in caller passes — falls back to the raw name so the output is still
 * informative rather than empty.
 */
export function conceptIdForStashFile(type: string, stashRoot: string, filePath: string): string {
  const name = deriveCanonicalAssetNameFromStashRoot(type, stashRoot, filePath);
  return name === undefined ? filePath : conceptIdFromTypeName(type, name);
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
 *   - Any other **non-default bundle** emits the fully-qualified
 *     `bundle//conceptId`. Post-Chunk-8 every bundle id is a legal slug (the
 *     config migration assigned each source its D-R5 slug bundle key), so this
 *     is always the new grammar — a non-slug registryId now displays under its
 *     derived slug bundle id, never the retired `origin//type:name` spelling.
 */
export function displayRef(item: DisplayRefItem, defaultBundleId?: string): string {
  return displayRefForConceptId(
    item.conceptId ?? conceptIdFromTypeName(item.type, item.name),
    item.bundleId,
    defaultBundleId,
  );
}

/**
 * The F4b output-spelling flip itself, for a caller that already holds the
 * conceptId (no `type`/`name` derivation needed — e.g. lint findings built
 * from {@link conceptIdForStashFile}). {@link displayRef} delegates here, so
 * the short-default / qualified-secondary rule still has exactly one home.
 */
export function displayRefForConceptId(
  conceptId: string,
  bundleId: string | undefined,
  defaultBundleId?: string,
): string {
  // Default/primary bundle → SHORT conceptId (the flip).
  if (bundleId === undefined || bundleId === defaultBundleId) return conceptId;
  // Non-default bundle → the new fully-qualified `bundle//conceptId` grammar.
  return `${bundleId}//${conceptId}`;
}

// ── D-R2 reverse table + input-boundary parser (new grammar only) ────────────

/** The asset `type`/`name` a qualified conceptId maps to, or `undefined`. */
export interface AssetRefParts {
  type: string;
  name: string;
}

/**
 * Split a qualified conceptId (`<stash-subdir>/<name>`) into its asset
 * `type`/`name`, or `undefined` when the leading segment is not a known stash
 * subdir (a bare-name conceptId from a foreign type — no legacy predicate
 * applies). The PERMANENT D-R2 reverse table: the input boundary uses it to map
 * a new-grammar conceptId onto today's {@link AssetRef} shape. (The migrate home
 * keeps a private transient copy for stored-ref parsing.)
 */
export function typeNameFromConceptId(conceptId: string): AssetRefParts | undefined {
  const slash = conceptId.indexOf("/");
  if (slash <= 0) return undefined;
  const type = typeForStashDir(conceptId.slice(0, slash));
  if (type === undefined) return undefined;
  return { type, name: conceptId.slice(slash + 1) };
}

/**
 * D11 — the opaque-adapter-conceptId fallback. `typeNameFromConceptId` only
 * ever answers for the PLACEMENT_SPECS stash-resident subset (D-R2); a
 * conceptId whose leading segment is NOT a registered placement stashDir is
 * still perfectly legal DATA per D11 — an OKF item (`tables/customers`), a
 * website page, a wiki pageKind, an adapter `instruction` doc, … — and the
 * ref-consuming commands must accept it rather than treat "not an AKM
 * placement dir" as "malformed ref". This function draws the line: it accepts
 * any well-formed `<segment>/<rest>` conceptId (so the shape is still
 * anchored — a bare no-slash name stays the caller's job to pre-qualify with a
 * default type, the existing env/secret/`akm mv` "bare name" convenience), and
 * REJECTS anything shaped like the retired `type:name` colon grammar (Q-02):
 * a `:` in the leading segment is that grammar smuggled through a conceptId
 * string (e.g. `script:db/migrate/run.sh`, `workflow:release/train`), not a
 * real adapter directory name, so it is refused rather than silently
 * reinterpreted as opaque data.
 *
 * `name` deliberately carries the FULL original conceptId, not just the tail.
 * This is what makes the pair round-trip through the UNCHANGED
 * {@link conceptIdFromTypeName} (`stashDirFor(type)/name`, bare `name` when
 * `type` has no placement stashDir): since an opaque `type` never owns a
 * placement stashDir, `conceptIdFromTypeName(type, name)` falls to its bare-
 * `name` branch and returns `name` verbatim — the original conceptId,
 * unchanged — instead of losing the leading segment. `type` itself carries
 * the leading segment (informational/behavioral use: `.type === "lesson"`
 * checks correctly miss for opaque data) UNLESS that segment happens to
 * collide with a real PLACEMENT_SPECS type key that merely uses a different
 * stashDir spelling (e.g. a foreign top-level dir literally named "skill",
 * singular) — that pathological case would make `stashDirFor` succeed on the
 * "type" and corrupt the round-trip, so it falls back to the full conceptId as
 * `type` too (never a placement key, since a placement key never contains
 * `/`).
 *
 * This intentionally does NOT collapse the KNOWN_TYPES/PLACEMENT_SPECS split:
 * `typeNameFromConceptId` (PLACEMENT_SPECS only) is untouched, and an opaque
 * `type` returned here is never a {@link KnownType} — it is a passthrough
 * label, not a claim that AKM recognizes or owns the concept.
 */
function opaqueRefParts(conceptId: string, allowRoot = false): AssetRefParts | undefined {
  const slash = conceptId.indexOf("/");
  if (slash <= 0) return allowRoot && !conceptId.includes(":") ? { type: conceptId, name: conceptId } : undefined;
  const segment = conceptId.slice(0, slash);
  if (segment.includes(":")) return undefined; // retired `type:name` grammar, not opaque data (Q-02).
  const type = placementSpecFor(segment) === undefined ? segment : conceptId;
  return { type, name: conceptId };
}

/**
 * Parse a RAW user / CLI / API ref string in the 0.9.0 `[bundle//]conceptId`
 * grammar, returning it in today's {@link AssetRef} value-object shape
 * (ref-grammar decision D-R1 / D-R4). All boundaries are NEW-GRAMMAR ONLY: a
 * legacy `type:name` input now fails as an unknown-conceptId not-found. Post-
 * Chunk-8 every durable ref is already the new grammar, so this parser also
 * serves the (formerly dual-grammar) stored-ref readers.
 *
 * Mapping (new grammar → {@link AssetRef}):
 *   - `conceptId` → `type`/`name` via {@link typeNameFromConceptId} (the D-R2
 *     static stash-subdir table) when the leading segment is a known AKM
 *     placement stashDir, else via {@link opaqueRefParts} (D11 — the ref-parser
 *     seam accepts opaque adapter conceptIds, e.g. OKF items, website pages,
 *     wiki pageKinds, adapter `instruction` docs) when it is merely a well-
 *     formed but foreign `<segment>/<rest>` shape. A conceptId that is neither
 *     — no slash at all, or a retired colon-grammar shape smuggled through —
 *     has no type predicate: the same not-found outcome a genuine typo
 *     produces today.
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
  const parts = typeNameFromConceptId(ref.conceptId) ?? opaqueRefParts(ref.conceptId, ref.bundle !== undefined);
  if (parts === undefined) {
    throw new NotFoundError(
      `Unrecognized asset ref "${raw.trim()}": conceptId "${ref.conceptId}" has no known asset-type prefix.`,
      "ASSET_NOT_FOUND",
    );
  }
  return { type: parts.type, name: parts.name, origin: ref.bundle };
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
    const parsed = parseBundleRef(trimmed);
    return parsed.bundle !== undefined || typeNameFromConceptId(parsed.conceptId) !== undefined;
  } catch {
    return false;
  }
}
