// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * One pending file mutation, as a directory adapter's checks see it. Internal to the directory layer: `validate`
 * takes asset edits by ref (`AssetEdit`), and `DirectoryAdapterBase` maps them onto these.
 */

/** What the change does to its target file. */
export type FileChangeOp = "create" | "update" | "delete";

export interface FileChange {
  /** Bundle-relative path of the target file. */
  path: string;
  /** Content the change writes. Absent for `op: "delete"`. */
  after?: string;
  op: FileChangeOp;
}
