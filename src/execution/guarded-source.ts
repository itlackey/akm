// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../core/asset/frontmatter";
import { compareCodePoints, toPosix } from "../core/common";
import { UsageError } from "../core/errors";
import type { FileContext } from "../indexer/walk/file-context";
import { createExecutionSourceIdentity, type ExecutionSourceIdentity } from "./source";

export interface GuardedExecutionSourceCaptureOptions {
  readonly identity?: ExecutionSourceIdentity;
  readonly authored?: boolean;
}

export interface GuardedExecutionSource {
  readonly sourcePath: string;
  readonly relativePath: string;
  readonly realPath: string;
  readonly containmentRoot: string;
  readonly containmentRealPath: string;
  readonly containmentPhysicalIdentity: string;
  readonly physicalIdentity: string;
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly sha256: string;
  readonly bytesBase64: string;
  readonly content: string;
  readonly authored: boolean;
  readonly identity?: Readonly<ExecutionSourceIdentity>;
}

export interface GuardedDirectoryManifestEntry {
  readonly name: string;
  readonly kind: "directory" | "file" | "symlink";
  readonly physicalIdentity: string;
  readonly version: string;
  /** `readlink` text, no-follow. Present only when `kind` is `"symlink"`. */
  readonly target?: string;
}

export interface GuardedDirectoryManifest {
  readonly directoryPath: string;
  readonly relativePath: string;
  readonly realPath: string;
  readonly containmentRoot: string;
  readonly containmentRealPath: string;
  readonly containmentPhysicalIdentity: string;
  readonly physicalIdentity: string;
  readonly version: string;
  readonly entries: readonly GuardedDirectoryManifestEntry[];
}

export interface GuardedExecutionSourceSnapshot {
  readonly sources: readonly GuardedExecutionSource[];
  readonly directoryManifests: readonly GuardedDirectoryManifest[];
}

interface CapturedSourceRecord {
  source: GuardedExecutionSource;
  readonly stat: fs.Stats;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function physicalIdentity(realPath: string, stat: fs.BigIntStats): string {
  return stat.ino === 0n ? `path:${realPath}` : `inode:${stat.dev}:${stat.ino}`;
}

function statVersion(stat: fs.BigIntStats): string {
  return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function sameBigIntStat(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function containedRelative(root: string, candidate: string, allowRoot: boolean): string {
  const relative = path.relative(root, candidate);
  if ((!allowRoot && relative === "") || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UsageError(`${candidate} resolves outside its guarded containment root.`, "PATH_ESCAPE_VIOLATION");
  }
  return relative;
}

function requireContainmentRoot(containmentRootInput: string): {
  containmentRoot: string;
  containmentRealPath: string;
  containmentStat: fs.BigIntStats;
} {
  const containmentRoot = path.resolve(containmentRootInput);
  const containmentRealPath = fs.realpathSync(containmentRoot);
  const containmentStat = fs.statSync(containmentRealPath, { bigint: true });
  if (!containmentStat.isDirectory()) {
    throw new UsageError(`${containmentRootInput} is not a guarded source directory.`, "INVALID_FLAG_VALUE");
  }
  return { containmentRoot, containmentRealPath, containmentStat };
}

function numberStat(stat: fs.BigIntStats): fs.Stats {
  return new Proxy(stat, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      return typeof value === "bigint" ? Number(value) : value;
    },
  }) as unknown as fs.Stats;
}

function decodeUtf8(bytes: Uint8Array, sourcePath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new UsageError(`${sourcePath} contains invalid UTF-8 bytes.`, "INVALID_FLAG_VALUE");
  }
}

function freezeSource(
  source: Omit<GuardedExecutionSource, "identity"> & {
    readonly identity?: ExecutionSourceIdentity;
  },
): GuardedExecutionSource {
  const identity = source.identity ? createExecutionSourceIdentity(source.identity) : undefined;
  return Object.freeze({ ...source, ...(identity ? { identity } : {}) });
}

function captureRecord(
  sourcePathInput: string,
  containmentRootInput: string,
  options: GuardedExecutionSourceCaptureOptions = {},
): CapturedSourceRecord {
  const sourcePath = path.resolve(sourcePathInput);
  const { containmentRoot, containmentRealPath, containmentStat } = requireContainmentRoot(containmentRootInput);
  const lexicalRelative = containedRelative(containmentRoot, sourcePath, false);

  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new UsageError(`${sourcePath} is not a regular guarded source file.`, "INVALID_FLAG_VALUE");
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameBigIntStat(before, after) || BigInt(bytes.byteLength) !== before.size) {
      throw new UsageError(`${sourcePath} changed while its guarded bytes were read.`, "RESOURCE_ALREADY_EXISTS");
    }

    const pathnameStat = fs.lstatSync(sourcePath, { bigint: true });
    if (pathnameStat.isSymbolicLink()) {
      throw new UsageError(
        `${sourcePath} is a symbolic source; guarded reads require a regular no-follow owner.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    if (!pathnameStat.isFile() || pathnameStat.dev !== before.dev || pathnameStat.ino !== before.ino) {
      throw new UsageError(
        `${sourcePath} changed physical identity during its guarded read.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    const realPath = fs.realpathSync(sourcePath);
    containedRelative(containmentRealPath, realPath, false);
    const content = decodeUtf8(bytes, sourcePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (options.identity && options.identity.hash !== sha256) {
      throw new UsageError(
        `${sourcePath} adapter identity hash does not match its guarded bytes.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    if (options.identity && options.identity.file !== toPosix(lexicalRelative)) {
      throw new UsageError(
        `${sourcePath} adapter identity file does not match its guarded relative path.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    return {
      source: freezeSource({
        sourcePath,
        relativePath: toPosix(lexicalRelative),
        realPath,
        containmentRoot,
        containmentRealPath,
        containmentPhysicalIdentity: physicalIdentity(containmentRealPath, containmentStat),
        physicalIdentity: physicalIdentity(realPath, before),
        size: bytes.byteLength,
        mtimeNs: String(before.mtimeNs),
        ctimeNs: String(before.ctimeNs),
        sha256,
        bytesBase64: bytes.toString("base64"),
        content,
        authored: options.authored ?? false,
        ...(options.identity ? { identity: options.identity } : {}),
      }),
      stat: numberStat(before),
    };
  } catch (cause) {
    if (cause instanceof UsageError) throw cause;
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      let linked: string | undefined;
      try {
        linked = fs.realpathSync(sourcePath);
      } catch {
        // The no-follow failure itself is sufficient when the link is broken.
      }
      if (linked) {
        const relative = path.relative(containmentRealPath, linked);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new UsageError(
            `${sourcePath} resolves outside its containment root through a symbolic source.`,
            "PATH_ESCAPE_VIOLATION",
          );
        }
      }
      throw new UsageError(
        `${sourcePath} is a symbolic source; guarded reads require a regular no-follow owner.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    throw new UsageError(
      `${sourcePath} could not be guarded as a contained regular source: ${errorMessage(cause)}`,
      code === "ENOENT" ? "RESOURCE_ALREADY_EXISTS" : "PATH_ESCAPE_VIOLATION",
    );
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function captureGuardedExecutionSource(
  sourcePath: string,
  containmentRoot: string,
  options: GuardedExecutionSourceCaptureOptions = {},
): GuardedExecutionSource {
  return captureRecord(sourcePath, containmentRoot, options).source;
}

export function captureGuardedDirectoryManifest(
  directoryPathInput: string,
  containmentRootInput: string,
): GuardedDirectoryManifest {
  const directoryPath = path.resolve(directoryPathInput);
  const { containmentRoot, containmentRealPath, containmentStat } = requireContainmentRoot(containmentRootInput);
  const lexicalRelative = containedRelative(containmentRoot, directoryPath, true);
  try {
    const before = fs.lstatSync(directoryPath, { bigint: true });
    if (before.isSymbolicLink()) {
      throw new UsageError(
        `${directoryPath} is a symbolic directory with ambiguous guarded identity.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    if (!before.isDirectory()) {
      throw new UsageError(`${directoryPath} is not a guarded directory.`, "INVALID_FLAG_VALUE");
    }
    const realPath = fs.realpathSync(directoryPath);
    containedRelative(containmentRealPath, realPath, true);
    const entries = fs
      .readdirSync(directoryPath, { withFileTypes: true })
      .sort((left, right) => compareCodePoints(left.name, right.name))
      .map((entry): GuardedDirectoryManifestEntry => {
        const entryPath = path.join(directoryPath, entry.name);
        const entryStat = fs.lstatSync(entryPath, { bigint: true });
        if (entry.isSymbolicLink() || entryStat.isSymbolicLink()) {
          let linked: string | undefined;
          try {
            linked = fs.realpathSync(entryPath);
          } catch {
            // Broken symbolic entries still have ambiguous ownership.
          }
          if (linked) {
            const relative = path.relative(containmentRealPath, linked);
            if (relative.startsWith("..") || path.isAbsolute(relative)) {
              throw new UsageError(
                `${entryPath} resolves outside the bundle root through a symbolic source.`,
                "PATH_ESCAPE_VIOLATION",
              );
            }
            // A symlink that stays inside the containment root is recorded as
            // its own kind, identified without following it (readlink text
            // plus its own no-follow lstat identity), so change detection
            // still works. It is never a directory or file candidate to any
            // manifest consumer.
            return Object.freeze({
              name: entry.name,
              kind: "symlink" as const,
              physicalIdentity: physicalIdentity(entryPath, entryStat),
              version: statVersion(entryStat),
              target: fs.readlinkSync(entryPath),
            });
          }
          throw new UsageError(
            `${entryPath} is a symbolic source with a physical source identity collision; guarded reads require one no-follow owner.`,
            "RESOURCE_ALREADY_EXISTS",
          );
        }
        const kind =
          entry.isDirectory() && entryStat.isDirectory()
            ? "directory"
            : entry.isFile() && entryStat.isFile()
              ? "file"
              : undefined;
        if (!kind) {
          throw new UsageError(`${entryPath} is neither a regular file nor directory.`, "INVALID_FLAG_VALUE");
        }
        const entryRealPath = fs.realpathSync(entryPath);
        containedRelative(containmentRealPath, entryRealPath, false);
        return Object.freeze({
          name: entry.name,
          kind,
          physicalIdentity: physicalIdentity(entryRealPath, entryStat),
          version: statVersion(entryStat),
        });
      });
    const after = fs.lstatSync(directoryPath, { bigint: true });
    if (!sameBigIntStat(before, after)) {
      throw new UsageError(
        `${directoryPath} changed while its guarded directory manifest was read.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    return Object.freeze({
      directoryPath,
      relativePath: lexicalRelative === "" ? "." : toPosix(lexicalRelative),
      realPath,
      containmentRoot,
      containmentRealPath,
      containmentPhysicalIdentity: physicalIdentity(containmentRealPath, containmentStat),
      physicalIdentity: physicalIdentity(realPath, before),
      version: statVersion(before),
      entries: Object.freeze(entries),
    });
  } catch (cause) {
    if (cause instanceof UsageError) throw cause;
    throw new UsageError(
      `${directoryPath} could not be captured as a guarded directory manifest: ${errorMessage(cause)}`,
      (cause as NodeJS.ErrnoException).code === "ENOENT" ? "RESOURCE_ALREADY_EXISTS" : "PATH_ESCAPE_VIOLATION",
    );
  }
}

function sameSnapshotValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceSortKey(source: GuardedExecutionSource): string {
  const identity = source.identity;
  return identity
    ? `${identity.ref}\0${identity.adapter}\0${identity.file}`
    : `${source.containmentRealPath}\0${source.relativePath}`;
}

function directorySortKey(manifest: GuardedDirectoryManifest): string {
  return `${manifest.containmentRealPath}\0${manifest.relativePath}`;
}

export class GuardedExecutionSourceCollector {
  readonly #sources = new Map<string, CapturedSourceRecord>();
  readonly #directories = new Map<string, GuardedDirectoryManifest>();

  capture(
    sourcePath: string,
    containmentRoot: string,
    options: GuardedExecutionSourceCaptureOptions = {},
  ): GuardedExecutionSource {
    const key = path.resolve(sourcePath);
    const existing = this.#sources.get(key);
    if (existing) {
      if (options.identity) return this.bindIdentity(sourcePath, containmentRoot, options.identity);
      return existing.source;
    }
    const record = captureRecord(sourcePath, containmentRoot, options);
    this.#assertNoPhysicalOwnerAlias(record.source);
    this.#sources.set(key, record);
    return record.source;
  }

  readBytes(
    sourcePath: string,
    containmentRoot: string,
    options: GuardedExecutionSourceCaptureOptions = {},
  ): Uint8Array {
    return Buffer.from(this.capture(sourcePath, containmentRoot, options).bytesBase64, "base64");
  }

  fileContext(root: string, file: string, options: GuardedExecutionSourceCaptureOptions = {}): FileContext {
    const source = this.capture(file, root, options);
    const record = this.#sources.get(path.resolve(file));
    if (!record) throw new Error("guarded source collector lost a captured file");
    const relPath = source.relativePath;
    const ext = path.extname(file).toLowerCase();
    const fileName = path.basename(file);
    const parentDirAbs = path.dirname(path.resolve(file));
    const relDir = path.posix.dirname(relPath);
    const ancestorDirs = relDir === "." ? [] : relDir.split("/").filter(Boolean);
    let frontmatter: Record<string, unknown> | null | undefined;
    let parsed = false;
    return {
      absPath: path.resolve(file),
      relPath,
      ext,
      fileName,
      parentDir: path.basename(parentDirAbs),
      parentDirAbs,
      ancestorDirs,
      stashRoot: path.resolve(root),
      content: () => source.content,
      frontmatter: () => {
        if (!parsed) {
          const result = parseFrontmatter(source.content);
          frontmatter = Object.keys(result.data).length > 0 ? result.data : null;
          parsed = true;
        }
        return frontmatter ?? null;
      },
      stat: () => record.stat,
    };
  }

  bindIdentity(
    sourcePath: string,
    containmentRoot: string,
    identityInput: ExecutionSourceIdentity,
  ): GuardedExecutionSource {
    const key = path.resolve(sourcePath);
    const existing = this.#sources.get(key) ?? captureRecord(sourcePath, containmentRoot);
    const identity = createExecutionSourceIdentity(identityInput);
    if (identity.file !== existing.source.relativePath || identity.hash !== existing.source.sha256) {
      throw new UsageError(
        `${sourcePath} adapter identity does not match its guarded file owner or bytes.`,
        "RESOURCE_ALREADY_EXISTS",
      );
    }
    if (existing.source.identity) {
      if (!sameSnapshotValue(existing.source.identity, identity)) {
        throw new UsageError(
          `${sourcePath} already has a different guarded logical owner identity.`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }
      return existing.source;
    }
    const source = freezeSource({ ...existing.source, identity });
    this.#assertNoPhysicalOwnerAlias(source, key);
    this.#sources.set(key, { ...existing, source });
    return source;
  }

  trackDirectory(directoryPath: string, containmentRoot: string): GuardedDirectoryManifest {
    const manifest = captureGuardedDirectoryManifest(directoryPath, containmentRoot);
    const key = path.resolve(directoryPath);
    const existing = this.#directories.get(key);
    if (existing && !sameSnapshotValue(existing, manifest)) {
      throw new UsageError(`${directoryPath} changed between guarded directory reads.`, "RESOURCE_ALREADY_EXISTS");
    }
    if (!existing) this.#directories.set(key, manifest);
    return existing ?? manifest;
  }

  enumerateTree(directoryPath: string, containmentRoot: string): readonly string[] {
    const files: string[] = [];
    const visit = (directory: string): void => {
      const manifest = this.trackDirectory(directory, containmentRoot);
      for (const entry of manifest.entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.kind === "directory") visit(candidate);
        else if (entry.kind === "file") files.push(candidate);
        // A "symlink" entry is recorded for change detection but is never
        // read, descended into, or made a candidate source.
      }
    };
    visit(path.resolve(directoryPath));
    return Object.freeze(files.sort(compareCodePoints));
  }

  snapshot(): GuardedExecutionSourceSnapshot {
    return Object.freeze({
      sources: Object.freeze(
        [...this.#sources.values()]
          .map((record) => record.source)
          .sort((left, right) => compareCodePoints(sourceSortKey(left), sourceSortKey(right))),
      ),
      directoryManifests: Object.freeze(
        [...this.#directories.values()].sort((left, right) =>
          compareCodePoints(directorySortKey(left), directorySortKey(right)),
        ),
      ),
    });
  }

  /**
   * Merge another collector's captured sources and directory manifests into
   * this one (A-N7, spec docs/plans/specs/p3a-plan-v5-child-freeze.md §4.2
   * step 6). The recursive child-workflow freeze gives each child its OWN
   * fresh collector, so a child's plan (and therefore its `planHash`) is a
   * pure function of its own source, independent of its position in the
   * parent (A-N7's rejected alternative: sharing the parent's collector,
   * which would make an identical child hash differently depending on what
   * the parent had already captured). The parent then absorbs the child's
   * records so its own final pre-publication CAS ({@link revalidate}) covers
   * every child file too.
   *
   * Re-runs `#assertNoPhysicalOwnerAlias` for each newly-absorbed source
   * record, so the shared-physical-owner authority holds ACROSS the
   * composition, not just within one workflow's own freeze. A record whose
   * key (resolved source path) is already present is required to be
   * byte-identical to the one already held — two DISJOINT branches
   * composing the SAME child (a diamond, not a cycle) absorb the same file
   * twice with identical content and pass silently; two branches that
   * somehow captured the same path with different content fail closed.
   */
  absorb(other: GuardedExecutionSourceCollector): void {
    for (const [key, record] of other.#sources) {
      const existing = this.#sources.get(key);
      if (existing) {
        if (!sameSnapshotValue(existing.source, record.source)) {
          throw new UsageError(
            `${record.source.sourcePath} was captured with conflicting content across a composed workflow freeze.`,
            "RESOURCE_ALREADY_EXISTS",
          );
        }
        continue;
      }
      this.#assertNoPhysicalOwnerAlias(record.source);
      this.#sources.set(key, record);
    }
    for (const [key, manifest] of other.#directories) {
      const existing = this.#directories.get(key);
      if (existing) {
        if (!sameSnapshotValue(existing, manifest)) {
          throw new UsageError(
            `${manifest.directoryPath} changed between guarded directory reads across a composed workflow freeze.`,
            "RESOURCE_ALREADY_EXISTS",
          );
        }
        continue;
      }
      this.#directories.set(key, manifest);
    }
  }

  revalidate(): void {
    for (const record of this.#sources.values()) {
      let current: GuardedExecutionSource;
      try {
        current = captureRecord(record.source.sourcePath, record.source.containmentRoot, {
          authored: record.source.authored,
          ...(record.source.identity ? { identity: record.source.identity } : {}),
        }).source;
      } catch (cause) {
        throw new UsageError(
          `Guarded execution source read set changed before publication: ${errorMessage(cause)}`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }
      if (!sameSnapshotValue(record.source, current)) {
        throw new UsageError(
          "Guarded execution source read set changed before publication.",
          "RESOURCE_ALREADY_EXISTS",
        );
      }
    }
    for (const manifest of this.#directories.values()) {
      let current: GuardedDirectoryManifest;
      try {
        current = captureGuardedDirectoryManifest(manifest.directoryPath, manifest.containmentRoot);
      } catch (cause) {
        throw new UsageError(
          `Guarded execution source directory manifest changed before publication: ${errorMessage(cause)}`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }
      if (!sameSnapshotValue(manifest, current)) {
        throw new UsageError(
          "Guarded execution source directory manifest changed before publication.",
          "RESOURCE_ALREADY_EXISTS",
        );
      }
    }
  }

  #assertNoPhysicalOwnerAlias(candidate: GuardedExecutionSource, selfKey?: string): void {
    if (!candidate.identity) return;
    for (const [key, record] of this.#sources) {
      if (key === selfKey || !record.source.identity) continue;
      if (
        record.source.containmentPhysicalIdentity === candidate.containmentPhysicalIdentity &&
        record.source.physicalIdentity === candidate.physicalIdentity &&
        !sameSnapshotValue(record.source.identity, candidate.identity)
      ) {
        throw new UsageError(
          `${candidate.sourcePath} aliases the same physical source and root under a different logical owner.`,
          "RESOURCE_ALREADY_EXISTS",
        );
      }
    }
  }
}
