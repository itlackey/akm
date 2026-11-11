// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The preferences file is fixed when the module loads, so point it at a temporary profile first.
const home = await mkdtemp(path.join(os.tmpdir(), "akm-preferences-test-"));
process.env.XDG_CONFIG_HOME = home;
after(() => rm(home, { recursive: true, force: true }));
const { readPreferences, savePreferences, tryApply } = await import("../src/lib/server/features/preferences.ts");
const file = path.join(home, "akm-desktop", "preferences.json");

test("concurrent saves each keep their own choice and the unrelated ones (#1609-4)", async () => {
  await savePreferences({ theme: "dark" });
  for (let trial = 0; trial < 20; trial++) {
    await savePreferences({ updateChannel: "stable", pluginChannel: "latest" });
    await Promise.all([savePreferences({ updateChannel: "prerelease" }), savePreferences({ pluginChannel: "next" })]);
    assert.deepEqual(await readPreferences(), {
      theme: "dark",
      updateChannel: "prerelease",
      pluginChannel: "next",
    });
  }
  // A later save is not held up by an earlier failed one.
  await writeFile(file, '{"theme":"light"}\n');
  assert.equal((await savePreferences({ pluginChannel: "latest" })).theme, "light");
  assert.match(await readFile(file, "utf8"), /"pluginChannel":"latest"/);
});

test("a choice that is saved but could not be applied is reported as saved, not as a failed save (#1609-4)", async () => {
  assert.deepEqual(await tryApply(async () => {}), { applied: true });
  assert.deepEqual(
    await tryApply(async () => {
      throw new Error("Desktop service did not respond.");
    }),
    { applied: false, applyError: "Desktop service did not respond." },
  );
});
