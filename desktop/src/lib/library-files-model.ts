// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** What akm accepts doing to an entry, or the sentence why not. Desktop shows it and decides nothing. */
export type Verdict = { allowed: true } | { allowed: false; reason: string };
export type FileAction = "read" | "edit" | "move" | "copy" | "retire" | "delete";
export type FileActions = Record<FileAction, Verdict>;

/** Presentation of AKM-owned directory listings. No source traversal lives here. */
export interface FileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "other";
  assets: Array<{ ref: string; type: string }>;
  actions: FileActions;
  /** A file's bytes; absent for a folder and for a file akm could not read. */
  size?: number;
  /** ISO time; absent when akm could not read it. */
  modified?: string;
  /** akm types the file `env` or `secret`: its text opens only in the protected-file view. */
  protected?: boolean;
  symlink?: true;
  unavailable?: string;
}
export interface FileListing {
  bundle: string;
  path: string;
  parent: string | null;
  entries: FileEntry[];
  indexAvailable: boolean;
  /** A new file here: allowed with the type akm gives it (null: a plain file), or the reason not. */
  newFile: Verdict & { type: string | null; through?: "protected-editor" };
  /** A folder made here, or an entry moved or copied in. */
  place: Verdict;
}
export interface FileLocation {
  bundle: string;
  path: string;
  file?: string;
  ref?: string;
  open?: boolean;
}
export interface FilesViewState {
  listings?: Map<string, FileListing>;
  expanded?: Set<string>;
  focused?: string;
  showHidden?: boolean;
  location?: string;
  scroll?: number;
  revision?: number;
}
export interface TreeNode extends Omit<FileEntry, "actions"> {
  /** A bundle's root is no entry of a listing, so akm gives it none. */
  actions?: FileActions;
  bundle: string;
  key: string;
  level: number;
  parentKey: string | null;
  root?: boolean;
  position: number;
  setSize: number;
}
export function directoryKey(bundle: string, path: string): string {
  return JSON.stringify([bundle, path]);
}
export function parentPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}
export function ancestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join("/"))];
}
export function filesHref(location: FileLocation, readingFrom = ""): string {
  const query = new URLSearchParams({ bundle: location.bundle, path: location.path });
  if (location.file) query.set("file", location.file);
  if (location.ref) query.set("ref", location.ref);
  if (location.open || location.ref) query.set("open", "1");
  if (readingFrom) query.set("readingFrom", readingFrom);
  return `/library/files?${query}`;
}
export function parseFilesHref(href: string | null): URLSearchParams | null {
  return href && /^\/library\/files(?:\?|$)/.test(href) ? new URLSearchParams(href.split("?")[1] ?? "") : null;
}
export function treeNodes(bundles: string[], listings: Map<string, FileListing>, expanded: Set<string>): TreeNode[] {
  const result: TreeNode[] = [];
  function visit(node: TreeNode) {
    result.push(node);
    if (node.kind !== "directory" || !expanded.has(node.key)) return;
    const children = listings.get(node.key)?.entries ?? [];
    children.forEach((entry, i) => {
      visit({
        ...entry,
        bundle: node.bundle,
        key: directoryKey(node.bundle, entry.path),
        level: node.level + 1,
        parentKey: node.key,
        position: i + 1,
        setSize: children.length,
      });
    });
  }
  bundles.forEach((bundle, i) => {
    visit({
      bundle,
      name: bundle,
      path: "",
      assets: [],
      kind: "directory",
      key: directoryKey(bundle, ""),
      level: 1,
      parentKey: null,
      root: true,
      position: i + 1,
      setSize: bundles.length,
    });
  });
  return result;
}

/** The folder `chosen` relative to `root` ("" for `root` itself), or null when it is outside `root`. */
export function folderUnder(root: string, chosen: string): string | null {
  const clean = (path: string) => path.replace(/[\\/]+$/, "").replaceAll("\\", "/");
  const base = clean(root);
  const target = clean(chosen);
  if (target === base) return "";
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : null;
}

/** What akm's verdict for a new file here names on the button: the type akm gives the folder, or a plain file. */
export function newFileLabel(newFile: FileListing["newFile"] | undefined): string {
  if (newFile?.through === "protected-editor") return newFile.type === "secret" ? "New secret" : "New environment file";
  return newFile?.type ? `New ${newFile.type}` : "New file";
}

export function sizeText(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A modified time that fits one line: month, day and time, with the year only when it is not this year's. */
export function modifiedShort(iso: string | undefined, now = new Date()): string {
  if (!iso) return "";
  const when = new Date(iso);
  if (Number.isNaN(when.valueOf())) return "";
  return when.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Where a path goes when the folder `from` is renamed or moved to `to`; null when the path is not inside `from`. */
export function followMove(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
}

export function createSensitiveHref(kind: string, bundle: string, path: string): string {
  return "/library/new-sensitive?" + new URLSearchParams({ kind, bundle, returnTo: filesHref({ bundle, path }) });
}

/** A file operation that asks first: a move or copy to a folder, a drop onto a folder, or a delete. */
export interface FileRequest {
  kind: "move" | "copy" | "drop" | "delete";
  bundle: string;
  path: string;
  name: string;
  /** What akm accepts doing to the entry. */
  actions: FileActions;
  /** Where it is dropped, or the folder the picker starts in. */
  destination: { bundle: string; path: string };
}

/** akm's list of the links that still name the old place of an asset that was moved, per bundle. */
export interface MovedLinksReport {
  bundles: Array<{
    bundle: string;
    writable: boolean;
    writeBlocker: string | null;
    links: Array<{ ref: string; file: string; from: string; to: string }>;
  }>;
  total: number;
}
