// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The mechanics every adapter of a directory bundle shares: its assets are
 * files under the bundle's root. `DirectoryAdapterBase` implements every
 * `BundleAdapter` member once, as template methods: the walk that lists the
 * files, the arbitration that reads one by its concept id, and the atomic
 * writes that create, update and delete them. A subclass supplies the format
 * through the hooks below (how a file is recognized, validated and placed) and
 * does not override the template methods.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AdapterRenderedExecutionSource } from "../../execution/source";
import { buildFileContext, type FileContext, fileContextOfEntry } from "../../indexer/walk/file-context";
import { isWalkedFile, walkStashFlatWithStatus } from "../../indexer/walk/walker";
import { resolveUniqueWorkflowSource } from "../../workflows/source-files";
import { compareCodePoints, existingFileMode, hasErrnoCode, writeFileAtomic } from "../common";
import { ConfigError, NotFoundError, UsageError } from "../errors";
import type { FileChange } from "../file-change";
import { warnOnce } from "../warn";
import type {
  AdapterReadCandidate,
  AssetChange,
  AssetEntry,
  AssetReadOptions,
  AssetResource,
  BundleAdapter,
  BundleAsset,
  BundleListing,
  NewAsset,
} from "./bundle-adapter";
import type { Bundle, Diagnostic, IndexDocument, ValidateContext } from "./types";

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

const CONTENT_READ_REQUIRED = Symbol("adapter ownership probe requires content");

export abstract class DirectoryAdapterBase implements BundleAdapter {
  abstract readonly id: string;
  /** Feeds incrementality and fingerprints. */
  abstract readonly version: string;
  /** The asset types it writes. Empty: read-only. */
  readonly writes: readonly string[] = [];
  /** Recognized extensions, a hint for the walk. Recognition, not this list, says what an asset is. */
  readonly extensions: readonly string[] = [];
  /**
   * How the bundle is listed. `"akm"`: the akm-bundle walk (skips dot-directories, `bin/`, `.cache/`; lists
   * git-ignored `env/` and `secrets/` files). `"all-directories"`: every directory except `.git` and `node_modules`.
   */
  protected readonly walkMode: "akm" | "all-directories" = "akm";

  // ── Hooks a subclass supplies ───────────────────────────────────────────────

  /** The index document for one file, or null when the file is no asset. */
  protected abstract recognizeFile(b: Bundle, file: FileContext): IndexDocument | null;
  /**
   * Every file any placement could give `conceptId` (no walk). Each carries that identity, so `read` arbitrates
   * without reading authored bytes; recognition then decides which candidate owns it.
   */
  abstract readCandidates(b: Bundle, conceptId: string): AdapterReadCandidate[];
  abstract validate(b: Bundle, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]>;

  /** Where a new asset of `type` and `name` is kept. */
  protected placeFile(b: Bundle, { type }: Pick<NewAsset, "type" | "name">): string {
    throw new UsageError(`Bundle "${b.id}" (adapter "${this.id}") does not hold ${type} assets.`);
  }
  /** The bytes a file of `type` holds for `content`. */
  protected serialize(_type: string, _file: string, content: string | Buffer): string | Buffer {
    return content;
  }
  /** The mode a new file of `type` gets. Undefined: an existing file keeps its mode. */
  protected fileMode(_type: string): number | undefined {
    return undefined;
  }
  /** The marker file whose presence keeps `file` out of listings, when the adapter has one for it. */
  protected unlistedMarker(_file: FileContext): string | undefined {
    return undefined;
  }
  /** The type `file`'s location declares, for a file `recognizeFile` abstains on. */
  protected declaredType(_file: FileContext): string | undefined {
    return undefined;
  }
  /** The folder holding `file` and the resources that belong to it, when it is the entry of a package (a skill). */
  protected packageDir(_file: FileContext): string | undefined {
    return undefined;
  }
  /** The folders the adapter owns: feeds git exact-path staging and detection. */
  directoryList(_b: Bundle): string[] {
    return [];
  }
  renderExecutionSource?(b: Bundle, entry: AssetEntry): AdapterRenderedExecutionSource | null;
  looksLikeRoot?(root: string): boolean;

  // ── Template methods ────────────────────────────────────────────────────────

  list(b: Bundle): BundleListing {
    const walked = walkStashFlatWithStatus(b.root, this.walkOptions());
    return {
      entries: walked.files,
      complete: walked.complete,
      ...(walked.incompleteReason !== undefined ? { incompleteReason: walked.incompleteReason } : {}),
    };
  }

  /** Whether a full walk of the bundle would list `file`: not in a skipped or ignored directory. */
  walksFile(b: Bundle, file: string): boolean {
    return isWalkedFile(b.root, file, this.walkOptions());
  }

  recognize(b: Bundle, entry: AssetEntry): IndexDocument | null {
    return this.recognizeFile(b, fileContextOfEntry(b.root, entry));
  }

  /**
   * The asset `conceptId` names, without reading authored bytes to find it: workflow arbitration first, then every
   * spelling `readCandidates` inverts the concept id into, each probed with a byte-denying context so the
   * adapter's path-level abstention decides.
   */
  read(b: Bundle, conceptId: string, options?: AssetReadOptions): BundleAsset | undefined {
    const normalized = normalizedConceptId(conceptId);
    if (!normalized) return undefined;
    try {
      fs.realpathSync(b.root);
    } catch (error) {
      // A root that is gone holds nothing. Any other failure (EACCES) is not "nothing": say the root is unreadable.
      if (hasErrnoCode(error, "ENOENT")) return undefined;
      throw new ConfigError(`Unable to read bundle directory at "${b.root}".`, "STASH_DIR_UNREADABLE");
    }

    const owners = new Map<string, FileContext>();
    const workflowSource = resolveUniqueWorkflowSource(b.root, this.id, normalized);
    const resolved = workflowSource ? workflowSource.canonicalName : normalized;
    if (workflowSource) owners.set(path.resolve(workflowSource.path), buildFileContext(b.root, workflowSource.path));

    const spellings = this.readCandidates(b, resolved).flatMap((candidate) => candidateSpellings(candidate, b.root));
    const candidates = [...new Map(spellings.map((candidate) => [path.resolve(candidate.path), candidate])).values()]
      .filter((candidate) => candidate.conceptId === resolved)
      .sort((left, right) => compareCodePoints(left.path, right.path));
    for (const candidate of candidates) {
      const key = path.resolve(candidate.path);
      if (owners.has(key)) continue;
      const file = candidateFile(b, candidate.path);
      if (file && (this.claimsWithoutContent(b, file, resolved) || this.isMarkedUnlisted(file))) owners.set(key, file);
    }

    const found = [...owners.values()].sort((left, right) => compareCodePoints(left.absPath, right.absPath));
    if (found.length > 1) {
      const relatives = found.map((file) => file.relPath);
      if (options?.mode !== "read") throw new AdapterConceptCollisionError(this.id, resolved, relatives);
      const [winner, ...losers] = relatives;
      warnOnce(
        `adapter-concept-collision:${this.id}:${resolved}`,
        `Adapter "${this.id}" has multiple physical owners for "${resolved}": ${relatives.join(", ")}. ` +
          `Reading "${winner}" and ignoring ${losers.join(", ")}.`,
      );
    }
    const file = found[0];
    if (!file) return undefined;
    const self = this;
    const dir = this.packageDir(file);
    const entry: AssetEntry =
      dir === undefined ? file : { ...file, resources: () => packageResources(dir, file.absPath) };
    let type: string | undefined;
    return {
      conceptId: resolved,
      // Asked for, not read with the asset: knowing the type can mean reading the file, which finding it does not.
      get type() {
        type ??= self.recognizeFile(b, file)?.type ?? self.declaredType(file);
        if (type === undefined) {
          throw new UsageError(`Bundle adapter "${self.id}" does not recognize ${resolved} as an asset.`);
        }
        return type;
      },
      entry,
      listed: !this.isMarkedUnlisted(file),
    };
  }

  place(b: Bundle, asset: Pick<NewAsset, "type" | "name">): string {
    return this.placedConceptId(b, asset, "");
  }

  create(b: Bundle, asset: NewAsset): AssetChange {
    if (!this.writes.includes(asset.type)) {
      throw new UsageError(`Bundle "${b.id}" (adapter "${this.id}") does not hold ${asset.type} assets.`);
    }
    const file = this.placeFile(b, asset);
    const entry = buildFileContext(b.root, file);
    // A sibling marker keeps an env file or secret out of the index and listings.
    const marker = asset.unlisted ? this.unlistedMarker(entry) : undefined;
    if (asset.unlisted && marker === undefined) {
      throw new UsageError(`A ${asset.type} asset cannot be marked sensitive.`);
    }
    const conceptId = this.placedConceptId(b, asset, String(asset.content));
    const content = this.serialize(asset.type, file, asset.content);
    const changed = asset.resources?.length
      ? this.writePackage(b, asset, entry, content, asset.resources)
      : this.writeFile(b, asset.type, file, content);
    if (marker !== undefined) {
      if (!fs.existsSync(marker)) writeFileAtomic(marker, "", 0o600);
      changed.push(marker);
    }
    return { conceptId, file, changed, content: asset.content };
  }

  update(b: Bundle, conceptId: string, content: string | Buffer): AssetChange {
    const { entry, type } = this.existing(b, conceptId);
    const file = entry.file as string;
    this.writeFile(b, type, file, content);
    return { conceptId, file, changed: [file], content };
  }

  delete(b: Bundle, conceptId: string): AssetChange {
    const { entry } = this.existing(b, conceptId);
    const file = entry.file as string;
    assertWritableFile(b.root, b.id, file);
    const changed = [file];
    fs.rmSync(file);
    // An env file's or secret's `.sensitive` marker goes with it.
    const marker = this.unlistedMarker(buildFileContext(b.root, file));
    if (marker !== undefined && fs.existsSync(marker)) {
      fs.rmSync(marker);
      changed.push(marker);
    }
    return { conceptId, file, changed };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private walkOptions() {
    return { includeAllDirectories: this.walkMode === "all-directories" };
  }

  private isMarkedUnlisted(file: FileContext): boolean {
    const marker = this.unlistedMarker(file);
    return marker !== undefined && fs.existsSync(marker);
  }

  /** Whether the adapter recognizes `file` as `conceptId` from its path alone (an adapter that needs bytes claims it). */
  private claimsWithoutContent(b: Bundle, file: FileContext, conceptId: string): boolean {
    let requestedBytes = false;
    const denyBytes = (): never => {
      requestedBytes = true;
      throw CONTENT_READ_REQUIRED;
    };
    try {
      const document = this.recognizeFile(b, { ...file, content: denyBytes, bytes: denyBytes, frontmatter: denyBytes });
      return requestedBytes || document?.conceptId === conceptId;
    } catch (error) {
      if (error === CONTENT_READ_REQUIRED) return true;
      throw error;
    }
  }

  /** The concept id the adapter gives the file a new asset is placed in; its relative path when it recognizes none. */
  private placedConceptId(b: Bundle, asset: Pick<NewAsset, "type" | "name">, content: string): string {
    const entry = buildFileContext(b.root, this.placeFile(b, asset));
    const document = this.recognizeFile(b, {
      ...entry,
      content: () => content,
      bytes: () => Buffer.from(content),
      frontmatter: () => null,
    });
    return document?.conceptId ?? entry.relPath;
  }

  private existing(b: Bundle, conceptId: string): BundleAsset & { entry: AssetEntry & { file: string } } {
    const found = this.read(b, conceptId);
    if (!found?.entry.file) throw new NotFoundError(`Asset not found: ${b.id}//${conceptId}`);
    return found as BundleAsset & { entry: AssetEntry & { file: string } };
  }

  /** The bytes and file mode a write gives a file. */
  private writeFile(b: Bundle, type: string, file: string, bytes: string | Buffer): string[] {
    assertWritableFile(b.root, b.id, file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic: a crash or a full disk never leaves a half-written asset where a good one was.
    writeFileAtomic(file, bytes, this.fileMode(type) ?? existingFileMode(file));
    return [file];
  }

  /**
   * Write a package's entry and its resources as one folder, staged beside it and renamed into place, so a failed
   * write leaves the old package untouched. Returns every file the old and the new package hold.
   */
  private writePackage(
    b: Bundle,
    asset: NewAsset,
    entry: FileContext,
    content: string | Buffer,
    resources: NonNullable<NewAsset["resources"]>,
  ): string[] {
    const dir = this.packageDir(entry);
    if (dir === undefined) {
      throw new UsageError(
        `Bundle "${b.id}" (adapter "${this.id}") does not keep ${asset.type} assets with resources.`,
      );
    }
    assertWritableFile(b.root, b.id, dir);
    const existing = fs.lstatSync(dir, { throwIfNoEntry: false });
    const replaced = existing?.isDirectory() ? filesBelow(dir) : [];
    const staging = `${dir}.tmp-${randomUUID()}`;
    try {
      fs.mkdirSync(staging, { recursive: true });
      const put = (relative: string, bytes: string | Buffer) => {
        const target = path.join(staging, relative);
        if (!within(target, staging)) {
          throw new UsageError(
            `Resource path "${relative}" leaves the ${asset.type} package.`,
            "PATH_ESCAPE_VIOLATION",
          );
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes, { mode: this.fileMode(asset.type) });
      };
      for (const resource of resources) put(resource.path, resource.content);
      put(path.relative(dir, entry.absPath), content);
      if (existing) fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(staging, dir);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    return [...new Set([...replaced, ...filesBelow(dir)])];
  }
}

// ── Reading helpers ─────────────────────────────────────────────────────────

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
function candidateFile(b: Bundle, candidatePath: string): FileContext | undefined {
  const authored = path.resolve(candidatePath);
  if (!within(authored, b.root)) return undefined;
  try {
    const stat = fs.lstatSync(authored);
    if (!stat.isFile() && !stat.isSymbolicLink()) return undefined;
    if (!fs.statSync(fs.realpathSync(authored)).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return buildFileContext(b.root, authored);
}

/** Every file under `dir`, links to files included and links to directories left alone, as the walk does. */
function filesBelow(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(entryPath));
    else if (
      entry.isFile() ||
      (entry.isSymbolicLink() && fs.statSync(entryPath, { throwIfNoEntry: false })?.isFile())
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

/** The files of the package in `dir` besides its entry, by path below `dir`. */
function packageResources(dir: string, entryFile: string): AssetResource[] {
  return filesBelow(dir)
    .filter((file) => file !== entryFile)
    .map((file) => ({
      path: path.relative(dir, file).split(path.sep).join("/"),
      bytes: () => fs.readFileSync(file),
    }));
}

// ── Writing helpers ─────────────────────────────────────────────────────────

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
