// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os from "node:os";
import path from "node:path";

/**
 * The operating system's own folder dialog, for choosing a bundle folder. Returns the chosen absolute path, or
 * null when the person cancels. `~` in `start` means the home folder; a relative `start` is ignored. Only one
 * dialog is open at a time.
 *
 * @param {{ dialog: Pick<import("electron").Dialog, "showOpenDialog">, window: () => import("electron").BrowserWindow | undefined, home?: string }} host
 */
export function createFolderPicker({ dialog, window, home = os.homedir() }) {
  let open = false;
  return async (/** @type {string | undefined} */ start) => {
    if (open) throw new Error("A folder dialog is already open.");
    open = true;
    try {
      const requested = typeof start === "string" ? start.trim() : "";
      const expanded =
        requested === "~" || requested.startsWith("~/") ? path.join(home, requested.slice(1)) : requested;
      const options = {
        properties: /** @type {("openDirectory")[]} */ (["openDirectory"]),
        ...(path.isAbsolute(expanded) ? { defaultPath: expanded } : {}),
      };
      const parent = window();
      const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    } finally {
      open = false;
    }
  };
}
