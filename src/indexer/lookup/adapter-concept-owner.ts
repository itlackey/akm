// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import type { AssetReadOptions, BundleAsset } from "../../core/adapter/bundle-adapter";
import { detectAdapterId } from "../../core/adapter/detect-adapter";
import { adapterForId, componentOf } from "../../core/adapter/registry";
import { assetPathForName, stashDirFor, stashDirNames } from "../../core/asset/asset-placement";
import { type BundleRef, parseBundleRef } from "../../core/asset/asset-ref";
import { type AssetRef, parsePlacementRef } from "../../core/asset/resolve-ref";
import { safeRealpath } from "../../core/common";
import { warnOnce } from "../../core/warn";
import { withMdVariants } from "../../storage/repositories/index-entries-repository";
import type { WorkflowSourceFile } from "../../workflows/source-files";
import type { IndexEntry } from "../indexer";
import { deriveEntryProvenance, deriveInstallations } from "../installations";
import type { SearchSource } from "../search/search-source";
import type { FileContext } from "../walk/file-context";
import { declaredTypeForPath } from "../walk/matchers";

export {
  AdapterConceptCollisionError,
  AdapterConceptOwnershipError,
} from "../../core/adapter/adapters/directory-assets";

/** The asset a bundle's adapter read for a ref: where it is indexed, and the entry holding it. */
export interface AdapterConceptOwner {
  /** The path the asset is indexed under. */
  path: string;
  /** Resolved path used only for containment and identity checks. */
  realPath: string;
  conceptId: string;
  adapterId: string;
  workflowSource?: WorkflowSourceFile;
  /** The entry holding the asset, as its adapter gives it. */
  file: FileContext;
  /** Whether the adapter lists the asset (indexes it). */
  listed(): boolean;
}

export type ResolveAdapterConceptOwnerOptions = AssetReadOptions;

function ownerOf(adapterId: string, asset: BundleAsset): AdapterConceptOwner {
  return {
    path: asset.file.absPath,
    realPath: asset.workflowSource?.realPath ?? safeRealpath(asset.file.absPath),
    conceptId: asset.conceptId,
    adapterId,
    ...(asset.workflowSource ? { workflowSource: asset.workflowSource } : {}),
    file: asset.file,
    listed: () => asset.listed?.() ?? true,
  };
}

/** The asset `conceptId` names in one bundle, as the bundle's adapter reads it. */
export function readBundleAsset(
  source: Pick<SearchSource, "path" | "location">,
  adapterId: string,
  conceptId: string,
  options?: ResolveAdapterConceptOwnerOptions,
): AdapterConceptOwner | undefined {
  const adapter = adapterForId(adapterId);
  const asset = adapter?.read(componentOf(source, adapterId), conceptId, options);
  return asset && ownerOf(adapterId, asset);
}

/** The asset `conceptId` names in the bundle at `sourcePath`, read by the adapter `adapterId`. */
export function resolveAdapterConceptOwner(
  sourcePath: string,
  adapterId: string,
  conceptId: string,
  options?: ResolveAdapterConceptOwnerOptions,
): AdapterConceptOwner | undefined {
  return readBundleAsset({ path: sourcePath }, adapterId, conceptId, options);
}

export interface ConceptOwnerMatch {
  owner: AdapterConceptOwner;
  /** The source that owns the file. */
  source: SearchSource;
  /** The owning bundle's id, derived over the whole ordered source list. */
  bundleId: string;
  adapterId: string;
}

/**
 * The index entry the owning file and its adapter give without the index: the adapter's own recognition of
 * the file, so `show` serves it though no row exists. Undefined when the walk would not list the file (a
 * skipped or ignored directory, a symlinked one, ...: it is not in the bundle as far as the index goes) or the
 * adapter does not recognise it, or when the ref is not the concept ID the index would key the file under, up to its
 * `.md` (a file-name spelling such as `tasks/nightly.yml`): an index miss refuses that spelling, so does this. It has
 * no links, usage or indexed fragments.
 */
export function entryFromFiles(match: ConceptOwnerMatch): IndexEntry | undefined {
  const { owner, source, bundleId, adapterId } = match;
  try {
    const adapter = adapterForId(adapterId);
    if (!adapter || !owner.listed()) return undefined;
    const document = adapter.recognize(componentOf(source, adapterId), owner.file);
    if (!document?.conceptId || !withMdVariants(owner.conceptId).includes(document.conceptId)) return undefined;
    const { itemRef, conceptId } = deriveEntryProvenance(
      { bundleId, componentId: adapterId, adapterId },
      document.type,
      document.name,
      document.conceptId,
    );
    return {
      filePath: owner.path,
      stashDir: source.path,
      type: document.type,
      name: document.name,
      adapterId,
      document,
      itemRef,
      bundleId,
      conceptId,
    };
  } catch {
    // An unreadable file is not found from files.
    return undefined;
  }
}

/**
 * The one "where is asset X right now?" walk. `sources` is the ordered source
 * list (`resolveSourceEntries`: default bundle first, then installation
 * priority). The first source with a physical owner for the ref ends the
 * walk; a qualified ref only considers its own bundle. Synchronous and
 * index-free: it never opens a database, so a caller may use it at dispatch.
 */
export function resolveConceptOwner(
  ref: BundleRef,
  sources: readonly SearchSource[],
  options?: ResolveAdapterConceptOwnerOptions,
): ConceptOwnerMatch | undefined {
  const found = ownerAmong(ref, sources, options);
  if (found) return found;
  const current = withoutTypeHead(ref.conceptId);
  const legacy = current === undefined ? undefined : ownerAmong({ ...ref, conceptId: current }, sources, options);
  if (legacy) warnOutdatedRef(ref.conceptId, current!);
  return legacy;
}

/**
 * The conceptId `ref` names now, for a lookup of stored rows: the owning
 * file's, so an old spelling maps to the asset's ref with one warning; as
 * written when no file owns it.
 */
export function currentConceptId(ref: BundleRef, sources: readonly SearchSource[]): string {
  return resolveConceptOwner(ref, sources, { mode: "read" })?.owner.conceptId ?? ref.conceptId;
}

/**
 * Releases before path refs prefixed a loose file's ref with its type folder
 * (`knowledge/reports/x` for `reports/x.md`), and that spelling is still in
 * links, memories, scripts and stored proposals. A ref that misses is retried
 * without that head: this is the head-less ref, or undefined when it has none.
 */
export function withoutTypeHead(conceptId: string): string | undefined {
  const slash = conceptId.indexOf("/");
  if (slash <= 0 || !stashDirNames().includes(conceptId.slice(0, slash))) return undefined;
  return conceptId.slice(slash + 1);
}

function warnOutdatedRef(outdated: string, current: string): void {
  warnOnce(
    `outdated-ref:${outdated}`,
    `Ref "${outdated}" is outdated: refs are the path inside the bundle, so it is now "${current}". Resolved it to that asset.`,
  );
}

function ownerAmong(
  ref: BundleRef,
  sources: readonly SearchSource[],
  options?: ResolveAdapterConceptOwnerOptions,
): ConceptOwnerMatch | undefined {
  const installations = deriveInstallations([...sources]);
  for (const [index, source] of sources.entries()) {
    const bundleId = installations[index]?.id;
    if (!bundleId || (ref.bundle !== undefined && bundleId !== ref.bundle)) continue;
    const adapterId = source.adapterId ?? detectAdapterId(source.path);
    const owner = readBundleAsset(source, adapterId, ref.conceptId, options);
    if (owner) return { owner, source, bundleId, adapterId };
  }
  return undefined;
}

export function indexedPathMatchesOwner(indexedPath: string, owner: AdapterConceptOwner): boolean {
  if (path.resolve(indexedPath) !== path.resolve(owner.path)) return false;
  // The owner was found, so its entry exists; an entry that is no file resolves to its own path.
  return safeRealpath(indexedPath) === path.resolve(owner.realPath);
}

/**
 * The type of the asset a match owns, from its file: what the owner's adapter
 * recognizes it as, else what its location declares (a `.sensitive` env or
 * secret is not recognized). An existing asset's type is never read from its
 * ref's first folder.
 */
export function ownedAssetType(
  match: Pick<ConceptOwnerMatch, "owner" | "adapterId"> & { root: string; location?: string },
): string | undefined {
  const { file } = match.owner;
  const component = componentOf({ path: match.root, location: match.location }, match.adapterId);
  return adapterForId(match.adapterId)?.recognize(component, file)?.type ?? declaredTypeForPath(file);
}

/** The type of the asset a ref names, from the file that owns it among `sources`; undefined when none does. */
export function resolveOwnedType(
  ref: BundleRef,
  sources: readonly SearchSource[],
  options?: ResolveAdapterConceptOwnerOptions,
): string | undefined {
  const match = resolveConceptOwner(ref, sources, options);
  return match && ownedAssetType({ root: match.source.path, owner: match.owner, adapterId: match.adapterId });
}

/** Where a write to an asset goes: its type and name, its ref, and its file. */
export interface WriteAddress extends AssetRef {
  conceptId: string;
  /** Undefined only for a new asset of a type that places nowhere. */
  path: string | undefined;
}

/**
 * The address a write to `raw` uses in the akm bundle at `root`. An asset that
 * exists is addressed by its ref, the path, wherever its file sits, and takes
 * its type from that file; its ref in the outdated type-folder spelling finds
 * it too, with a warning. Only a new asset is placed: its ref's first folder
 * names the type whose folder it goes in.
 */
export function resolveWriteAddress(root: string, raw: string): WriteAddress {
  const { bundle, conceptId: asWritten, fragment } = parseBundleRef(raw);
  let conceptId = asWritten;
  let owner = fragment === undefined ? resolveAdapterConceptOwner(root, "akm", conceptId, { mode: "read" }) : undefined;
  const current = fragment === undefined && !owner ? withoutTypeHead(asWritten) : undefined;
  if (current !== undefined) {
    owner = resolveAdapterConceptOwner(root, "akm", current, { mode: "read" });
    if (owner) {
      warnOutdatedRef(asWritten, current);
      conceptId = current;
    }
  }
  const type = owner && ownedAssetType({ root, owner, adapterId: "akm" });
  if (owner && type) {
    const typeDir = stashDirFor(type);
    const name = conceptId.startsWith(`${typeDir}/`) ? conceptId.slice(`${typeDir}/`.length) : conceptId;
    return { type, name, origin: bundle, conceptId, path: owner.path };
  }
  const placed = parsePlacementRef(raw);
  const typeDir = stashDirFor(placed.type);
  return {
    ...placed,
    conceptId,
    path: typeDir === undefined ? undefined : assetPathForName(placed.type, path.join(root, typeDir), placed.name),
  };
}
