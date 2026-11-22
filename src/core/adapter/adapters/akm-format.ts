// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The base of the adapters of the akm formats (`akm`, `dotenv`, `akm-workflow`):
 * how they place and serialize the assets they write. Each type goes in its own
 * folder (`knowledge/`, `env/`, `secrets/`, ...), named by the type's placement
 * spec, and Markdown is made a conformant akm document. An env file's or
 * secret's `.sensitive` marker keeps it out of listings.
 */

import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { declaredTypeForPath } from "../../../indexer/walk/matchers";
import { normalizeAkmMarkdown } from "../../asset/akm-markdown";
import { assetPathForName, stashDirFor } from "../../asset/asset-placement";
import { UsageError } from "../../errors";
import { warn, warnOnce } from "../../warn";
import type { NewAsset } from "../bundle-adapter";
import { DirectoryAdapterBase } from "../directory-adapter";
import type { Bundle } from "../types";

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
export function placeInTypeFolder(b: Bundle, { type, name }: Pick<NewAsset, "type" | "name">): string {
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
  const typeRoot = path.join(b.root, typeDir);
  const file = assetPathForName(type, typeRoot, name);
  const relative = path.relative(typeRoot, file);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UsageError(
      `Resolved asset path escapes its source: "${name}" in bundle "${b.id}".`,
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

/**
 * The path of the sibling marker file that keeps an env file or secret out of
 * listings: `<name>.sensitive` for an env file, `<secret>.sensitive` for a secret.
 */
export function sensitiveMarkerPath(assetPath: string, type: "env" | "secret"): string {
  return type === "env" ? assetPath.replace(/\.env$/, ".sensitive") : `${assetPath}.sensitive`;
}

export abstract class AkmFormatAdapterBase extends DirectoryAdapterBase {
  protected override placeFile(b: Bundle, asset: Pick<NewAsset, "type" | "name">): string {
    return placeInTypeFolder(b, asset);
  }

  protected override serialize(type: string, file: string, content: string | Buffer): string | Buffer {
    return serializeAkmContent(type, file, content);
  }

  /** Env files and secrets are readable by their owner only. */
  protected override fileMode(type: string): number | undefined {
    return type === "env" || type === "secret" ? 0o600 : undefined;
  }

  protected override unlistedMarker(file: FileContext): string | undefined {
    const type = declaredTypeForPath(file);
    if (type !== "env" && type !== "secret") return undefined;
    const marker = sensitiveMarkerPath(file.absPath, type);
    return marker === file.absPath ? undefined : marker;
  }

  protected override declaredType(file: FileContext): string | undefined {
    return declaredTypeForPath(file);
  }
}
