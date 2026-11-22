// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * How the akm formats place and serialize the assets they write: each type in
 * its own folder (`knowledge/`, `env/`, `secrets/`, ...), named by the type's
 * placement spec, Markdown made a conformant akm document. The `akm`,
 * `dotenv` and `akm-workflow` adapters write through these.
 */

import path from "node:path";
import { normalizeAkmMarkdown } from "../../asset/akm-markdown";
import { assetPathForName, placementTypes, stashDirFor } from "../../asset/asset-placement";
import { UsageError } from "../../errors";
import { warn, warnOnce } from "../../warn";
import type { NewAsset } from "../bundle-adapter";
import type { BundleComponent } from "../types";
import type { DirectoryWrites } from "./directory-assets";

/** MS-DOS device names Windows reserves in every directory, with or without an extension. */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Matches an absolute host home path (`/home/<user>`, `/Users/<user>`) with at
 * least one user segment. Deliberately does not exempt fenced code, so content
 * that documents such a path can trip it; the advisory is non-fatal.
 */
const ABSOLUTE_HOME_PATH_RE = /\/(?:home|Users)\/[^\s/"'`)\]}<>|:;,]+/g;

/** Distinct `/home/<user>` / `/Users/<user>` prefixes in `content`, first-seen order. */
export function findAbsoluteHomePaths(content: string): string[] {
  const seen = new Set<string>();
  for (const match of content.matchAll(ABSOLUTE_HOME_PATH_RE)) seen.add(match[0]);
  return [...seen];
}

/** The file an asset of `type` and `name` is kept in: `<type folder>/<name><suffix>`, inside that folder. */
export function placeInTypeFolder(c: BundleComponent, { type, name }: Pick<NewAsset, "type" | "name">): string {
  const basename = path.posix.basename(name.replaceAll("\\", "/")).replace(/\.md$/i, "").toLowerCase();
  if (basename === "index" || basename === "log") {
    warnOnce(
      `write-source:reserved-basename:${basename}`,
      `Concept name "${basename}" collides with a reserved word some tooling treats specially; writing it anyway.`,
    );
  }
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(basename)) {
    warnOnce(
      `write-source:windows-device-name:${basename}`,
      `Asset name "${basename}" is a reserved Windows device name; writing it anyway, but this bundle will not be portable to Windows.`,
    );
  }
  const typeDir = stashDirFor(type);
  if (!typeDir)
    throw new UsageError(`Unknown asset type "${type}". Cannot resolve a write path.`, "INVALID_FLAG_VALUE");
  const typeRoot = path.join(c.root, typeDir);
  const file = assetPathForName(type, typeRoot, name);
  const relative = path.relative(typeRoot, file);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UsageError(
      `Resolved asset path escapes its source: "${name}" in bundle "${c.id}".`,
      "PATH_ESCAPE_VIOLATION",
    );
  }
  return file;
}

/**
 * The bytes an akm asset file holds. An env file and a secret are kept exactly
 * as given. Text ends in a line break, and Markdown of a type is made a
 * conformant akm document.
 */
export function serializeAkmContent(type: string, file: string, content: string | Buffer): string | Buffer {
  if (type === "env" || type === "secret" || Buffer.isBuffer(content)) return content;
  const authored = file.toLowerCase().endsWith(".md") ? normalizeAkmMarkdown(content, type) : content;
  const text = authored === "" || authored.endsWith("\n") ? authored : `${authored}\n`;
  const hostPaths = findAbsoluteHomePaths(text);
  if (hostPaths.length > 0) {
    // Non-fatal portability advisory.
    warn(
      `warning: asset "${path.basename(file)}" embeds absolute host path(s): ${hostPaths.join(", ")}. ` +
        "These make the stash non-portable and leak the local username — prefer $HOME or ~ relative references.",
    );
  }
  return text;
}

/** An akm bundle writes every type it has a folder for. */
export const akmWrites: DirectoryWrites = {
  types: placementTypes(),
  place: placeInTypeFolder,
  serialize: serializeAkmContent,
};

/** A dotenv bundle writes its env files and secrets. */
export const dotenvWrites: DirectoryWrites = {
  types: ["env", "secret"],
  place: placeInTypeFolder,
  serialize: serializeAkmContent,
};

/** A standalone workflow bundle keeps its workflows at its root, one Markdown file each. */
export const workflowBundleWrites: DirectoryWrites = {
  types: ["workflow"],
  place: (c, { name }) => path.join(c.root, `${name}.md`),
  serialize: serializeAkmContent,
};
