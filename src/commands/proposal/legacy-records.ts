// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Proposal records written by an older akm, as the current shape.
 *
 * A record named files: `changes[].path/after`, `proposedTarget.root`, `acceptedTarget.root/path`,
 * `retireAcceptIntent.assetPath` and `retiredArchive.dirs` (§0.2 P5). It names assets by ref and retirements by handle
 * now: `changes[].ref/content`, `proposedTarget.source`, `acceptedTarget.bundle/ref`, `retiredArchive.retired[]`
 * (`{ ref, handle }`; a handle is the directory the old record named, kept as written). The proposals
 * repository reads an old record through {@link convertLegacyProposalMetadata} and says so once per command; `akm
 * migrate apply` writes the converted record back (`proposal-records`). The state opener never rewrites one.
 *
 * The bundle an old record named is its `proposedTarget.source` when that is configured, else the bundle whose root
 * the record stored (a proposal made with `--dir` named the invented bundle `stash`, §0.2 P9). A path becomes a ref
 * through `legacyRefOf`; one that names no asset (or a record whose bundle is gone) takes the proposal's own ref. A
 * retirement's ref is the accepted target's: a retire accept archives each file under the proposal's ref, so a
 * tombstone holds nothing more to read.
 */

import path from "node:path";
import { legacyRefOf } from "../../core/assets/write";
import { type AkmConfig, loadConfig } from "../../core/config/config";
import { bundleAtDir } from "../../core/config/config-sources";
import { rethrowIfTestIsolationError } from "../../core/errors";
import { warnOnce } from "../../core/warn";
import { resolveSourceEntries, type SearchSource } from "../../indexer/search/search-source";

/** What a command says once when it reads an old record. */
export const LEGACY_PROPOSAL_RECORDS_WARNING =
  "Proposals in state.db were written by an older akm and are read as converted; run `akm migrate apply` to rewrite them.";

type Meta = Record<string, unknown>;

function isRecord(value: unknown): value is Meta {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `meta` (a row's `metadata_json`) holds a file-naming field of the old shape. */
export function isLegacyProposalMetadata(meta: Meta): boolean {
  if (Array.isArray(meta.changes) && meta.changes.some((change) => isRecord(change) && "path" in change)) return true;
  const proposed = meta.proposedTarget;
  if (isRecord(proposed) && "root" in proposed) return true;
  const accepted = meta.acceptedTarget;
  if (isRecord(accepted) && ("root" in accepted || "path" in accepted || "source" in accepted)) return true;
  return (
    (isRecord(meta.retireAcceptIntent) && "assetPath" in meta.retireAcceptIntent) ||
    (isRecord(meta.retiredArchive) && "dirs" in meta.retiredArchive)
  );
}

/** The configured bundles a record can name, found by id and, for a stored root, by `bundleAtDir`. */
interface RecordBundles {
  /** The bundle a stored `(source, root)` names: the configured bundle called `source`, else the one at `root`. */
  of(name: unknown, root: unknown): ConfiguredBundle | undefined;
}

interface ConfiguredBundle {
  id: string;
  source: SearchSource | undefined;
}

const sourcesOf = new WeakMap<AkmConfig, SearchSource[]>();

/** The bundles of the loaded config (its sources are resolved once per loaded config); none when it cannot be read. */
function recordBundles(): RecordBundles {
  let config: AkmConfig | undefined;
  try {
    config = loadConfig();
  } catch (error) {
    rethrowIfTestIsolationError(error);
  }
  const found = (id: string): ConfiguredBundle => {
    if (!config) return { id, source: undefined };
    let sources = sourcesOf.get(config);
    if (!sources) {
      try {
        sources = resolveSourceEntries(undefined, config);
      } catch (error) {
        // A config whose sources cannot be resolved (a disabled working bundle) converts no record; nothing is cached.
        rethrowIfTestIsolationError(error);
        return { id, source: undefined };
      }
      sourcesOf.set(config, sources);
    }
    return { id, source: sources.find((source) => source.registryId === id) };
  };
  return {
    of(name, root) {
      if (!config) return undefined;
      if (typeof name === "string" && config.bundles?.[name] !== undefined) return found(name);
      const id = typeof root === "string" ? bundleAtDir(config, root) : undefined;
      return id === undefined ? undefined : found(id);
    },
  };
}

function refOfPath(bundle: ConfiguredBundle | undefined, root: unknown, file: string, fallback: string): string {
  if (!bundle?.source) return fallback;
  const relPath = path.isAbsolute(file)
    ? path.relative(typeof root === "string" ? root : bundle.source.path, file)
    : file;
  const found = legacyRefOf(bundle.id, relPath.split(path.sep).join("/"));
  return found ?? fallback;
}

/**
 * `meta` in the current shape, and whether it was old. A record already current comes back as given. Fields that are
 * not recognised are left as they are: the repository's own checks refuse a malformed record, as they always did.
 */
export function convertLegacyProposalMetadata(meta: Meta, proposalRef: string): { meta: Meta; legacy: boolean } {
  if (!isLegacyProposalMetadata(meta)) return { meta, legacy: false };
  const bundles = recordBundles();
  const out: Meta = { ...meta };
  const proposed = isRecord(meta.proposedTarget) ? meta.proposedTarget : undefined;
  const accepted = isRecord(meta.acceptedTarget) ? meta.acceptedTarget : undefined;
  const target = proposed ? bundles.of(proposed.source, proposed.root) : undefined;
  const bundleName = target?.id ?? (typeof proposed?.source === "string" ? proposed.source : undefined);
  if (proposed) out.proposedTarget = { source: bundleName ?? proposed.source };
  if (Array.isArray(meta.changes)) {
    out.changes = meta.changes.map((change) => {
      if (!isRecord(change) || typeof change.path !== "string") return change;
      const { path: file, after, ...rest } = change;
      return {
        ...rest,
        ref: refOfPath(target, proposed?.root, file, proposalRef),
        ...(after !== undefined ? { content: after } : {}),
      };
    });
  }
  if (accepted) {
    const bundle = bundles.of(accepted.source, accepted.root) ?? target;
    out.acceptedTarget = {
      bundle: bundle?.id ?? accepted.source,
      ref:
        typeof accepted.path === "string"
          ? refOfPath(bundle, accepted.root, accepted.path, proposalRef)
          : (accepted.ref ?? proposalRef),
      contentHash: accepted.contentHash,
    };
  }
  const intent = meta.retireAcceptIntent;
  if (isRecord(intent) && "assetPath" in intent) {
    const { assetPath: _file, ...rest } = intent;
    out.retireAcceptIntent = rest;
  }
  const archive = meta.retiredArchive;
  if (isRecord(archive) && Array.isArray(archive.dirs)) {
    const ref =
      isRecord(out.acceptedTarget) && typeof out.acceptedTarget.ref === "string" ? out.acceptedTarget.ref : proposalRef;
    out.retiredArchive = { retired: archive.dirs.map((handle) => ({ ref, handle })) };
  }
  return { meta: out, legacy: true };
}

/** Say once per command that a record of an older shape was read as converted. */
export function warnLegacyProposalRecords(): void {
  warnOnce("legacy-proposal-records", LEGACY_PROPOSAL_RECORDS_WARNING);
}
