// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The mechanics every adapter of a directory bundle shares: its assets are
 * files under the bundle's root. `DirectoryAdapterBase` implements every
 * `BundleAdapter` member once, as template methods: the walk that lists the
 * files, the lookup that reads one by its concept id, and the atomic
 * writes that create, update, delete and retire them. A subclass supplies the format
 * through the hooks below and does not override the template methods.
 *
 * Identity is a pure function of the storage key: `identify(relPath)` gets no bundle, no file system and no content,
 * so `list`, `read`, `place` and the retired-asset id cannot read a file. Of the files that spell one concept the
 * first in `spellings` order wins, for every caller. The type of an asset is index metadata: only `describe` (through
 * `recognize`) says it, and it may read content.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AdapterRenderedExecutionSource } from "../../execution/source";
import {
  getMarkdownFragmentContent,
  hasMarkdownFragmentContent,
  setMarkdownFragmentContent,
} from "../../indexer/passes/metadata";
import { makeBundleRef } from "../asset/asset-ref";
import {
  compareCodePoints,
  existingFileMode,
  hasErrnoCode,
  isWithin,
  relativeToRoot,
  toErrorMessage,
  writeFileAtomic,
} from "../common";
import { assetNotFound, ConfigError, UsageError } from "../errors";
import { presentationFor } from "../type-presentation";
import type {
  AssetChange,
  AssetEntry,
  AssetPlacement,
  BundleAdapter,
  BundleAsset,
  BundleListing,
  NewAsset,
  PackageFile,
  Retirement,
  RetireNote,
} from "./bundle-adapter";
import { buildFileContext, type FileContext, fileContextOfEntry } from "./directory/file-context";
import { isWalkedFile, type WalkStashFlatResult, walkStashFlatWithStatus } from "./directory/walker";
import {
  archiveFile,
  expireArchive,
  forgetArchive,
  listTombstones,
  MEMORY_ARCHIVE_REL,
  noteOf,
  qualifiedNote,
  readTombstone,
  restoreArchive,
  type Tombstone,
} from "./directory-archive";
import type { FileChange } from "./file-change";
import {
  type AssetEdit,
  type Bundle,
  type Diagnostic,
  type IndexDocument,
  type IndexMetadata,
  rootOf,
  type ValidateContext,
} from "./types";
import {
  buildOverlay,
  createFileValidateContext,
  type FileDiagnostic,
  type FileValidateContext,
} from "./validate-context";

/** An asset a directory bundle keeps in a file. */
type FileAsset = BundleAsset & { entry: AssetEntry & { file: string } };

export abstract class DirectoryAdapterBase implements BundleAdapter {
  abstract readonly id: string;
  /** Feeds incrementality and fingerprints. */
  abstract readonly version: string;
  readonly addressedBy = "root" as const;
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

  /**
   * The concept id the file at `relPath` holds, or null when it is no asset. A pure function of the path: it gets no
   * bundle and reads nothing, so listing and reading an asset cannot read a file.
   */
  protected abstract identify(relPath: string): string | null;
  /**
   * Every path (relative to the root) the asset `conceptId` can be kept at, the winner first. The first of these that
   * exists decides the answer: the concept its file holds (`identify`) wins, and the asset comes back under that id.
   * This is how a file spelling (`knowledge/guide.md`) resolves to its asset (`knowledge/guide`). A path `identify` gives
   * no concept is skipped.
   */
  protected abstract spellings(conceptId: string): string[];
  /** What the index records about `file`, the asset `conceptId` names. It may read the file. */
  protected abstract describe(b: Bundle, file: FileContext, conceptId: string): IndexMetadata;
  protected abstract validateFiles(
    b: Bundle,
    changes: FileChange[],
    ctx: FileValidateContext,
  ): Promise<FileDiagnostic[]>;

  /** Where a new asset of `type` and `name` is kept. */
  protected placeFile(b: Bundle, { type }: Pick<NewAsset, "type" | "name">): string {
    throw new Error(
      `Adapter "${this.id}" does not write ${type} assets in bundle "${b.id}"; the asset facade checks \`writes\` first.`,
    );
  }
  /** The bytes a file of `type` holds for `content`. */
  protected serialize(_type: string, _file: string, content: string | Buffer, _label?: string): string | Buffer {
    return content;
  }
  /** The mode a new file of `type` gets. Undefined: an existing file keeps its mode. */
  protected fileMode(_type: string): number | undefined {
    return undefined;
  }
  /** The type of the asset kept at `relPath`, from the path alone. Only an adapter that writes says it. */
  protected typeOf(relPath: string): string {
    throw new Error(
      `Adapter "${this.id}" does not write assets (${relPath}); the asset facade checks \`writes\` first.`,
    );
  }
  /** The folder holding `file` and the resources that belong to it, when it is the entry of a package (a skill). */
  protected packageDir(_file: FileContext): string | undefined {
    return undefined;
  }
  /** The folder, inside the root, that holds the adapter's assets of `type`; undefined: they may be anywhere. */
  protected typeFolder(_type: string): string | undefined {
    return undefined;
  }
  /** The folders the adapter owns: feeds git exact-path staging and detection. */
  directoryList(_b: Bundle): string[] {
    return [];
  }
  renderExecutionSource?(b: Bundle, entry: AssetEntry): AdapterRenderedExecutionSource | null;
  looksLikeRoot?(root: string): boolean;

  // ── Template methods ────────────────────────────────────────────────────────

  exists(b: Bundle): boolean {
    return fs.statSync(rootOf(b), { throwIfNoEntry: false })?.isDirectory() === true;
  }

  list(b: Bundle, type?: string): BundleListing {
    const walked = walkStashFlatWithStatus(rootOf(b), this.walkOptions());
    // One asset per concept: the winner among the files that spell it. The path says which concept a file holds.
    const byConcept = new Map<string, FileContext[]>();
    for (const file of walked.files) {
      const conceptId = this.identify(file.relPath);
      if (conceptId === null) continue;
      byConcept.set(conceptId, [...(byConcept.get(conceptId) ?? []), file]);
    }
    const winners = new Map<FileContext, string>();
    for (const [conceptId, files] of byConcept) {
      const ranked = [...files].sort((left, right) => this.compareSpellings(conceptId, left.relPath, right.relPath));
      winners.set(ranked[0] as FileContext, conceptId);
    }
    return {
      assets: walked.files.flatMap((file) => {
        const conceptId = winners.get(file);
        return conceptId === undefined ? [] : [{ conceptId, entry: file }];
      }),
      ...this.completeness(b, walked, type),
    };
  }

  /**
   * Whether the walk read the whole bundle, or with `type` the part of it {@link typeFolder} names: a failure elsewhere,
   * or a file named like another type's folder, leaves that type's listing complete. A type folder that is a file is
   * that type's failure.
   */
  private completeness(
    b: Bundle,
    walked: WalkStashFlatResult,
    type?: string,
  ): Pick<BundleListing, "complete" | "incompleteReason"> {
    const folder = type === undefined ? undefined : this.typeFolder(type);
    if (folder === undefined) {
      return {
        complete: walked.complete,
        ...(walked.incompleteReason !== undefined ? { incompleteReason: walked.incompleteReason } : {}),
      };
    }
    const failure = walked.failures?.find(({ path: at }) => at === "" || at === folder || at.startsWith(`${folder}/`));
    if (failure) return { complete: false, incompleteReason: failure.reason };
    if (walked.files.some((file) => file.relPath === folder)) {
      try {
        fs.readdirSync(path.join(rootOf(b), folder));
      } catch (error) {
        return { complete: false, incompleteReason: toErrorMessage(error) };
      }
    }
    return { complete: true };
  }

  /** The entry's metadata, then the identity its storage key names, which `describe` cannot change. */
  recognize(b: Bundle, entry: AssetEntry): IndexDocument | null {
    const file = fileContextOfEntry(rootOf(b), entry);
    const conceptId = this.identify(file.relPath);
    if (conceptId === null) return null;
    const metadata = this.describe(b, file, conceptId);
    const document: IndexDocument = {
      ...metadata,
      ref: `${b.id}//${conceptId}`,
      bundle: b.id,
      conceptId,
      adapterId: this.id,
      path: file.absPath,
    };
    // The fragment projection follows the described document by identity (see `metadata.ts`), not as a field.
    if (hasMarkdownFragmentContent(metadata)) {
      setMarkdownFragmentContent(document, getMarkdownFragmentContent(metadata));
    }
    return document;
  }

  /**
   * The asset `conceptId` names, found without reading any file: the first of its `spellings` that exists inside the
   * root, that a full listing reaches and that `identify` gives a concept id. The asset comes back under that id.
   */
  read(b: Bundle, conceptId: string): BundleAsset | undefined {
    const held = this.holders(liveView(b), conceptId);
    const first = held?.files[0];
    const file = first === undefined ? undefined : buildFileContext(rootOf(b), path.join(rootOf(b), first));
    return held && file && { conceptId: held.conceptId, entry: file };
  }

  /**
   * Native validation of `edits`, by ref. The edits become file changes over the bundle's snapshot (the files on disk
   * with the pending edits overlaid) and are checked there. An edit's file and the files a concept is held by are
   * found by {@link holders}, the function `read` uses, over a view of the live tree or of the snapshot.
   */
  async validate(b: Bundle, edits: AssetEdit[], ctx: ValidateContext): Promise<Diagnostic[]> {
    const base = { root: rootOf(b), sources: ctx.sources, config: ctx.config, readMoves: ctx.readMoves };
    const live = liveView(b);
    const changes: FileChange[] = [];
    for (const edit of edits) {
      const relPath = this.holders(live, edit.conceptId)?.files[0] ?? this.spellings(edit.conceptId)[0];
      if (relPath === undefined) continue;
      changes.push(
        edit.op === "delete"
          ? { path: relPath, op: "delete" }
          : { path: relPath, op: edit.op, ...(edit.content === undefined ? {} : { after: edit.content.toString() }) },
      );
    }
    const found = await this.checkChanges(b, changes, createFileValidateContext({ ...base, changes }));
    return found.map((diagnostic) => ({
      ...diagnostic,
      ref: makeBundleRef(b.id, this.identify(diagnostic.file) ?? diagnostic.file),
    }));
  }

  /**
   * The checks of `changes` over `ctx`, and a finding for every concept in them that more than one file spells
   * (`skills/x.md` and `skills/x/SKILL.md`): reads and writes act on the winner, so the ignored files are only visible
   * here.
   */
  protected async checkChanges(b: Bundle, changes: FileChange[], ctx: FileValidateContext): Promise<FileDiagnostic[]> {
    const diagnostics = await this.validateFiles(b, changes, ctx);
    const view = snapshotView(b, buildOverlay(rootOf(b), changes));
    const seen = new Set<string>();
    for (const change of changes) {
      const conceptId = this.identify(change.path);
      if (conceptId === null || seen.has(conceptId)) continue;
      seen.add(conceptId);
      const files = this.holders(view, conceptId)?.files ?? [];
      if (files.length < 2) continue;
      const [winner, ...ignored] = files;
      diagnostics.push({
        file: winner as string,
        issue: "shadowed-spelling",
        detail: `"${conceptId}" is held by more than one file; "${winner}" is used and ${ignored.join(", ")} ignored. Remove the ignored ${ignored.length === 1 ? "file" : "files"}.`,
        fixed: false,
      });
    }
    return diagnostics;
  }

  /**
   * The files (bundle-relative) that hold the asset `asked` names, the winner first, and the concept id they hold,
   * as `view` shows them: the one place that decides which file holds a concept, for `read` (the live tree) and for
   * `validate` (the snapshot). Existence checks and directory listings only. Undefined: the root is gone or no spelling of it exists.
   *
   * `asked` may be a file's name (`tasks/dup.md`) rather than a concept id. The first existing spelling's file then
   * holds some concept, and that concept's winner is the answer, so a file name never reaches a file the concept's
   * own spelling order ranks below another (`tasks/dup.md` and `tasks/dup` are the same asset).
   */
  private holders(view: FileView, asked: string): { conceptId: string; files: string[] } | undefined {
    const normalized = normalizedConceptId(asked);
    if (!normalized || !view.rootExists()) return undefined;
    const spelled = this.existingSpellings(view, normalized);
    const first = spelled[0];
    if (!first) return undefined;
    const conceptId = this.identify(first) as string;
    const held = conceptId === normalized ? spelled : this.existingSpellings(view, conceptId);
    const files = held.filter((file) => this.identify(file) === conceptId);
    return { conceptId, files: files.length > 0 ? files : [first] };
  }

  /** The files that exist at a spelling of `conceptId` (case variants included) and that a listing reaches and `identify` maps to a concept, in spelling order. */
  private existingSpellings(view: FileView, conceptId: string): string[] {
    const found = new Set<string>();
    for (const spelling of this.spellings(conceptId)) {
      for (const relPath of caseVariants(view, spelling)) {
        if (found.has(relPath) || this.identify(relPath) === null) continue;
        if (!view.isFile(relPath) || !view.isWalked(relPath, this.walkOptions())) continue;
        found.add(relPath);
      }
    }
    return [...found];
  }

  /** Which of two files that hold `conceptId` wins: the earlier spelling, the exact one before its case variants. */
  private compareSpellings(conceptId: string, left: string, right: string): number {
    const order = this.spellings(conceptId);
    const rank = (relPath: string): number => {
      const exact = order.indexOf(relPath);
      if (exact >= 0) return exact * 2;
      const variant = order.findIndex((spelling) => isCaseVariant(spelling, relPath));
      return variant >= 0 ? variant * 2 + 1 : order.length * 2;
    };
    return rank(left) - rank(right) || compareCodePoints(left, right);
  }

  identifyKey(_b: Bundle, key: string): string | null {
    return this.identify(key);
  }

  /**
   * Where a new asset goes: its concept id, the key and file that keep it, and whether anything is kept there now.
   * Refused when its file would be no asset (`knowledge` named `index`, `secret` named `x.lock`).
   */
  place(b: Bundle, asset: Pick<NewAsset, "type" | "name">): AssetPlacement {
    return this.placeAt(b, asset, this.placeFile(b, asset));
  }

  /** How `akm show` renders an asset of `type`: the type's own renderer. */
  rendererFor(type: string): string | undefined {
    return presentationFor(type).renderer;
  }

  /** What a create of `type` puts before the name in its concept id: the type's folder (`tasks/`), else nothing. */
  prefixOf(type: string): string {
    const folder = this.typeFolder(type);
    return folder === undefined ? "" : `${folder}/`;
  }

  /** {@link place} for a create kept at `file`. */
  protected placeAt(b: Bundle, asset: Pick<NewAsset, "type" | "name">, file: string): AssetPlacement {
    const key = this.relPathOf(b, file);
    const conceptId = this.identify(key);
    if (conceptId === null) {
      throw new UsageError(
        `Cannot create ${asset.type} "${asset.name}" in bundle "${b.id}": it would be kept at ${key}, which is not an asset.`,
      );
    }
    return { conceptId, key, occupied: fs.existsSync(file), file };
  }

  create(
    b: Bundle,
    asset: NewAsset,
    options: { replace?: boolean; verbatim?: boolean; replaceLink?: boolean | "any" } = {},
  ): AssetChange {
    if (!this.writes.includes(asset.type)) {
      throw new Error(
        `Adapter "${this.id}" does not write ${asset.type} assets in bundle "${b.id}"; the asset facade checks \`writes\` first.`,
      );
    }
    const { conceptId } = this.place(b, asset);
    const held = this.read(b, conceptId);
    if (!options.replace && held) {
      throw new Error(
        `Adapter "${this.id}" will not create "${b.id}//${conceptId}" over an existing asset without \`replace\`; the asset facade checks \`exclusive\` first.`,
      );
    }
    // A replacing create rewrites the file the concept is read from (`guide.MD`), never a twin beside it.
    const file = held?.entry.file ?? this.placeFile(b, asset);
    const content = options.verbatim ? asset.content : this.serialize(asset.type, file, asset.content, asset.label);
    const changed = this.writeFile(
      b,
      asset.type,
      file,
      content,
      options.replaceLink,
      options.verbatim ? asset.mode : undefined,
    );
    return { conceptId, changed, content: asset.content };
  }

  update(b: Bundle, conceptId: string, content: string | Buffer, options: { throughLink?: boolean } = {}): AssetChange {
    const { conceptId: canonical, entry } = this.existing(b, conceptId);
    const held = entry.file as string;
    // Through a link that leads to a file inside the bundle the write goes where it leads; any other link is refused below.
    const file = options.throughLink ? (linkTargetInside(rootOf(b), held) ?? held) : held;
    // A file saved as it lies keeps a read-only mode too: the atomic replace would ignore it, so ask with the error a write of it gives.
    if (options.throughLink) fs.closeSync(fs.openSync(held, "r+"));
    this.writeFile(b, this.typeOf(entry.key), file, content);
    return { conceptId: canonical, changed: [file], content };
  }

  /**
   * Deleting a package's entry deletes the package: its folder, resources and all (§8.3). One change per asset it
   * held, the entry's first; the entry's change also lists the folder's files that are no asset.
   */
  delete(b: Bundle, conceptId: string): AssetChange[] {
    const entry = this.existing(b, conceptId);
    const file = entry.entry.file;
    assertWritableFile(rootOf(b), b.id, file);
    const dir = this.packageDir(buildFileContext(rootOf(b), file));
    // A package at the bundle's root is not the bundle's to remove: only its entry goes.
    if (dir === undefined || !isWithin(dir, rootOf(b)) || path.resolve(dir) === path.resolve(rootOf(b))) {
      fs.rmSync(file);
      return [{ conceptId: entry.conceptId, changed: [file] }];
    }
    const members = this.packageMembers(b, entry);
    const memberFiles = new Set(members.map((member) => member.entry.file));
    const files = filesBelow(dir);
    fs.rmSync(dir, { recursive: true });
    return [
      { conceptId: entry.conceptId, changed: files.filter((member) => !memberFiles.has(member)) },
      ...members.map((member) => ({ conceptId: member.conceptId, changed: [member.entry.file] })),
    ];
  }

  /**
   * The package a package entry holds. Found through its spellings when the walk does not reach it (a skill folder that
   * is a link), because a clone reads the package a ref resolved to, by content.
   */
  packageFiles(b: Bundle, conceptId: string): PackageFile[] {
    const root = rootOf(b);
    const file =
      this.read(b, conceptId)?.entry.file ??
      this.spellings(conceptId)
        .filter((relPath) => this.identify(relPath) !== null)
        .map((relPath) => path.join(root, relPath))
        .find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
    const dir = file === undefined ? undefined : this.packageDir(buildFileContext(root, file));
    if (dir === undefined) throw new UsageError(`"${b.id}//${conceptId}" is not a package entry.`);
    const relative = (member: string): string => path.relative(dir, member).split(path.sep).join("/");
    const links = directoryLinksBelow(dir).map((link) => ({
      path: relative(link),
      bytes: Buffer.alloc(0),
      mode: 0,
      link: path.resolve(path.dirname(link), fs.readlinkSync(link)),
    }));
    return [
      ...filesBelow(dir).map((member) => ({
        path: relative(member),
        bytes: fs.readFileSync(member),
        mode: fs.statSync(member).mode & 0o777,
      })),
      ...links,
    ].sort((left, right) => compareCodePoints(left.path, right.path));
  }

  mirrorPackage(
    b: Bundle,
    asset: Pick<NewAsset, "type" | "name">,
    files: readonly PackageFile[],
    options: { replace?: boolean } = {},
  ): AssetChange[] {
    if (!this.writes.includes(asset.type)) {
      throw new Error(
        `Adapter "${this.id}" does not write ${asset.type} assets in bundle "${b.id}"; the asset facade checks \`writes\` first.`,
      );
    }
    const { conceptId, file: placed } = this.place(b, asset);
    const entry = buildFileContext(rootOf(b), placed as string);
    const dir = this.packageDir(entry);
    if (dir === undefined) {
      throw new UsageError(`Bundle "${b.id}" (adapter "${this.id}") does not keep ${asset.type} assets as packages.`);
    }
    const entryPath = path.relative(dir, entry.absPath).split(path.sep).join("/");
    if (!files.some((file) => file.path === entryPath)) {
      throw new UsageError(`The ${asset.type} package has no ${entryPath}, the file that makes it a ${asset.type}.`);
    }
    for (const file of files) {
      if (!within(path.join(dir, file.path), dir) || path.isAbsolute(file.path)) {
        throw new UsageError(`File path "${file.path}" leaves the ${asset.type} package.`, "PATH_ESCAPE_VIOLATION");
      }
    }
    const staging = `${dir}.tmp-${randomUUID()}`;
    // The folders above the package may not be links; the package folder itself may be one, which is replaced as an entry.
    assertWritableFile(rootOf(b), b.id, staging, { replaceLink: true });
    const existing = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (existing && !options.replace) {
      throw new UsageError(
        `Asset already exists in bundle "${b.id}": ${dir}. Use --force to overwrite.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    const before = existing?.isDirectory() ? filesBelow(dir) : [];
    const backup = `${dir}.old-${randomUUID()}`;
    try {
      for (const file of files) {
        const target = path.join(staging, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (file.link !== undefined) {
          fs.symlinkSync(file.link, target, "dir");
          continue;
        }
        fs.writeFileSync(target, file.bytes);
        fs.chmodSync(target, file.mode);
      }
      if (existing) fs.renameSync(dir, backup);
      try {
        fs.renameSync(staging, dir);
      } catch (error) {
        if (existing) fs.renameSync(backup, dir);
        throw error;
      }
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    if (existing) fs.rmSync(backup, { recursive: true, force: true });
    // The entry's change lists every file of the package; another asset the old or the new package held is its own change.
    const after = filesBelow(dir);
    const entryFile = files.find((file) => file.path === entryPath) as PackageFile;
    const changes = new Map<string, AssetChange>([[conceptId, { conceptId, changed: [], content: entryFile.bytes }]]);
    for (const file of new Set([...before, ...after])) {
      const held = this.identify(this.relPathOf(b, file));
      const key = held !== null && held !== conceptId ? held : conceptId;
      const change = changes.get(key) ?? { conceptId: key, changed: [] };
      change.changed.push(file);
      changes.set(key, change);
    }
    // Each asset the package now holds is handed back as its entry, as a write does; one it no longer holds has none.
    for (const change of changes.values()) {
      const kept = this.read(b, change.conceptId);
      if (kept) change.entry = kept.entry;
    }
    const first = changes.get(conceptId) as AssetChange;
    return [first, ...[...changes.values()].filter((change) => change !== first)];
  }

  /**
   * Retiring a package's entry retires every asset of its package with it, each its own retirement (§8.3); the
   * package's files that are no asset stay where they are. The entry is retired last, so a retirement a crash
   * interrupted is finished by retiring the entry again; its change comes first.
   */
  retire(b: Bundle, conceptId: string, note: RetireNote): Array<AssetChange & { handle: string }> {
    const root = rootOf(b);
    const entry = this.existing(b, conceptId);
    const assets = [...this.packageMembers(b, entry), entry];
    for (const asset of assets) {
      this.requireRetires(b, this.typeOf(asset.entry.key));
      assertWritableFile(root, b.id, asset.entry.file);
    }
    assertWritableFile(root, b.id, path.join(root, MEMORY_ARCHIVE_REL, "retirement"));
    const archivedAt = note.archivedAt ?? new Date().toISOString();
    const changes = assets.map((asset) => {
      const written = archiveFile(root, asset.entry.file, {
        ref: note.ref ?? entry.conceptId,
        archivedAt,
        note,
        bundle: b.id,
      });
      return { conceptId: asset.conceptId, changed: written.changed, handle: written.handle };
    });
    return [changes.pop() as AssetChange & { handle: string }, ...changes];
  }

  /** The assets of the package whose entry is `entry`, other than the entry, by concept id; none for an asset that is no package entry. */
  private packageMembers(b: Bundle, entry: FileAsset): FileAsset[] {
    const root = rootOf(b);
    const dir = this.packageDir(buildFileContext(root, entry.entry.file));
    // A package at the bundle's root is not the bundle's to retire: only its entry goes.
    if (dir === undefined || !isWithin(dir, root) || path.resolve(dir) === path.resolve(root)) return [];
    return filesBelow(dir)
      .flatMap((file) => {
        const conceptId = this.identify(this.relPathOf(b, file));
        if (conceptId === null || conceptId === entry.conceptId) return [];
        const found = this.read(b, conceptId);
        return found?.entry.file === file ? [found as FileAsset] : [];
      })
      .sort((left, right) => compareCodePoints(left.conceptId, right.conceptId));
  }

  /** None when the adapter retires nothing: what its folder's archive holds is not its retirements. */
  retired(b: Bundle): Retirement[] {
    if (this.retires.length === 0) return [];
    return listTombstones(rootOf(b)).map((tombstone) => ({
      handle: tombstone.handle,
      conceptId: this.retiredConceptId(tombstone),
      note: qualifiedNote(b.id, noteOf(tombstone)),
      restorable: tombstone.archivedPath !== undefined && fs.existsSync(path.join(rootOf(b), tombstone.archivedPath)),
    }));
  }

  restore(b: Bundle, handle: string, fallback?: string | Buffer): AssetChange {
    this.requireRetiring(b);
    const tombstone = readTombstone(rootOf(b), handle);
    const conceptId = this.retiredConceptId(tombstone);
    if (this.identify(tombstone.originalPath) !== null) this.requireRetires(b, this.typeOf(tombstone.originalPath));
    const file = path.join(rootOf(b), tombstone.originalPath);
    assertWritableFile(rootOf(b), b.id, file);
    return { conceptId, changed: restoreArchive(rootOf(b), tombstone, fallback) };
  }

  forget(b: Bundle, handle: string): { changed: string[] } {
    this.requireRetiring(b);
    return { changed: forgetArchive(rootOf(b), handle) };
  }

  expireRetired(b: Bundle, before: Date): { changed: string[] } {
    this.requireRetiring(b);
    return { changed: expireArchive(rootOf(b), before) };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private requireRetiring(b: Bundle): void {
    if (this.retires.length === 0) {
      throw new Error(
        `Adapter "${this.id}" does not retire assets in bundle "${b.id}"; the asset facade checks \`retires\` first.`,
      );
    }
  }

  private requireRetires(b: Bundle, type: string): void {
    if (!this.retires.includes(type)) {
      throw new Error(
        `Adapter "${this.id}" does not retire ${type} assets in bundle "${b.id}"; the asset facade checks \`retires\` first.`,
      );
    }
  }

  /** The concept id a retired file had: its original path's, even when the file is gone. A path no asset has is named by itself without extension. */
  private retiredConceptId(tombstone: Tombstone): string {
    return this.identify(tombstone.originalPath) ?? tombstone.originalPath.replace(/\.[^./]+$/, "");
  }

  private walkOptions() {
    return { includeAllDirectories: this.walkMode === "all-directories" };
  }

  /** `file`'s path relative to the root, as the index keys it. */
  protected relPathOf(b: Bundle, file: string): string {
    return buildFileContext(rootOf(b), file).relPath;
  }

  private existing(b: Bundle, conceptId: string): FileAsset {
    const found = this.read(b, conceptId);
    if (!found?.entry.file) throw assetNotFound(`${b.id}//${conceptId}`);
    return found as FileAsset;
  }

  /** The bytes and file mode a write gives a file. */
  private writeFile(
    b: Bundle,
    type: string,
    file: string,
    bytes: string | Buffer,
    replaceLink: boolean | "any" = false,
    mode?: number,
  ): string[] {
    assertWritableFile(rootOf(b), b.id, file, { replaceLink });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Atomic: a crash or a full disk never leaves a half-written asset where a good one was.
    writeFileAtomic(file, bytes, mode ?? this.fileMode(type) ?? existingFileMode(file));
    return [file];
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

/** Whether `other` is `spelling` with the case of its extension changed (`x.MD` for `x.md`). */
function isCaseVariant(spelling: string, other: string): boolean {
  const extension = path.posix.extname(spelling);
  return (
    extension !== "" &&
    path.posix.dirname(spelling) === path.posix.dirname(other) &&
    path.posix.basename(spelling, extension) === path.posix.basename(other, path.posix.extname(other)) &&
    extension.toLowerCase() === path.posix.extname(other).toLowerCase()
  );
}

/** What decides which files hold a concept: the names in a folder, which of them are files, and which a walk reaches. */
interface FileView {
  /** False when the bundle's root is gone; refuses when it cannot be read. */
  rootExists(): boolean;
  /** The names directly inside the bundle-relative `dir`. */
  list(dir: string): string[];
  /** Whether `relPath` is a file, or a link to one, inside the bundle. */
  isFile(relPath: string): boolean;
  /** Whether a full walk reaches `relPath`. */
  isWalked(relPath: string, options: { includeAllDirectories: boolean }): boolean;
}

/** The bundle's files as they are on disk. */
function liveView(b: Bundle): FileView {
  return {
    rootExists() {
      try {
        fs.realpathSync(rootOf(b));
        return true;
      } catch (error) {
        // A root that is gone holds nothing. Any other failure (EACCES) is not "nothing": say the root is unreadable.
        if (hasErrnoCode(error, "ENOENT")) return false;
        throw new ConfigError(`Unable to read bundle directory at "${b.root}".`, "STASH_DIR_UNREADABLE");
      }
    },
    list(dir) {
      try {
        return fs.readdirSync(path.join(rootOf(b), dir));
      } catch {
        return [];
      }
    },
    isFile(relPath) {
      const authored = path.resolve(rootOf(b), relPath);
      if (!within(authored, rootOf(b))) return false;
      try {
        const stat = fs.lstatSync(authored);
        if (!stat.isFile() && !stat.isSymbolicLink()) return false;
        return fs.statSync(fs.realpathSync(authored)).isFile();
      } catch {
        return false;
      }
    },
    isWalked: (relPath, options) => isWalkedFile(rootOf(b), path.join(rootOf(b), relPath), options),
  };
}

/** The bundle's files with the pending overlay laid over them: a file with pending content is there, a deleted one is not. */
function snapshotView(b: Bundle, overlay: ReadonlyMap<string, string | null>): FileView {
  const live = liveView(b);
  const pending = new Map([...overlay].map(([relPath, content]) => [relPath, content !== null]));
  return {
    rootExists: live.rootExists,
    list(dir) {
      const names = new Set(live.list(dir));
      for (const [relPath, present] of pending) {
        if (path.posix.dirname(relPath) !== dir) continue;
        const name = path.posix.basename(relPath);
        if (present) names.add(name);
        else names.delete(name);
      }
      return [...names];
    },
    isFile: (relPath) => pending.get(relPath) ?? live.isFile(relPath),
    isWalked: (relPath, options) =>
      pending.get(relPath) === true || (!pending.has(relPath) && live.isWalked(relPath, options)),
  };
}

/** `spelling` and the names in its folder that differ from it only in the case of the extension: the exact one first, then by code point. */
function caseVariants(view: FileView, spelling: string): string[] {
  const extension = path.posix.extname(spelling);
  if (!extension) return [spelling];
  const dir = path.posix.dirname(spelling);
  const variants = view
    .list(dir)
    .map((name) => (dir === "." ? name : `${dir}/${name}`))
    .filter((relPath) => relPath !== spelling && isCaseVariant(spelling, relPath))
    .sort(compareCodePoints);
  return [spelling, ...variants];
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

/** The links to directories under `dir` (not followed, as the walk does), at any depth. */
function directoryLinksBelow(dir: string): string[] {
  const links: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) links.push(...directoryLinksBelow(entryPath));
    else if (entry.isSymbolicLink() && fs.statSync(entryPath, { throwIfNoEntry: false })?.isDirectory()) {
      links.push(entryPath);
    }
  }
  return links;
}

// ── Writing helpers ─────────────────────────────────────────────────────────

/**
 * Refuse a write to `file` that leaves the bundle's root, or passes through a
 * symbolic link below it: a write never follows a link out of the bundle.
 * With `replaceLink`, `file` itself may be a link to a file inside the bundle
 * (the write replaces the link and leaves what it pointed at), and a folder
 * above it may be a link to a folder inside the bundle (the write goes through).
 */
export function assertWritableFile(
  root: string,
  bundle: string,
  file: string,
  options: { replaceLink?: boolean | "any" } = {},
): void {
  const lexicalRoot = path.resolve(root);
  // A path under another spelling of the root (a symlinked spelling of the library) is inside it.
  const relative = relativeToRoot(file, lexicalRoot) ?? "..";
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new UsageError(`Write path resolves outside source "${bundle}".`, "PATH_ESCAPE_VIOLATION");
  }
  let current = lexicalRoot;
  try {
    current = fs.realpathSync(lexicalRoot);
  } catch {
    // A root that is not there yet holds no link to follow.
  }
  const realRoot = current;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      const last = index === segments.length - 1;
      // `"any"`: the file itself may be a link to anywhere (or to nothing): it is replaced, never written through.
      if (options.replaceLink === "any" && last) break;
      if (options.replaceLink && linksInside(current, realRoot, last)) {
        if (last) break;
        continue;
      }
      throw new UsageError(`Write path contains a symbolic link below source "${bundle}": ${relative}`);
    }
  }
}

/** Where `file` really is, when it is reached through a symbolic link and that is a file inside `root`; undefined otherwise. */
function linkTargetInside(root: string, file: string): string | undefined {
  try {
    const real = fs.realpathSync(file);
    const realRoot = fs.realpathSync(root);
    return real !== file && fs.statSync(real).isFile() && isWithin(real, realRoot) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the symbolic link `link` points at an existing file (a folder, when not `file`) inside `root`. */
function linksInside(link: string, root: string, file: boolean): boolean {
  try {
    const stat = fs.statSync(link);
    return (file ? stat.isFile() : stat.isDirectory()) && isWithin(link, root);
  } catch {
    return false;
  }
}
