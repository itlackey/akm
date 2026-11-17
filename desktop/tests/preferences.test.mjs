// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The preferences file is fixed when the module loads, so point it at a temporary profile first.
const home = await mkdtemp(path.join(os.tmpdir(), "akm-preferences-test-"));
process.env.XDG_CONFIG_HOME = home;
after(() => rm(home, { recursive: true, force: true }));
const { PreferencesUnreadable, preferencesView, readPreferences, savePreferences, tryApply } = await import(
  "../src/lib/server/features/preferences.ts"
);
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

test("a damaged preferences file is reported, and a save moves it aside once instead of overwriting it", async () => {
  await writeFile(file, '{"theme":"dark","updateChannel":"prerel');
  await assert.rejects(readPreferences(), PreferencesUnreadable);
  const view = await preferencesView();
  assert.equal(view.theme, "system");
  assert.equal(view.unreadable.file, file);
  assert.match(view.unreadable.error, /could not be read/);

  const saved = await savePreferences({ theme: "light" });
  assert.equal(saved.theme, "light");
  assert.match(saved.movedAside, /preferences\.json\.unreadable-/);
  assert.equal(await readFile(saved.movedAside, "utf8"), '{"theme":"dark","updateChannel":"prerel');
  assert.equal(await readFile(file, "utf8"), '{"theme":"light"}\n');
  assert.equal((await readdir(path.dirname(file))).filter((name) => name.includes("unreadable")).length, 1);
  assert.equal((await savePreferences({ theme: "dark" })).movedAside, undefined);
});

test("a preferences file that cannot be read at all is left alone and the save fails with the reason", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  await writeFile(file, '{"theme":"dark","pluginChannel":"next"}\n');
  await chmod(file, 0o000);
  t.after(() => chmod(file, 0o600));
  assert.match((await preferencesView()).unreadable.error, /EACCES/);
  await assert.rejects(savePreferences({ theme: "light" }), PreferencesUnreadable);
  await chmod(file, 0o600);
  assert.equal(await readFile(file, "utf8"), '{"theme":"dark","pluginChannel":"next"}\n');
});
