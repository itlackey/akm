// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tell "this path is not there" apart from "I am not allowed to look at it"
 * (issue #791).
 *
 * # Why this exists
 *
 * `fs.existsSync()` answers `false` for BOTH cases: it swallows every error,
 * so `ENOENT` (genuinely absent) and `EACCES` (present, unreadable) are
 * indistinguishable. akm used `existsSync` as its "is there an index?" gate on
 * the read path, so an index the caller could not read was reported as an index
 * that did not exist — `akm search` and `akm curate` returned
 * `results: []` with the tip *"No search index available. Run 'akm index' to build
 * one."* at exit 0, for a populated index sitting right there on disk.
 *
 * That is the worst possible shape for a failure. A non-zero exit is a problem
 * the operator can see; an empty-but-successful result is a lie that a
 * consuming agent will confidently relay to its user. In the report that
 * prompted this module, exactly that happened: an agent told its user akm's
 * "vector service is unavailable and its maintenance lock is read-only" — a
 * story it invented to explain results that claimed to be fine.
 *
 * # Contract
 *
 * `absent` means the path (or a parent component) genuinely is not there, which
 * is a legitimate first-run state every caller already handles. `inaccessible`
 * means the path may well exist and this process cannot determine that or read
 * it — a caller must NEVER degrade that to an empty-but-successful result.
 */

import fs from "node:fs";

export type PathAccess = "present" | "absent" | "inaccessible";

export interface PathAccessResult {
  access: PathAccess;
  /** Syscall errno (`EACCES`, `EPERM`, `ELOOP`, …). Only set for `inaccessible`. */
  code?: string;
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Classify `target` as {@link PathAccess}.
 *
 * `ENOENT`/`ENOTDIR` are `absent` — the path cannot exist as named. Everything
 * else that fails is `inaccessible`, carrying its errno: a permission error is
 * the common case, but a symlink loop or an I/O error are equally "present as
 * far as anyone knows, and unusable", and silently treating them as "no index"
 * is the bug this module exists to prevent.
 *
 * Statting is not enough — a file can be `stat`-able through a searchable
 * parent while being unreadable itself — so a successful stat is confirmed with
 * an `R_OK` access check.
 */
export function classifyPathAccess(target: string): PathAccessResult {
  try {
    fs.statSync(target);
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { access: "absent" };
    return { access: "inaccessible", ...(code ? { code } : {}) };
  }
  try {
    fs.accessSync(target, fs.constants.R_OK);
  } catch (error) {
    const code = errnoOf(error);
    return { access: "inaccessible", ...(code ? { code } : {}) };
  }
  return { access: "present" };
}

/** True when the path is genuinely absent — the ordinary "not built yet" state. */
export function isPathAbsent(target: string): boolean {
  return classifyPathAccess(target).access === "absent";
}

/**
 * A diagnostic line naming everything an operator needs to fix a permission
 * problem without a second round trip: the path, the errno, the mode and owner
 * of whatever akm *could* stat along the way, and the uid actually running.
 *
 * Deliberately best-effort — this runs on an error path, so a failure to gather
 * detail must never mask the error being described.
 */
export function describeInaccessiblePath(target: string, code?: string): string {
  const parts: string[] = [target];
  if (code) parts.push(`(${code})`);
  try {
    const stat = fs.statSync(target);
    parts.push(`mode ${(stat.mode & 0o777).toString(8).padStart(3, "0")}, owner uid ${stat.uid}`);
  } catch {
    // Cannot stat the file itself — describe the closest parent we CAN see,
    // which is usually where the missing permission actually is.
    const parent = target.slice(0, Math.max(0, target.lastIndexOf("/")));
    if (parent) {
      try {
        const stat = fs.statSync(parent);
        parts.push(
          `parent ${parent} is mode ${(stat.mode & 0o777).toString(8).padStart(3, "0")}, owner uid ${stat.uid}`,
        );
      } catch {
        // Nothing further to say.
      }
    }
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined) parts.push(`running as uid ${uid}`);
  return parts.join("; ");
}
