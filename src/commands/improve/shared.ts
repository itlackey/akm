// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Small pure helpers shared across the improve command family. Extracted to
 * delete byte-identical duplication that previously lived inline in the
 * per-process passes (the whole-corpus synthesis pass removed in 0.9.0 and
 * the procedural-compilation pass removed in 0.9.0). Keep this file free of
 * I/O and of any improve-specific state — these are leaf utilities.
 */

/** Normalize an unknown thrown value to a human-readable message string. */
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Slugify an asset ref for use in eval-case / rejection filenames: lowercase,
 * non-alphanumerics collapsed to `-`, capped at 60 characters.
 */
export function refSlug(ref: string): string {
  return ref
    .replace(/[^a-z0-9]/gi, "-")
    .toLowerCase()
    .slice(0, 60);
}
