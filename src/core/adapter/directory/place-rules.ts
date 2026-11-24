// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What akm says about a place in a bundle by its path alone: whether it holds env or secret files (the directory rules that
 * type a file `env` or `secret`) and whether it is a folder akm and Git manage. Nothing is read.
 */

import path from "node:path";
import { buildFileContext } from "./file-context";
import { declaredTypeForPath } from "./matchers";
import { MANAGED_DIRS } from "./walker";

/** The type akm's own directory rules give a bundle-relative path (`memories/x.md` is a memory); undefined: none. */
export function placeTypeOf(relative: string): string | undefined {
  return declaredTypeForPath(buildFileContext("/", path.posix.join("/", relative)));
}

/** akm's own directory rules on a bundle-relative path: `env` or `secret` when any env/ or secrets/ ancestor makes it a protected file. */
export function protectedTypeOf(relative: string): "env" | "secret" | undefined {
  const type = placeTypeOf(relative);
  return type === "env" || type === "secret" ? type : undefined;
}

/** Whether a file made in `folder` would be an env or secret file: the folder is, or is inside, a protected place. */
export function isProtectedPlace(folder: string): boolean {
  return (
    protectedTypeOf(path.posix.join(folder, "probe.env")) !== undefined ||
    protectedTypeOf(path.posix.join(folder, "probe")) !== undefined
  );
}

/** The managed folder (`.git`, `.akm`) a bundle-relative path is in, if any. */
export function managedFolderOf(relative: string): string | undefined {
  return relative.split("/").find((segment) => MANAGED_DIRS.includes(segment));
}
