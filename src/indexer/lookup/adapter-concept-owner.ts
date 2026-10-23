// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import type { AdapterReadCandidate, BundleAdapter } from "../../core/adapter/bundle-adapter";
import { adapterForId } from "../../core/adapter/registry";
import type { BundleComponent } from "../../core/adapter/types";
import { compareCodePoints, hasErrnoCode } from "../../core/common";
import { ConfigError, UsageError } from "../../core/errors";
import { canonicalizeWorkflowName } from "../../core/recognition-util";
import { warnOnce } from "../../core/warn";
import {
  resolveUniqueWorkflowSource,
  type WorkflowSourceFile,
  workflowNameForConceptId,
} from "../../workflows/source-files";
import { buildFileContext, type FileContext } from "../walk/file-context";

const CONTENT_READ_REQUIRED = Symbol("adapter ownership probe requires content");

export interface AdapterConceptOwner {
  /** Authored path spelling used by index/show/runtime provenance. */
  path: string;
  /** Resolved path used only for containment and identity checks. */
  realPath: string;
  conceptId: string;
  adapterId: string;
  workflowSource?: WorkflowSourceFile;
}

export abstract class AdapterConceptOwnershipError extends UsageError {}

export class AdapterConceptCollisionError extends AdapterConceptOwnershipError {
  constructor(adapterId: string, conceptId: string, paths: readonly string[]) {
    const sorted = [...paths].sort(compareCodePoints);
    super(
      `Adapter "${adapterId}" has multiple physical owners for "${conceptId}": ${sorted.join(", ")}.`,
      "RESOURCE_ALREADY_EXISTS",
    );
    this.name = "AdapterConceptCollisionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function normalizedConceptId(conceptId: string): string | undefined {
  const normalized = conceptId.replaceAll("\\", "/");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.normalize(normalized) !== normalized
  ) {
    return undefined;
  }
  return normalized;
}

function componentFor(sourcePath: string, adapterId: string): BundleComponent {
  return { id: adapterId, adapter: adapterId, root: sourcePath, writable: false };
}

function lexicallyWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Add case-only suffix spellings beside an adapter-authored read candidate. */
function candidateSpellings(candidate: AdapterReadCandidate, sourcePath: string): AdapterReadCandidate[] {
  const authored = path.resolve(candidate.path);
  if (!lexicallyWithin(authored, sourcePath)) return [{ ...candidate, path: authored }];
  const parent = path.dirname(authored);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [{ ...candidate, path: authored }];
  }

  const extension = path.extname(authored);
  if (!extension) return [{ ...candidate, path: authored }];
  const stem = path.basename(authored, extension);
  return entries
    .filter((entry) => {
      const entryExtension = path.extname(entry.name);
      return (
        path.basename(entry.name, entryExtension) === stem && entryExtension.toLowerCase() === extension.toLowerCase()
      );
    })
    .map((entry) => ({ ...candidate, path: path.join(parent, entry.name) }));
}

function inspectCandidate(
  sourcePath: string,
  adapterId: string,
  candidate: AdapterReadCandidate,
): AdapterConceptOwner | undefined {
  const authoredPath = path.resolve(candidate.path);
  if (!lexicallyWithin(authoredPath, sourcePath)) return undefined;
  let authoredStat: fs.Stats;
  try {
    authoredStat = fs.lstatSync(authoredPath);
  } catch {
    return undefined;
  }
  if (!authoredStat.isFile() && !authoredStat.isSymbolicLink()) return undefined;

  let realPath: string;
  try {
    realPath = fs.realpathSync(authoredPath);
  } catch {
    return undefined;
  }
  try {
    if (!fs.statSync(realPath).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return { path: authoredPath, realPath, conceptId: candidate.conceptId, adapterId };
}

function claimsWithoutContent(adapter: BundleAdapter, component: BundleComponent, owner: AdapterConceptOwner): boolean {
  const file = buildFileContext(component.root, owner.path);
  let requestedBytes = false;
  const denyBytes = (): never => {
    requestedBytes = true;
    throw CONTENT_READ_REQUIRED;
  };
  const noContentFile: FileContext = { ...file, content: denyBytes, frontmatter: denyBytes };
  try {
    const document = adapter.recognize(component, noContentFile);
    if (requestedBytes) return true;
    return document?.conceptId === owner.conceptId;
  } catch (error) {
    if (error === CONTENT_READ_REQUIRED) return true;
    throw error;
  }
}

export interface ResolveAdapterConceptOwnerOptions {
  mode?: "read" | "write";
}

/**
 * Resolve one adapter/component's exact physical concept owner without reading
 * authored bytes. Native workflow arbitration is reused verbatim; every other
 * adapter supplies its own read placements and is probed with a byte-denying
 * FileContext so path-level abstention remains authoritative.
 */
export function resolveAdapterConceptOwner(
  sourcePath: string,
  adapterId: string,
  conceptId: string,
  options?: ResolveAdapterConceptOwnerOptions,
): AdapterConceptOwner | undefined {
  const adapter = adapterForId(adapterId);
  const normalized = normalizedConceptId(conceptId);
  if (!adapter || !normalized) return undefined;

  try {
    fs.realpathSync(sourcePath);
  } catch (error) {
    // Genuinely absent — "no owner" is correct. Any other failure (e.g.
    // EACCES) is not "doesn't exist"; treating it as such would report a
    // legitimate bundle root as owning nothing instead of raising the
    // unreadable-directory error.
    if (hasErrnoCode(error, "ENOENT")) return undefined;
    throw new ConfigError(`Unable to read bundle directory at "${sourcePath}".`, "STASH_DIR_UNREADABLE");
  }

  const component = componentFor(sourcePath, adapterId);
  const ownersByIdentity = new Map<string, AdapterConceptOwner>();

  const workflowName = workflowNameForConceptId(adapterId, normalized);
  const resolutionConceptId =
    workflowName === undefined
      ? normalized
      : adapterId === "akm"
        ? `workflows/${canonicalizeWorkflowName(workflowName)}`
        : canonicalizeWorkflowName(workflowName);
  if (workflowName !== undefined) {
    const workflowSource = resolveUniqueWorkflowSource(sourcePath, adapterId, workflowName);
    if (workflowSource) {
      const workflowOwner = {
        path: workflowSource.path,
        realPath: workflowSource.realPath,
        conceptId: resolutionConceptId,
        adapterId,
        workflowSource,
      };
      ownersByIdentity.set(`${path.resolve(workflowOwner.path)}\0${resolutionConceptId}`, workflowOwner);
    }
  }

  // Closed-form candidate set (#857): `readCandidates` inverts the conceptId
  // directly into every physical spelling that could own it (no bundle walk
  // — see each adapter's own doc comment for its candidate classes), and
  // `candidateSpellings` adds case-only siblings via one `readdirSync` of
  // each candidate's own parent directory.
  const spellings = (adapter.readCandidates?.(component, resolutionConceptId) ?? []).flatMap((candidate) =>
    candidateSpellings(candidate, sourcePath),
  );
  const inspected = [
    ...new Map(
      spellings.map((candidate) => [`${path.resolve(candidate.path)}\0${candidate.conceptId}`, candidate]),
    ).values(),
  ]
    .sort((left, right) => compareCodePoints(left.path, right.path))
    .flatMap((candidate) => {
      const owner = inspectCandidate(sourcePath, adapterId, candidate);
      return owner ? [owner] : [];
    });
  for (const candidate of inspected) {
    if (candidate.conceptId !== resolutionConceptId) continue;
    const identity = `${path.resolve(candidate.path)}\0${candidate.conceptId}`;
    if (ownersByIdentity.has(identity)) continue;
    if (claimsWithoutContent(adapter, component, candidate)) ownersByIdentity.set(identity, candidate);
  }
  const owners = [...ownersByIdentity.values()]
    .filter((owner) => owner.conceptId === resolutionConceptId)
    .sort((left, right) => compareCodePoints(left.path, right.path));
  if (owners.length > 1) {
    if (options?.mode !== "read") {
      throw new AdapterConceptCollisionError(
        adapterId,
        resolutionConceptId,
        owners.map((owner) => path.relative(sourcePath, owner.path).replaceAll("\\", "/")),
      );
    }
    const [winner, ...losers] = owners;
    warnOnce(
      `adapter-concept-collision:${adapterId}:${resolutionConceptId}`,
      `Adapter "${adapterId}" has multiple physical owners for "${resolutionConceptId}": ` +
        `${owners.map((owner) => path.relative(sourcePath, owner.path).replaceAll("\\", "/")).join(", ")}. ` +
        `Reading "${path.relative(sourcePath, winner!.path).replaceAll("\\", "/")}" and ignoring ` +
        `${losers.map((owner) => path.relative(sourcePath, owner.path).replaceAll("\\", "/")).join(", ")}.`,
    );
    return winner;
  }
  return owners[0];
}

export function indexedPathMatchesOwner(indexedPath: string, owner: AdapterConceptOwner): boolean {
  if (path.resolve(indexedPath) !== path.resolve(owner.path)) return false;
  try {
    return path.resolve(fs.realpathSync(indexedPath)) === path.resolve(owner.realPath);
  } catch {
    return false;
  }
}
