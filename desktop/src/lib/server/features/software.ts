// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "node:crypto";
import { HostTools } from "./host-tools.js";

export const hostTools = new HostTools();
interface Waiting {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}
const pending = new Map<string, Waiting>();
process.on("message", (message: { type?: string; id?: string; error?: string; data?: unknown }) => {
  if (message?.type !== "desktop-response" || !message.id) return;
  const item = pending.get(message.id);
  if (!item) return;
  if (item.timer) clearTimeout(item.timer);
  pending.delete(message.id);
  if (message.error) item.reject(new Error(message.error));
  else item.resolve(message.data);
});
/** Ask Electron's main process for the app's version and menu-entry state, to install the menu entry, or to pick a folder. */
export function desktopApp(action = "status", params: { start?: string } = {}): Promise<unknown> {
  if (!process.send || process.env.AKM_DESKTOP_NATIVE !== "1") {
    if (action === "menu-install")
      return Promise.reject(new Error("Menu installation is available in the Linux AppImage."));
    if (action === "pick-folder")
      return Promise.reject(
        new Error("The folder dialog is available in the AKM Desktop app. Type the folder path instead."),
      );
    return Promise.resolve({
      version: process.env.AKM_DESKTOP_VERSION,
      menu: { supported: false, installed: false, busy: false },
    });
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    // A dialog waits for the person, so it has no timeout.
    const timer =
      action === "pick-folder"
        ? undefined
        : setTimeout(() => {
            pending.delete(id);
            reject(new Error("Desktop service did not respond."));
          }, 10_000);
    pending.set(id, { resolve, reject, timer });
    process.send?.({ type: "desktop-request", id, action, ...params });
  });
}
