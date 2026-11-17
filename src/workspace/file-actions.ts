// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a person may do to a file or folder of a bundle, and the sentence why not. Each verdict is computed from the
 * checks the operations themselves run (the write target's own checks, the protected-file rule, the retire guard), so a
 * control shown from a verdict never fails after the click.
 */

import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../core/config/config";
import { inspectWriteTarget } from "../core/write-source";

export type FileAction = "read" | "edit" | "move" | "copy" | "retire" | "delete";
/** Whether akm accepts the action, and the sentence why not when it does not. */
export type FileVerdict = { allowed: true } | { allowed: false; reason: string };
/** `move` is rename or move. */
export type FileActions = Record<FileAction, FileVerdict>;

/** The largest file Desktop opens for editing. */
export const MAX_TEXT_BYTES = 8 * 1_048_576;
const TEXT_PROBE_BYTES = 64 * 1024;

const allowed: FileVerdict = { allowed: true };
const refuse = (reason: string): FileVerdict => ({ allowed: false, reason });

/** The retire guard: the types a retire proposal cannot take. `documents.retire` refuses with the same sentence. */
export function retireBlocker(type: string): string | undefined {
  return ["skill", "env", "secret", "session"].includes(type)
    ? "Retire supports single-file assets, not skill packages or protected files."
    : undefined;
}

const PROTECTED_REASON =
  "Env and secret files are shown and edited from the protected-file view, and stay where they are.";

/**
 * What the first bytes of a file say: text (no NUL, valid UTF-8, a character the probe cuts is not invalid), not text,
 * or why the file could not be opened (that failure is the answer, never read as text or as not text).
 */
function probeText(file: string): "text" | "binary" | { failure: string } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    if (fs.fstatSync(fd).size > MAX_TEXT_BYTES) return "binary";
    const probe = Buffer.alloc(TEXT_PROBE_BYTES);
    const read = fs.readSync(fd, probe, 0, TEXT_PROBE_BYTES, 0);
    if (probe.subarray(0, read).includes(0)) return "binary";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(probe.subarray(0, read), { stream: read === TEXT_PROBE_BYTES });
    } catch {
      return "binary";
    }
    return "text";
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface EntryFacts {
  bundle: string;
  /** The path inside the bundle, with `/` separators. */
  relative: string;
  kind: "directory" | "file" | "other";
  /** Where the file is, for the checks that read it. Absent for a link that does not resolve. */
  absolute?: string;
  /** Why the entry cannot be followed (a link out of the bundle or to nothing). */
  unavailable?: string;
  /** akm types the file env or secret (`protectedTypeOf`), at any depth. */
  protected: boolean;
  /** The assets the index holds for the file. */
  assets: ReadonlyArray<{ ref: string; type: string }>;
}

/** The write checks of a bundle, run once: its blocker sentence, or null when akm accepts a write to it. */
export function bundleWriteBlocker(config: AkmConfig, bundle: string): string | null {
  return inspectWriteTarget(config, bundle).blocker;
}

function managedFolder(relative: string): string | undefined {
  return relative.split("/").find((segment) => segment === ".git" || segment === ".akm");
}

/**
 * The verdicts for one entry. `writeBlocker` is the bundle's own answer ({@link bundleWriteBlocker}), computed once for
 * a listing; copying and reading leave a bundle as it is, so they do not consult it.
 */
export function fileActions(entry: EntryFacts, writeBlocker: string | null): FileActions {
  const segments = entry.relative.split("/");
  const managed = managedFolder(entry.relative);
  const protectedFile =
    entry.kind === "file" ? entry.protected : segments.some((segment) => segment === "env" || segment === "secrets");
  // What the entry is rules out an action whatever the bundle allows.
  const nature = protectedFile
    ? PROTECTED_REASON
    : managed
      ? `${managed}/ is managed by akm.`
      : (entry.unavailable ?? undefined);
  const probed =
    entry.kind === "file" && entry.absolute !== undefined && nature === undefined
      ? probeText(entry.absolute)
      : undefined;
  const textVerdict: FileVerdict =
    entry.kind !== "file"
      ? refuse("A folder has no text to open.")
      : probed === "text"
        ? allowed
        : probed === "binary"
          ? refuse("This is not a text file.")
          : refuse(probed ? `This file cannot be opened: ${probed.failure}` : "This file has no path to open.");
  const skillManifest =
    entry.assets.some((asset) => asset.type === "skill") && path.posix.basename(entry.relative) === "SKILL.md";
  const retire = entry.assets.map((asset) => retireBlocker(asset.type)).find((reason) => reason !== undefined);

  const needsWrite = (verdict: () => FileVerdict): FileVerdict =>
    nature !== undefined ? refuse(nature) : writeBlocker !== null ? refuse(writeBlocker) : verdict();

  return {
    read: nature !== undefined ? refuse(nature) : textVerdict,
    edit: needsWrite(() => textVerdict),
    move: needsWrite(() => (skillManifest ? refuse("A skill moves as its folder.") : allowed)),
    copy: nature !== undefined ? refuse(nature) : typeof probed === "object" ? textVerdict : allowed,
    retire: needsWrite(() =>
      entry.kind !== "file"
        ? refuse("Retire applies to an asset; a folder is deleted when it is empty.")
        : entry.assets.length === 0
          ? refuse("This file is not an indexed asset, so there is nothing to retire; delete it instead.")
          : retire !== undefined
            ? refuse(retire)
            : allowed,
    ),
    delete: needsWrite(() =>
      entry.assets.length > 0
        ? refuse("An asset is retired, not deleted: retire it, and restore it from Review if needed.")
        : entry.kind === "directory" && entry.absolute !== undefined && fs.readdirSync(entry.absolute).length > 0
          ? refuse("The folder is not empty.")
          : allowed,
    ),
  };
}
