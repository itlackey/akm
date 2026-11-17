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
import { resolveSourceEntries } from "../indexer/search/search-source";
import { isProtectedPlace, managedFolderOf } from "../indexer/walk/place-rules";

export type FileAction = "read" | "edit" | "move" | "copy" | "retire" | "delete";
/** Whether akm accepts the action, and the sentence why not when it does not. */
/** `as` (on a copy) is what is copied instead of the entry: a skill's manifest copies as the skill's folder. */
export type FileVerdict = { allowed: true; as?: string } | { allowed: false; reason: string };
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

/**
 * The two write questions about a bundle, each from its owner. `plain` is whether a person may change the bundle's files
 * as files (the bundle is not read-only: `writable`, the rule `isEditable` applies); the same sentence refuses a plain
 * create. `asset` is whether akm's writer accepts an asset write to it (`inspectWriteTarget`: also refuses an adapter that
 * takes no AKM asset writes). Each is null when accepted.
 */
export interface WriteBlockers {
  plain: string | null;
  asset: string | null;
}

export function plainWriteBlocker(config: AkmConfig, bundle: string): string | null {
  const source = resolveSourceEntries(undefined, config).find((entry) => entry.registryId === bundle);
  // A bundle that does not resolve is the caller's error to name, not a read-only bundle.
  return source === undefined || source.writable === true
    ? null
    : `Bundle ${bundle} is read-only: akm does not write to it, and an update would replace the edit.`;
}

export function bundleWriteBlockers(config: AkmConfig, bundle: string): WriteBlockers {
  return { plain: plainWriteBlocker(config, bundle), asset: inspectWriteTarget(config, bundle).blocker };
}

function managedReason(relative: string): string | null {
  const managed = managedFolderOf(relative);
  return managed === undefined ? null : `${managed}/ is managed by akm.`;
}

/** Why nothing is created, moved into or taken out of this folder whatever the bundle allows: a protected or managed place. */
export function folderBlocker(relative: string): string | null {
  return isProtectedPlace(relative) ? PROTECTED_REASON : managedReason(relative);
}

/** Whether a folder may be made in `folder`, or a file or folder moved into it: plain file operations of any bundle that is not read-only. */
export function placeVerdict(folder: string, blockers: WriteBlockers): FileVerdict {
  const blocker = folderBlocker(folder) ?? blockers.plain;
  return blocker === null ? allowed : refuse(blocker);
}

/**
 * The verdicts for one entry. `blockers` are the bundle's own answers ({@link bundleWriteBlockers}), computed once for a
 * listing. Reading, editing, moving and deleting a file or folder are plain file operations and need only `plain`; retiring
 * an asset is an akm asset write and needs `asset` too. Copying and reading leave a bundle as it is.
 */
export function fileActions(entry: EntryFacts, blockers: WriteBlockers): FileActions {
  // What the entry is rules out an action whatever the bundle allows. A file is protected by akm's typing of it.
  const nature =
    (entry.kind === "file"
      ? entry.protected
        ? PROTECTED_REASON
        : managedReason(entry.relative)
      : folderBlocker(entry.relative)) ??
    entry.unavailable ??
    undefined;
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

  const needsWrite = (verdict: () => FileVerdict, blocker: string | null = blockers.plain): FileVerdict =>
    nature !== undefined ? refuse(nature) : blocker !== null ? refuse(blocker) : verdict();

  return {
    read: nature !== undefined ? refuse(nature) : textVerdict,
    edit: needsWrite(() => textVerdict),
    move: needsWrite(() => (skillManifest ? refuse("A skill moves as its folder.") : allowed)),
    copy:
      nature !== undefined
        ? refuse(nature)
        : typeof probed === "object"
          ? textVerdict
          : skillManifest
            ? { allowed: true, as: path.posix.dirname(entry.relative) }
            : allowed,
    retire: needsWrite(
      () =>
        entry.kind !== "file"
          ? refuse("Retire applies to an asset; a folder is deleted when it is empty.")
          : entry.assets.length === 0
            ? refuse("This file is not an indexed asset, so there is nothing to retire; delete it instead.")
            : retire !== undefined
              ? refuse(retire)
              : allowed,
      blockers.plain ?? blockers.asset,
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
