// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Proposal records written by an older akm, as the current shape.
 *
 * A record named files: `changes[].path/after`, `proposedTarget.root`, `acceptedTarget.root/path` (§0.2 P5). It names
 * assets by ref now: `changes[].ref/content`, `proposedTarget.source`, `acceptedTarget.bundle/ref`. The proposals
 * repository reads an old record through {@link convertLegacyProposalMetadata} and says so once per command; `akm
 * migrate apply` writes the converted record back (`proposal-records`). The state opener never rewrites one.
 *
 * The bundle an old record named is its `proposedTarget.source` when that is configured, else the bundle whose root
 * the record stored (a proposal made with `--dir` named the invented bundle `stash`, §0.2 P9). A path becomes a ref
 * through `legacyRefOf`; one that names no asset (or a record whose bundle is gone) takes the proposal's own ref.
 */

import path from "node:path";
import { legacyRefOf } from "../../core/assets/write";
import { deriveBundleIds } from "../../core/bundle-id";
import { safeRealpath } from "../../core/common";
import { loadConfig } from "../../core/config/config";
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
  return isRecord(accepted) && ("root" in accepted || "path" in accepted || "source" in accepted);
}

interface ConfiguredBundle {
  id: string;
  source: SearchSource;
}

let cached: { config: unknown; bundles: ConfiguredBundle[] } | undefined;

/**
 * The configured bundles, in order, as the proposal queue sees them; none when the config cannot be read. Computed
 * once for a loaded config (a command's reads share it), and only a record of the old shape asks.
 */
function configuredBundles(): ConfiguredBundle[] {
  try {
    const config = loadConfig();
    if (cached?.config === config) return cached.bundles;
    const sources = resolveSourceEntries(undefined, config);
    const ids = deriveBundleIds(sources);
    const bundles = sources.map((source, index) => ({ id: ids[index] as string, source }));
    cached = { config, bundles };
    return bundles;
  } catch (error) {
    rethrowIfTestIsolationError(error);
    return [];
  }
}

function sameRoot(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right) || safeRealpath(left) === safeRealpath(right);
}

/** The bundle a stored `(source, root)` names: the configured bundle called `source`, else the one at `root`. */
function bundleOfRecord(bundles: ConfiguredBundle[], name: unknown, root: unknown): ConfiguredBundle | undefined {
  const named = typeof name === "string" ? bundles.find((bundle) => bundle.id === name) : undefined;
  if (named) return named;
  return typeof root === "string" ? bundles.find((bundle) => sameRoot(bundle.source.path, root)) : undefined;
}

function refOfPath(bundle: ConfiguredBundle | undefined, root: unknown, file: string, fallback: string): string {
  if (!bundle) return fallback;
  const relPath = path.isAbsolute(file)
    ? path.relative(typeof root === "string" ? root : bundle.source.path, file)
    : file;
  const found = legacyRefOf(
    {
      name: bundle.id,
      path: bundle.source.path,
      ...(bundle.source.adapterId !== undefined ? { adapterId: bundle.source.adapterId } : {}),
      ...(bundle.source.location !== undefined ? { location: bundle.source.location } : {}),
    },
    relPath.split(path.sep).join("/"),
  );
  return found ?? fallback;
}

/**
 * `meta` in the current shape, and whether it was old. A record already current comes back as given. Fields that are
 * not recognised are left as they are: the repository's own checks refuse a malformed record, as they always did.
 */
export function convertLegacyProposalMetadata(
  meta: Meta,
  proposalRef: string,
  given?: ConfiguredBundle[],
): { meta: Meta; legacy: boolean } {
  if (!isLegacyProposalMetadata(meta)) return { meta, legacy: false };
  const bundles = given ?? configuredBundles();
  const out: Meta = { ...meta };
  const proposed = isRecord(meta.proposedTarget) ? meta.proposedTarget : undefined;
  const accepted = isRecord(meta.acceptedTarget) ? meta.acceptedTarget : undefined;
  const target = proposed ? bundleOfRecord(bundles, proposed.source, proposed.root) : undefined;
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
    const bundle = bundleOfRecord(bundles, accepted.source, accepted.root) ?? target;
    out.acceptedTarget = {
      bundle: bundle?.id ?? accepted.source,
      ref:
        typeof accepted.path === "string"
          ? refOfPath(bundle, accepted.root, accepted.path, proposalRef)
          : (accepted.ref ?? proposalRef),
      contentHash: accepted.contentHash,
    };
  }
  return { meta: out, legacy: true };
}

/** Say once per command that a record of an older shape was read as converted. */
export function warnLegacyProposalRecords(): void {
  warnOnce("legacy-proposal-records", LEGACY_PROPOSAL_RECORDS_WARNING);
}
