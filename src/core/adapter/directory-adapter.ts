// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The mechanics every adapter of a directory bundle shares: its assets are
 * files under the bundle's root. `DirectoryAdapterBase` implements every
 * `BundleAdapter` member once, as template methods: the walk that lists the
 * files, the arbitration that reads one by its concept id, and the atomic
 * writes that create, update, delete and retire them. A subclass supplies the format
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
import { parseFrontmatter } from "../asset/frontmatter";
import { compareCodePoints, existingFileMode, hasErrnoCode, writeFileAtomic } from "../common";
import { ConfigError, NotFoundError, UsageError } from "../errors";
import type { FileChange } from "../file-change";
import { warnOnce } from "../warn";
import type {
  AssetChange,
  AssetEntry,
  AssetResource,
  BundleAdapter,
  BundleAsset,
  BundleListing,
  NewAsset,
  Retirement,
  RetireNote,
} from "./bundle-adapter";
import {
  archiveFile,
  expireArchive,
  forgetArchive,
  listTombstones,
  MEMORY_ARCHIVE_REL,
  noteOf,
  readTombstone,
  restoreArchive,
  type Tombstone,
} from "./directory-archive";
import type { Bundle, Diagnostic, IndexDocument, ValidateContext } from "./types";

/** A file that may hold a concept: where a placement could put it, and the identity it would then own. */
export interface AdapterReadCandidate {
  path: string;
  /** Canonical concept identity this authored path may own. */
  conceptId: string;
}

const CONTENT_READ_REQUIRED = Symbol("adapter ownership probe requires content");

export abstract class DirectoryAdapterBase implements BundleAdapter {
  abstract readonly id: string;
  /** Feeds incrementality and fingerprints. */
  abstract readonly version: string;
  /** The asset types it writes. Empty: read-only. */
  readonly writes: readonly string[] = [];
  /** The asset types it retires recoverably; a subset of `writes`. Empty: it deletes only. */
  get retires(): readonly string[] {
    return [];
  }
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
  protected abstract readCandidates(b: Bundle, conceptId: string): AdapterReadCandidate[];
  protected abstract validateFiles(b: Bundle, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]>;

  /** Where a new asset of `type` and `name` is kept. */
  protected placeFile(b: Bundle, { type }: Pick<NewAsset, "type" | "name">): string {
    throw new Error(
      `Adapter "${this.id}" does not write ${type} assets in bundle "${b.id}"; the asset facade checks \`writes\` first.`,
    );
  }
  /** The bytes a file of `type` holds for `content`. */
  protected serialize(_type: string, _file: string, content: string | Buffer): string | Buffer {
    return content;
  }
  /** The mode a new file of `type` gets. Undefined: an existing file keeps its mode. */
  protected fileMode(_type: string): number | undefined {
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
    // One entry per concept: where several files hold one, the winner `read` acts on. A file's concept comes from its
    // path when that says; otherwise it is read (once: the entry keeps its bytes for the caller's `recognize`).
    const byConcept = new Map<string, FileContext[]>();
    for (const file of walked.files) {
      let conceptId: string | undefined;
      try {
        const document = this.pathDocument(b, file);
        conceptId = (document === undefined ? this.recognizeFile(b, file) : document)?.conceptId;
      } catch {
        // A file that cannot be recognized is listed as it is; the caller's `recognize` reports it.
      }
      if (conceptId) byConcept.set(conceptId, [...(byConcept.get(conceptId) ?? []), file]);
    }
    const shadowed = new Set<FileContext>();
    for (const group of byConcept.values()) {
      if (group.length < 2) continue;
      const winner = this.winner(b, { found: group, pathTypes: new Map() });
      for (const file of group) if (file !== winner) shadowed.add(file);
    }
    return {
      entries: walked.files.filter((file) => !shadowed.has(file)),
      complete: walked.complete,
      ...(walked.incompleteReason !== undefined ? { incompleteReason: walked.incompleteReason } : {}),
    };
  }

  recognize(b: Bundle, entry: AssetEntry): IndexDocument | null {
    return this.recognizeFile(b, fileContextOfEntry(b.root, entry));
  }

  /**
   * The asset `conceptId` names, without reading authored bytes to find it: workflow arbitration first, then every
   * spelling `readCandidates` inverts the concept id into, each probed with a byte-denying context so the
   * adapter's path-level abstention decides.
   */
  read(b: Bundle, conceptId: string): BundleAsset | undefined {
    const held = this.holders(b, conceptId);
    if (!held) return undefined;
    const { resolved, pathTypes } = held;
    const file = this.winner(b, held);
    if (!file) return undefined;
    const dir = this.packageDir(file);
    const entry: AssetEntry =
      dir === undefined ? file : { ...file, resources: () => packageResources(dir, file.absPath) };
    // The type recognizing the path gave, else the one its place declares, else what reading it says (which a path
    // alone settles for most adapters, so finding an asset reads no authored bytes). A file none gives one is no asset.
    const type = pathTypes.get(file) ?? this.declaredType(file) ?? this.recognizeFile(b, file)?.type;
    if (type === undefined) return undefined;
    return {
      conceptId: resolved,
      type,
      entry,
      // Not listed: a full walk would not reach it (a skipped or ignored directory).
      listed: this.walksFile(b, file.absPath),
    };
  }

  /**
   * Native validation, and a finding for every concept in `changes` that more than one file spells (`skills/x.md`
   * and `skills/x/SKILL.md`): reads and writes act on the winner, so the ignored files are only visible here.
   */
  async validate(b: Bundle, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
    const diagnostics = await this.validateFiles(b, changes, ctx);
    const seen = new Set<string>();
    for (const change of changes) {
      const file = candidateFile(b, path.join(b.root, change.path));
      const conceptId = file ? this.recognizeFile(b, file)?.conceptId : undefined;
      if (!conceptId || seen.has(conceptId)) continue;
      seen.add(conceptId);
      const held = this.holders(b, conceptId);
      if (!held || held.found.length < 2) continue;
      const winner = this.winner(b, held);
      if (!winner) continue;
      const ignored = held.found.filter((other) => other !== winner).map((other) => other.relPath);
      diagnostics.push({
        file: winner.relPath,
        issue: "shadowed-spelling",
        detail: `"${conceptId}" is held by more than one file; "${winner.relPath}" is used and ${ignored.join(", ")} ignored. Remove the ignored ${ignored.length === 1 ? "file" : "files"}.`,
        fixed: false,
      });
    }
    return diagnostics;
  }

  /** Every file that holds `conceptId`, by code point, with the types their paths gave. Undefined: the root is gone. */
  private holders(
    b: Bundle,
    conceptId: string,
  ): { resolved: string; found: FileContext[]; pathTypes: Map<FileContext, string> } | undefined {
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
    /** The type a file's path alone gave, found while claiming it: knowing it then reads nothing. */
    const pathTypes = new Map<FileContext, string>();
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
      if (!file) continue;
      const claim = this.claimsWithoutContent(b, file, resolved);
      if (claim?.type !== undefined) pathTypes.set(file, claim.type);
      if (claim) owners.set(key, file);
    }
    const found = [...owners.values()].sort((left, right) => compareCodePoints(left.absPath, right.absPath));
    return { resolved, found, pathTypes };
  }

  /**
   * The file that is the concept when several hold it, by the one rule the adapter owns: the spelling `place` gives
   * for the concept's type and name, else the first by code point. Reads, updates, deletes and retires all act on it.
   */
  private winner(b: Bundle, { found, pathTypes }: { found: FileContext[]; pathTypes: Map<FileContext, string> }) {
    if (found.length < 2) return found[0];
    for (const file of found) {
      try {
        const document = this.recognizeFile(b, file);
        const type = pathTypes.get(file) ?? document?.type ?? this.declaredType(file);
        if (document && type && path.resolve(this.placeFile(b, { type, name: document.name })) === file.absPath) {
          return file;
        }
      } catch {
        // A file that cannot be recognized or placed is not the placed spelling.
      }
    }
    return found[0];
  }

  place(b: Bundle, asset: Pick<NewAsset, "type" | "name">): string {
    return this.placedConceptId(b, asset, "");
  }

  create(b: Bundle, asset: NewAsset): AssetChange {
    if (!this.writes.includes(asset.type)) {
      throw new Error(
        `Adapter "${this.id}" does not write ${asset.type} assets in bundle "${b.id}"; the asset facade checks \`writes\` first.`,
      );
    }
    const file = this.placeFile(b, asset);
    const entry = buildFileContext(b.root, file);
    const conceptId = this.placedConceptId(b, asset, String(asset.content));
    const content = this.serialize(asset.type, file, asset.content);
    const changed = asset.resources?.length
      ? this.writePackage(b, asset, entry, content, asset.resources)
      : this.writeFile(b, asset.type, file, content);
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
    fs.rmSync(file);
    return { conceptId, file, changed: [file] };
  }

  retire(b: Bundle, conceptId: string, note: RetireNote): AssetChange & { handle: string } {
    const { entry, type } = this.existing(b, conceptId);
    this.requireRetires(b, type);
    const file = entry.file as string;
    assertWritableFile(b.root, b.id, file);
    assertWritableFile(b.root, b.id, path.join(b.root, MEMORY_ARCHIVE_REL, "retirement"));
    const ref = note.ref ?? `${b.id}//${conceptId}`;
    const written = archiveFile(b.root, file, { ref, archivedAt: new Date().toISOString(), note });
    return { conceptId, changed: written.changed, handle: written.handle };
  }

  retired(b: Bundle): Retirement[] {
    return listTombstones(b.root).map((tombstone) => ({
      handle: tombstone.handle,
      conceptId: this.describeRetired(b, tombstone).conceptId,
      note: noteOf(tombstone),
      restorable: tombstone.archivedPath !== undefined && fs.existsSync(path.join(b.root, tombstone.archivedPath)),
    }));
  }

  restore(b: Bundle, handle: string, fallback?: string | Buffer): AssetChange {
    this.requireRetiring(b);
    const tombstone = readTombstone(b.root, handle);
    const { conceptId, type } = this.describeRetired(b, tombstone);
    if (type !== undefined) this.requireRetires(b, type);
    const file = path.join(b.root, tombstone.originalPath);
    assertWritableFile(b.root, b.id, file);
    return { conceptId, file, changed: restoreArchive(b.root, tombstone, fallback) };
  }

  forget(b: Bundle, handle: string): { changed: string[] } {
    this.requireRetiring(b);
    return { changed: forgetArchive(b.root, handle) };
  }

  expireRetired(b: Bundle, before: Date): { changed: string[] } {
    this.requireRetiring(b);
    return { changed: expireArchive(b.root, before).changed };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private requireRetiring(b: Bundle): void {
    if (this.retires.length === 0) {
      throw new UsageError(`Bundle "${b.id}" (adapter "${this.id}") does not retire assets.`);
    }
  }

  private requireRetires(b: Bundle, type: string): void {
    if (!this.retires.includes(type)) {
      throw new UsageError(`Bundle "${b.id}" (adapter "${this.id}") does not retire ${type} assets.`);
    }
  }

  /**
   * The concept id (and type, when known) a retired file had, from its original path and the content it kept: the
   * archived copy while there is one. A file the adapter cannot describe is named by its path without extension.
   */
  private describeRetired(b: Bundle, tombstone: Tombstone): { conceptId: string; type?: string } {
    const original = path.join(b.root, tombstone.originalPath);
    const archived = tombstone.archivedPath === undefined ? undefined : path.join(b.root, tombstone.archivedPath);
    const source = archived !== undefined && fs.existsSync(archived) ? archived : original;
    const file: FileContext = {
      ...buildFileContext(b.root, original),
      content: () => fs.readFileSync(source, "utf8"),
      bytes: () => fs.readFileSync(source),
      frontmatter: () => {
        const data = parseFrontmatter(fs.readFileSync(source, "utf8")).data;
        return Object.keys(data).length > 0 ? data : null;
      },
    };
    try {
      const document = this.recognizeFile(b, file);
      const type = document?.type ?? this.declaredType(file);
      return { conceptId: document?.conceptId ?? file.relPath.replace(/\.[^./]+$/, ""), ...(type ? { type } : {}) };
    } catch {
      return { conceptId: file.relPath.replace(/\.[^./]+$/, "") };
    }
  }

  /** Whether a full walk of the bundle would list `file`: not in a skipped or ignored directory. */
  private walksFile(b: Bundle, file: string): boolean {
    return isWalkedFile(b.root, file, this.walkOptions());
  }

  private walkOptions() {
    return { includeAllDirectories: this.walkMode === "all-directories" };
  }

  /** The document the adapter gives `file` from its path alone: undefined when it needs the file's bytes to say. */
  private pathDocument(b: Bundle, file: FileContext): IndexDocument | null | undefined {
    let requestedBytes = false;
    const denyBytes = (): never => {
      requestedBytes = true;
      throw CONTENT_READ_REQUIRED;
    };
    try {
      const document = this.recognizeFile(b, { ...file, content: denyBytes, bytes: denyBytes, frontmatter: denyBytes });
      return requestedBytes ? undefined : document;
    } catch (error) {
      if (error === CONTENT_READ_REQUIRED) return undefined;
      throw error;
    }
  }

  /**
   * Whether the adapter recognizes `file` as `conceptId` from its path alone (an adapter that needs bytes claims it,
   * with no type yet); a claim carries the type the path gave.
   */
  private claimsWithoutContent(b: Bundle, file: FileContext, conceptId: string): { type?: string } | undefined {
    const document = this.pathDocument(b, file);
    if (document === undefined) return {};
    return document?.conceptId === conceptId ? { type: document.type } : undefined;
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
