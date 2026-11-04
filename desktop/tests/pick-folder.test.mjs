// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { createFolderPicker } from "../electron/pick-folder.mjs";

// The main-process handler behind POST /api/desktop/pick-folder, driven with a fake dialog.
const fakeDialog = (result) => {
  const calls = [];
  return {
    calls,
    dialog: {
      showOpenDialog: async (...args) => {
        calls.push(args);
        return typeof result === "function" ? await result() : result;
      },
    },
  };
};

test("the picker opens a folder dialog on the window and returns the chosen path", async () => {
  const window = { id: "main" };
  const { dialog, calls } = fakeDialog({ canceled: false, filePaths: ["/home/me/notes"] });
  const pick = createFolderPicker({ dialog, window: () => window, home: "/home/me" });
  assert.equal(await pick("/home/me/library"), "/home/me/notes");
  assert.equal(calls[0][0], window);
  assert.deepEqual(calls[0][1], { properties: ["openDirectory"], defaultPath: "/home/me/library" });
});

test("cancelling returns null, ~ opens the home folder, a relative start is ignored, and no window still works", async () => {
  const { dialog, calls } = fakeDialog({ canceled: true, filePaths: [] });
  const pick = createFolderPicker({ dialog, window: () => undefined, home: "/home/me" });
  assert.equal(await pick("~/library"), null);
  assert.deepEqual(calls[0], [{ properties: ["openDirectory"], defaultPath: "/home/me/library" }]);
  await pick("relative/folder");
  assert.deepEqual(calls[1], [{ properties: ["openDirectory"] }]);
  await pick(undefined);
  assert.deepEqual(calls[2], [{ properties: ["openDirectory"] }]);
});

test("one dialog at a time, and the picker is usable again after it closes or fails", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { dialog } = fakeDialog(async () => {
    await gate;
    return { canceled: false, filePaths: ["/a"] };
  });
  const pick = createFolderPicker({ dialog, window: () => undefined, home: "/h" });
  const first = pick("/");
  await assert.rejects(pick("/"), /already open/);
  release();
  assert.equal(await first, "/a");
  const failing = createFolderPicker({
    dialog: {
      showOpenDialog: async () => {
        throw new Error("no display");
      },
    },
    window: () => undefined,
    home: "/h",
  });
  await assert.rejects(failing("/"), /no display/);
  await assert.rejects(failing("/"), /no display/);
});
