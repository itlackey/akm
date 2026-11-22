// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The mechanics every adapter of a directory bundle shares: its assets are
 * files under the bundle's root. `directoryAdapter` builds a `BundleAdapter`
 * from a format (how files are recognized, validated and placed) and adds the
 * file mechanics: the walk that lists them, the arbitration that reads one by
 * its concept id, and the atomic writes that create, update and retire them.
 */

import fs from "node:fs";
import path from "node:path";
import { buildFileContext, type FileContext } from "../../../indexer/walk/file-context";
import { declaredTypeForPath } from "../../../indexer/walk/matchers";
import { isWalkedFile, walkStashFlatWithStatus } from "../../../indexer/walk/walker";
import { resolveUniqueWorkflowSource } from "../../../workflows/source-files";
import { compareCodePoints, existingFileMode, hasErrnoCode, writeFileAtomic } from "../../common";
import { ConfigError, NotFoundError, UsageError } from "../../errors";
import { sensitiveMarkerPath } from "../../sensitive-marker-path";
import { warnOnce } from "../../warn";
import type {
  AdapterReadCandidate,
  AssetChange,
  AssetReadOptions,
  BundleAdapter,
  BundleAsset,
  NewAsset,
} from "../bundle-adapter";
import type { BundleComponent } from "../types";

/** How a directory format places and serializes the assets it writes. */
export interface DirectoryWrites {
  /** The asset types the adapter writes. */
  types: readonly string[];
  /** The file a new asset of `type` and `name` is kept in, under `c.root`. */
  place(c: BundleComponent, asset: Pick<NewAsset, "type" | "name">): string;
  /** The bytes a file of `type` holds for `content`. Absent: `content` as given. */
  serialize?(type: string, file: string, content: string | Buffer): string | Buffer;
}

/** A directory adapter's format: everything but the file mechanics. */
export type DirectoryFormat = Omit<BundleAdapter, "list" | "read" | "writes" | "create" | "update" | "retire"> & {
  writes?: DirectoryWrites;
};

export abstract class AdapterConceptOwnershipError extends UsageError {}

/** Two files hold one asset, and the operation must not pick one. */
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

/** Build a directory adapter from its format. */
export function directoryAdapter(format: DirectoryFormat): BundleAdapter {
  const { writes, ...rest } = format;
  const adapter: BundleAdapter = {
    ...rest,
    list: (c) => walkStashFlatWithStatus(c.root, walkOptions(format)),
    read: (c, conceptId, options) => readAsset(adapter, c, conceptId, options),
    ...(writes
      ? {
          writes: writes.types,
          create: (c, asset) => createAsset(adapter, writes, c, asset),
          update: (c, conceptId, content) => updateAsset(adapter, writes, c, conceptId, content),
          retire: (c, conceptId) => retireAsset(adapter, c, conceptId),
        }
      : {}),
  };
  return adapter;
}

// ── Reading ─────────────────────────────────────────────────────────────────

function walkOptions(format: Pick<BundleAdapter, "walkMode">) {
  return { includeAllDirectories: format.walkMode === "all-directories" };
}

const CONTENT_READ_REQUIRED = Symbol("adapter ownership probe requires content");

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

function within(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Add case-only suffix spellings beside an adapter-authored read candidate. */
function candidateSpellings(candidate: AdapterReadCandidate, root: string): AdapterReadCandidate[] {
  const authored = path.resolve(candidate.path);
  if (!within(authored, root)) return [{ ...candidate, path: authored }];
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

/** The file a candidate names, when it is a file (or a link to one) inside the bundle. */
function candidateFile(c: BundleComponent, candidatePath: string): FileContext | undefined {
  const authored = path.resolve(candidatePath);
  if (!within(authored, c.root)) return undefined;
  try {
    const stat = fs.lstatSync(authored);
    if (!stat.isFile() && !stat.isSymbolicLink()) return undefined;
    if (!fs.statSync(fs.realpathSync(authored)).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return buildFileContext(c.root, authored);
}

/** Whether the adapter recognizes `file` as `conceptId` from its path alone (an adapter that needs bytes claims it). */
function claimsWithoutContent(
  adapter: BundleAdapter,
  c: BundleComponent,
  file: FileContext,
  conceptId: string,
): boolean {
  let requestedBytes = false;
  const denyBytes = (): never => {
    requestedBytes = true;
    throw CONTENT_READ_REQUIRED;
  };
  try {
    const document = adapter.recognize(c, { ...file, content: denyBytes, frontmatter: denyBytes });
    return requestedBytes || document?.conceptId === conceptId;
  } catch (error) {
    if (error === CONTENT_READ_REQUIRED) return true;
    throw error;
  }
}

/** An env file or secret that a sibling `.sensitive` marker hides from the index. */
function isMarkedSensitive(file: FileContext): boolean {
  const type = declaredTypeForPath(file);
  if (type !== "env" && type !== "secret") return false;
  const marker = sensitiveMarkerPath(file.absPath, type);
  return marker !== file.absPath && fs.existsSync(marker);
}

/**
 * The file that holds `conceptId`, without reading authored bytes: workflow
 * arbitration first, then every spelling `readCandidates` inverts the concept
 * id into (no walk), each probed with a byte-denying context so the adapter's
 * path-level abstention decides.
 */
function readAsset(
  adapter: BundleAdapter,
  c: BundleComponent,
  conceptId: string,
  options?: AssetReadOptions,
): BundleAsset | undefined {
  const normalized = normalizedConceptId(conceptId);
  if (!normalized) return undefined;
  try {
    fs.realpathSync(c.root);
  } catch (error) {
    // A root that is gone holds nothing. Any other failure (EACCES) is not "nothing": say the root is unreadable.
    if (hasErrnoCode(error, "ENOENT")) return undefined;
    throw new ConfigError(`Unable to read bundle directory at "${c.root}".`, "STASH_DIR_UNREADABLE");
  }

  const owners = new Map<string, BundleAsset>();
  const workflowSource = resolveUniqueWorkflowSource(c.root, adapter.id, normalized);
  const resolved = workflowSource ? workflowSource.canonicalName : normalized;
  if (workflowSource) {
    owners.set(path.resolve(workflowSource.path), {
      conceptId: resolved,
      file: buildFileContext(c.root, workflowSource.path),
      workflowSource,
    });
  }

  const spellings = (adapter.readCandidates?.(c, resolved) ?? []).flatMap((candidate) =>
    candidateSpellings(candidate, c.root),
  );
  const candidates = [...new Map(spellings.map((candidate) => [path.resolve(candidate.path), candidate])).values()]
    .filter((candidate) => candidate.conceptId === resolved)
    .sort((left, right) => compareCodePoints(left.path, right.path));
  for (const candidate of candidates) {
    const key = path.resolve(candidate.path);
    if (owners.has(key)) continue;
    const file = candidateFile(c, candidate.path);
    if (!file) continue;
    if (
      claimsWithoutContent(adapter, c, file, resolved) ||
      (options?.includeSensitive === true && isMarkedSensitive(file))
    ) {
      owners.set(key, { conceptId: resolved, file });
    }
  }

  const found = [...owners.values()]
    .sort((left, right) => compareCodePoints(left.file.absPath, right.file.absPath))
    .map((owner) => ({ ...owner, listed: () => isWalkedFile(c.root, owner.file.absPath, walkOptions(adapter)) }));
  if (found.length <= 1) return found[0];
  const relatives = found.map((owner) => owner.file.relPath);
  if (options?.mode !== "read") throw new AdapterConceptCollisionError(adapter.id, resolved, relatives);
  const [winner, ...losers] = relatives;
  warnOnce(
    `adapter-concept-collision:${adapter.id}:${resolved}`,
    `Adapter "${adapter.id}" has multiple physical owners for "${resolved}": ${relatives.join(", ")}. ` +
      `Reading "${winner}" and ignoring ${losers.join(", ")}.`,
  );
  return found[0];
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Refuse a write to `file` that leaves the bundle's root, or passes through a
 * symbolic link below it: a write never follows a link out of the bundle.
 */
export function assertWritableFile(root: string, bundle: string, file: string): void {
  const lexicalRoot = path.resolve(root);
  const relative = path.relative(lexicalRoot, path.resolve(file));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new UsageError(`Write path resolves outside source "${bundle}".`, "PATH_ESCAPE_VIOLATION");
  }
  let current = lexicalRoot;
  try {
    current = fs.realpathSync(lexicalRoot);
  } catch {
    // A root that is not there yet holds no link to follow.
  }
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new UsageError(`Write path contains a symbolic link below source "${bundle}": ${relative}`);
    }
  }
}

/** The bytes and file mode a write gives a file. Env files and secrets are readable by their owner only. */
function writeFile(
  writes: DirectoryWrites,
  c: BundleComponent,
  type: string,
  file: string,
  content: string | Buffer,
): void {
  assertWritableFile(c.root, c.id, file);
  const bytes = writes.serialize ? writes.serialize(type, file, content) : content;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mode = type === "env" || type === "secret" ? 0o600 : existingFileMode(file);
  // Atomic: a crash or a full disk never leaves a half-written asset where a good one was.
  writeFileAtomic(file, bytes, mode);
}

function createAsset(
  adapter: BundleAdapter,
  writes: DirectoryWrites,
  c: BundleComponent,
  asset: NewAsset,
): AssetChange {
  if (!writes.types.includes(asset.type)) {
    throw new UsageError(`Bundle "${c.id}" (adapter "${adapter.id}") does not hold ${asset.type} assets.`);
  }
  const file = writes.place(c, asset);
  const entry = buildFileContext(c.root, file);
  const conceptId = adapter.recognize(c, { ...entry, content: () => String(asset.content) })?.conceptId;
  writeFile(writes, c, asset.type, file, asset.content);
  const changed = [file];
  if (asset.sensitive) {
    // A sibling marker keeps an env file or secret out of the index and listings.
    const marker = sensitiveMarkerPath(file, asset.type === "env" ? "env" : "secret");
    if (marker === file) throw new UsageError(`A ${asset.type} asset cannot be marked sensitive.`);
    if (!fs.existsSync(marker)) writeFileAtomic(marker, "", 0o600);
    changed.push(marker);
  }
  return { conceptId: conceptId ?? entry.relPath, path: file, changed };
}

function existing(adapter: BundleAdapter, c: BundleComponent, conceptId: string): BundleAsset {
  const found = readAsset(adapter, c, conceptId, { includeSensitive: true });
  if (!found) throw new NotFoundError(`Asset not found: ${c.id}//${conceptId}`);
  return found;
}

function updateAsset(
  adapter: BundleAdapter,
  writes: DirectoryWrites,
  c: BundleComponent,
  conceptId: string,
  content: string | Buffer,
): AssetChange {
  const { file } = existing(adapter, c, conceptId);
  const type = declaredTypeForPath(file) ?? adapter.recognize(c, file)?.type ?? "";
  writeFile(writes, c, type, file.absPath, content);
  return { conceptId, path: file.absPath, changed: [file.absPath] };
}

function retireAsset(adapter: BundleAdapter, c: BundleComponent, conceptId: string): AssetChange {
  const { file } = existing(adapter, c, conceptId);
  assertWritableFile(c.root, c.id, file.absPath);
  const changed = [file.absPath];
  fs.rmSync(file.absPath);
  // An env file's or secret's `.sensitive` marker goes with it.
  const type = declaredTypeForPath(file);
  const marker = type === "env" || type === "secret" ? sensitiveMarkerPath(file.absPath, type) : file.absPath;
  if (marker !== file.absPath && fs.existsSync(marker)) {
    fs.rmSync(marker);
    changed.push(marker);
  }
  return { conceptId, path: file.absPath, changed };
}
