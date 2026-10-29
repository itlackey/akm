// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { applyEdits, modify } from "jsonc-parser";
import { parse as parseToml, type TomlTable } from "smol-toml";
import { existingFileMode, parseJsonc, timestampForFilename, writeFileAtomic } from "../../core/common";
import type { UpgradeChannel } from "../../sources/types";

export interface ChannelEdit {
  file: string;
  content: string;
}

/** Preserve unrelated settings and comments; only the named native key changes. */
export function editChannelJson(
  file: string,
  keys: (string | number)[],
  value: unknown,
  content?: string,
): ChannelEdit {
  const before = content ?? fs.readFileSync(file, "utf8");
  parseJsonc(before);
  const after = applyEdits(
    before,
    modify(before, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
  );
  parseJsonc(after);
  return { file, content: after };
}

export function backupChannelFile(file: string): string {
  const backup = `${file}.akm-channel-${timestampForFilename()}-${process.pid}.bak`;
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, existingFileMode(file) ?? 0o600);
  return backup;
}

export class ChannelWriteError extends Error {
  constructor(
    cause: unknown,
    public backups: string[],
    public writtenFiles: string[],
  ) {
    super(`Channel settings could not all be written: ${String(cause)}. Backups: ${backups.join(", ") || "none"}`);
  }
}

export function writeChannelEdits(edits: ChannelEdit[]): string[] {
  const backups: string[] = [];
  const writtenFiles: string[] = [];
  try {
    const changed = edits.filter(({ file, content }) => fs.readFileSync(file, "utf8") !== content);
    for (const { file } of changed) backups.push(backupChannelFile(file));
    for (const { file, content } of changed) {
      writeFileAtomic(file, content, existingFileMode(file));
      writtenFiles.push(file);
    }
    return backups;
  } catch (error) {
    throw new ChannelWriteError(error, backups, writtenFiles);
  }
}

/** Claude has no command to change a registered marketplace's ref in place. Never remove the marketplace. */
export function claudeChannelEdits(
  configDir: string,
  pluginsRoot: string,
  channel: UpgradeChannel,
  projectPaths: string[] = [],
): ChannelEdit[] {
  const ref = channel === "next" ? "next" : undefined;
  const knownFile = path.join(pluginsRoot, "known_marketplaces.json");
  const known = parseJsonc(fs.readFileSync(knownFile, "utf8")) as Record<string, { source?: { source?: string } }>;
  const source = known["akm-plugins"]?.source;
  if (!source || !["github", "git"].includes(source.source ?? "")) {
    throw new Error("the akm-plugins marketplace has no Git source whose channel can be switched");
  }
  const edits = [editChannelJson(knownFile, ["akm-plugins", "source", "ref"], ref)];
  const settingsFiles = [
    path.join(configDir, "settings.json"),
    ...[process.cwd(), ...projectPaths].flatMap((project) => [
      path.join(project, ".claude", "settings.json"),
      path.join(project, ".claude", "settings.local.json"),
    ]),
  ];
  for (const file of new Set(settingsFiles)) {
    if (!fs.existsSync(file)) continue;
    const settings = parseJsonc(fs.readFileSync(file, "utf8")) as { extraKnownMarketplaces?: Record<string, unknown> };
    if (!settings.extraKnownMarketplaces?.["akm-plugins"]) continue;
    edits.push(editChannelJson(file, ["extraKnownMarketplaces", "akm-plugins", "source", "ref"], ref));
  }
  return edits;
}

/** Read native TOML, including quoted keys and inline tables. */
export function codexMarketplace(file: string): Record<string, unknown> | undefined {
  const config = parseToml(fs.readFileSync(file, "utf8"));
  const marketplaces = config.marketplaces as Record<string, unknown> | undefined;
  const marketplace = marketplaces?.["akm-plugins"];
  return marketplace && typeof marketplace === "object" ? (marketplace as Record<string, unknown>) : undefined;
}

/** Codex's add refuses a changed ref on an existing source; preserve the installed plugin and edit only its ref. */
export function codexChannelEdit(file: string, channel: UpgradeChannel): ChannelEdit {
  const before = fs.readFileSync(file, "utf8");
  const expected = parseToml(before);
  const entry = (expected.marketplaces as Record<string, Record<string, unknown>> | undefined)?.["akm-plugins"];
  if (!entry || entry.source_type !== "git")
    throw new Error("the akm-plugins marketplace has no Git source whose channel can be switched");
  if (channel === "next") entry.ref = "next";
  else delete entry.ref;
  const headers = [...before.matchAll(/^[ \t]*\[(?!\[)([^\]\r\n]+)\][ \t]*(?:#[^\r\n]*)?\r?$/gm)];
  let after = before;
  let edited = false;
  for (const [index, header] of headers.entries()) {
    let parsed: TomlTable;
    try {
      parsed = parseToml(`[${header[1]}]`);
    } catch {
      continue;
    }
    const target = (parsed.marketplaces as Record<string, Record<string, unknown>> | undefined)?.["akm-plugins"];
    if (!target || Object.keys(target).length !== 0) continue;
    const start = header.index! + header[0].length;
    const end = headers[index + 1]?.index ?? before.length;
    const section = before.slice(start, end);
    const refLine =
      /^[ \t]*(?:ref|"ref"|'ref')[ \t]*=[ \t]*(?:"(?:\\.|[^"\\])*"|'[^']*')([ \t]*(?:#[^\r\n]*)?)(\r?\n|$)/m;
    const newline = before.includes("\r\n") ? "\r\n" : "\n";
    const nextSection = refLine.test(section)
      ? section.replace(refLine, (_line, comment: string, end: string) =>
          channel === "next" ? `ref = "next"${comment}${end}` : comment.trim() ? `${comment.trimStart()}${end}` : "",
        )
      : channel === "next"
        ? `${newline}ref = "next"${section}`
        : section;
    after = before.slice(0, start) + nextSection + before.slice(end);
    edited = true;
    break;
  }
  if (!edited) {
    // Inline tables have no section to insert into. Change just this table's ref and retain every other byte.
    const inline = /((?:"akm-plugins"|'akm-plugins'|akm-plugins)\s*=\s*\{)([^\n]*?)(\})/g;
    for (const match of before.matchAll(inline)) {
      const [, open, body, close] = match;
      const ref = /(?:^|,)\s*(?:ref|"ref"|'ref')\s*=\s*(?:"(?:\\.|[^"\\])*"|'[^']*')\s*/;
      const stripped = body!.replace(ref, "").replace(/^\s*,/, "");
      const next = channel === "next" ? `${stripped.trimEnd()}${stripped.trim() ? ", " : ""}ref = "next" ` : stripped;
      const candidate =
        before.slice(0, match.index) + `${open}${next}${close}` + before.slice(match.index! + match[0].length);
      try {
        if (isDeepStrictEqual(parseToml(candidate), expected)) {
          after = candidate;
          break;
        }
      } catch {
        /* Try the next table with this name. */
      }
    }
  }
  // Validate the whole semantic document: an unusual layout is never partially rewritten.
  if (!isDeepStrictEqual(parseToml(after), expected))
    throw new Error("could not locate only the akm-plugins ref in Codex config.toml; no settings were changed");
  return { file, content: after };
}
