// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Presentation of AKM-owned directory listings. No source traversal lives here. */
export interface FileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "other";
  assets: Array<{ ref: string; type: string }>;
  symlink?: true;
  unavailable?: string;
}
export interface FileListing {
  bundle: string;
  path: string;
  parent: string | null;
  entries: FileEntry[];
  indexAvailable: boolean;
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
export interface TreeNode extends FileEntry {
  bundle: string;
  key: string;
  level: number;
  parentKey: string | null;
  root?: boolean;
  position: number;
  size: number;
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
        size: children.length,
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
      size: bundles.length,
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
