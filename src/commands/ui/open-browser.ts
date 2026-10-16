// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn } from "node:child_process";

/** The command that opens `url` in the default browser on `platform`. */
export function browserOpener(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  // `start` is a cmd builtin; its first quoted argument is the window title, hence the empty one.
  if (platform === "win32") return ["cmd", ["/c", "start", '""', url]];
  return ["xdg-open", [url]];
}

/** Open `url` in the default browser. Resolves `false` when no opener could be started; the caller prints the URL either way. */
export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const [command, args] = browserOpener(url);
    try {
      const child = spawn(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
