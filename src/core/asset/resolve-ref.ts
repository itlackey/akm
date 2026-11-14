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
 *                 It answers "which bundle" against an injected index snapshot;
 *                 it does not find files. "Where is the file for this ref right
 *                 now" has one answer, `resolveConceptOwner`
 *                 (`src/indexer/lookup/adapter-concept-owner.ts`), which
 *                 every resolver that needs a path calls.
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
 */

import { NotFoundError, UsageError } from "../errors";
import { placementSpecFor, refForFile, stashDirFor, typeForStashDir } from "./asset-placement";
import { type BundleRef, isBundleSlug, parseBundleRef } from "./asset-ref";

// ── Placement address ───────────────────────────────────────────────────────

/**
 * Where a NEW asset is placed: the `type` the user (or the pipeline minting it)
 * named, the `name` within that type's stash subdir, and the bundle `origin`
 * when qualified. Never parsed out of a ref: a ref carries no type, an indexed
 * asset's type is the one its entry records.
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
 * hit, show/curate response, workflow status, improve REPORT envelope, ...).
 */
export interface DisplayRefItem {
  /** The row's stored conceptId (`concept_id` / the `item_ref` tail). */
  conceptId: string;
  /**
   * The item's bundle id — the search source's `registryId`, or the row's
   * `bundle_id`. `undefined` means the default/primary bundle (the un-qualified
   * display case).
   */
  bundleId?: string;
}

/**
 * The conceptId an asset of `type` and `name` gets when it is PLACED: the ref of
 * where the type's placement spec puts it, under its stash subdir. For a NEW
 * asset only (`akm remember`, `akm import --type`, an env/secret/task create);
 * an asset that is already indexed has a stored conceptId and is never rebuilt
 * from its type.
 */
export function conceptIdFromTypeName(type: string, name: string): string {
  const stashDir = stashDirFor(type);
  return stashDir !== undefined ? `${stashDir}/${name}` : name;
}

/**
 * User-facing conceptId for a file on disk: its ref, the bundle-relative path
 * minus the type's own suffix. The ONE way a diagnostic should spell a ref it
 * expects the user to paste into `akm show`. For a type with no placement spec
 * falls back to the raw path so the output is still informative.
 */
export function conceptIdForStashFile(type: string, stashRoot: string, filePath: string): string {
  return refForFile(type, stashRoot, filePath) ?? filePath;
}

/**
 * Build the USER-FACING / envelope ref string for an indexed item, applying the
 * Chunk-5 flip F4b output-spelling rule (orchestrator decision; ref-grammar
 * decision D-R2 / D-R3). This is the ONE place the rule lives — every emission
 * site calls it instead of hand-building a ref from an entry.
 *
 *   - An item in the **default/primary bundle** (`bundleId` undefined, or equal
 *     to `defaultBundleId`) emits the SHORT conceptId (`knowledge/http-caching`).
 *   - Any other **non-default bundle** emits the fully-qualified
 *     `bundle//conceptId`.
 */
export function displayRef(item: DisplayRefItem, defaultBundleId?: string): string {
  return displayRefForConceptId(item.conceptId, item.bundleId, defaultBundleId);
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

/**
 * The bundle whose items display with the SHORT conceptId: the configured default bundle, else the bundle
 * of the item's own source when that source is the default one. `show` and `feedback` both name an asset
 * by `displayRef` under this rule.
 */
export function displayDefaultBundle(
  configDefault: string | undefined,
  source: { isDefault?: boolean } | undefined,
  bundleId: string | undefined,
): string | undefined {
  return configDefault ?? (source?.isDefault === true ? bundleId : undefined);
}

// ── Placement refs (write by placement) ──────────────────────────────────────

/**
 * Split a conceptId that sits under a type's stash folder (`<stash-subdir>/<name>`)
 * into the placement address it names, or `undefined` when its first folder is no
 * type's stash folder.
 *
 * This is for the commands that WRITE by placement — proposals, improve, clone —
 * which put an asset where its type's placement spec says. A read never uses it:
 * the type of an existing asset is the one its index entry records, so an asset
 * placed anywhere else is simply not addressable by placement and those commands
 * skip or refuse it.
 */
function placementOfConceptId(conceptId: string): { type: string; name: string } | undefined {
  const slash = conceptId.indexOf("/");
  if (slash <= 0) return undefined;
  const type = typeForStashDir(conceptId.slice(0, slash));
  return type === undefined ? undefined : { type, name: conceptId.slice(slash + 1) };
}

/**
 * A conceptId whose first folder is no type's stash folder is still legal data
 * (an OKF item, a website page, a flat skill repo's `domain-name`): `type` carries
 * the leading segment as a passthrough label and `name` the whole conceptId, so
 * a command that must carry the ref along (clone) can hand it to the adapter that
 * owns it. A `:` in the leading segment is the retired `type:name` grammar and is
 * refused. `allowRoot` also accepts a single segment (a ref already qualified).
 */
function opaqueRefParts(conceptId: string, allowRoot = false): AssetRef | undefined {
  const slash = conceptId.indexOf("/");
  if (slash <= 0) return allowRoot && !conceptId.includes(":") ? { type: conceptId, name: conceptId } : undefined;
  const segment = conceptId.slice(0, slash);
  if (segment.includes(":")) return undefined; // retired `type:name` grammar, not opaque data (Q-02).
  const type = placementSpecFor(segment) === undefined ? segment : conceptId;
  return { type, name: conceptId };
}

/**
 * Parse a raw `[bundle//]conceptId` ref into the placement address it names (see
 * {@link placementOfConceptId}); a conceptId outside every type folder parses as
 * the opaque passthrough above. `originGiven`: the caller already split a
 * (non-slug) origin off, so a single segment is qualified.
 */
export function parsePlacementRef(raw: string, originGiven = false): AssetRef {
  const ref = parseBundleRef(raw);
  if (ref.fragment !== undefined) {
    throw new UsageError(
      `Export fragment "#${ref.fragment}" is not accepted here — drop it from "${raw.trim()}".`,
      "INVALID_FLAG_VALUE",
    );
  }
  const parts =
    placementOfConceptId(ref.conceptId) ?? opaqueRefParts(ref.conceptId, originGiven || ref.bundle !== undefined);
  if (parts === undefined) {
    throw new NotFoundError(
      `Unrecognized asset ref "${raw.trim()}": conceptId "${ref.conceptId}" has no known asset-type prefix.`,
      "ASSET_NOT_FOUND",
    );
  }
  return { type: parts.type, name: parts.name, origin: ref.bundle };
}

/** {@link parsePlacementRef} for a ref that may be qualified by a non-slug origin (`github:owner/repo//…`, a path, a URL). */
export function parseQualifiedPlacementRef(raw: string): AssetRef {
  const trimmed = raw.trim();
  const boundary = trimmed.indexOf("//");
  if (boundary > 0) {
    const origin = trimmed.slice(0, boundary);
    if (!isBundleSlug(origin)) return { ...parsePlacementRef(trimmed.slice(boundary + 2), true), origin };
  }
  return parsePlacementRef(trimmed);
}

/** Does `raw` already read as a complete `[bundle//]conceptId` ref, as opposed to a bare name a command prefixes with its type's folder? */
export function isFullRefInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  try {
    const parsed = parseBundleRef(trimmed);
    return parsed.bundle !== undefined || placementOfConceptId(parsed.conceptId) !== undefined;
  } catch {
    return false;
  }
}
