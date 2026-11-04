// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { DESKTOP_ID, DesktopMenu, desktopEntry } from "../electron/menu-install.mjs";

const temporary = [];
after(() => Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true }))));

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "akm-menu-"));
  temporary.push(home);
  const env = {
    platform: "linux",
    packaged: true,
    home,
    appImage: join(home, "download.AppImage"),
    icon: join(home, "icon.png"),
  };
  await writeFile(env.appImage, "old AppImage");
  await writeFile(env.icon, "icon fixture");
  return { env, menu: new DesktopMenu(env) };
}

test("menu installation is opt-in, per-user, executable, XDG-aware and preserves the download", async () => {
  const { env } = await fixture();
  const menu = new DesktopMenu({ ...env, dataHome: join(env.home, "custom share") });
  assert.equal((await menu.status()).installed, false);
  await assert.rejects(stat(join(env.home, ".local")), { code: "ENOENT" });
  await menu.install();
  assert.equal(menu.paths.entry, join(env.home, `custom share/applications/${DESKTOP_ID}.desktop`));
  assert.equal((await stat(menu.paths.appImage)).mode & 0o777, 0o755);
  assert.equal(await readFile(env.appImage, "utf8"), "old AppImage");
  assert.equal(await readFile(menu.paths.appImage, "utf8"), "old AppImage");
  assert.equal(await readFile(menu.paths.icon, "utf8"), "icon fixture");
  assert.equal(await readFile(menu.paths.entry, "utf8"), desktopEntry(menu.paths.appImage));
  assert.deepEqual(await menu.status(), {
    supported: true,
    installed: true,
    busy: false,
    runningInstalledCopy: false,
    replacesExistingCopy: true,
    appImage: menu.paths.appImage,
  });
});

test("old downloads require replacement consent even if the menu entry or icon is missing", async () => {
  const { menu } = await fixture();
  await menu.install();
  await writeFile(menu.paths.appImage, "newer self-updated copy");
  await rm(menu.paths.icon);
  await menu.install();
  await menu.install(async () => false);
  assert.equal(await readFile(menu.paths.appImage, "utf8"), "newer self-updated copy");
  let confirmations = 0,
    finish;
  const consent = () => {
    confirmations++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const a = menu.install(consent),
    b = menu.install(consent);
  assert.equal(a, b);
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(menu.busy(), true);
  assert.equal(confirmations, 1);
  finish(true);
  await a;
  assert.equal(menu.busy(), false);
  assert.equal(await readFile(menu.paths.appImage, "utf8"), "old AppImage");
  assert.equal((await menu.status()).installed, true);
});

test("repair from the stable copy never recopies itself and the launcher survives self-update", async () => {
  const { env, menu } = await fixture();
  await menu.install();
  const entry = await readFile(menu.paths.entry, "utf8");
  await writeFile(menu.paths.appImage, "newer version");
  await rm(menu.paths.icon);
  const installed = new DesktopMenu({ ...env, appImage: menu.paths.appImage });
  await installed.install(() => {
    throw new Error("No replacement consent for self-repair");
  });
  assert.equal(await readFile(menu.paths.appImage, "utf8"), "newer version");
  assert.equal(await readFile(menu.paths.entry, "utf8"), entry);
  assert.equal((await installed.status()).installed, true);
  assert.equal((await installed.status()).runningInstalledCopy, true);
});

test("failed staging keeps the installed image and entry and clears temporary files", async () => {
  const { env, menu } = await fixture();
  await menu.install();
  const next = new DesktopMenu({ ...env, appImage: join(env.home, "missing.AppImage") });
  await assert.rejects(
    next.install(async () => true),
    { code: "ENOENT" },
  );
  assert.equal(await readFile(menu.paths.appImage, "utf8"), "old AppImage");
  assert.equal((await menu.status()).installed, true);
  assert.equal(next.busy(), false);
  assert.ok(!(await readdir(dirname(menu.paths.appImage))).some((name) => name.endsWith(".tmp")));
});

test("development and other operating systems do not install; relative XDG paths fall back", async () => {
  const { env } = await fixture();
  assert.equal(
    new DesktopMenu({ ...env, dataHome: "relative" }).paths.entry,
    join(env.home, `.local/share/applications/${DESKTOP_ID}.desktop`),
  );
  for (const override of [
    { packaged: false },
    { platform: "darwin" },
    { platform: "win32" },
    { appImage: undefined },
    { appImage: "relative" },
  ]) {
    const menu = new DesktopMenu({ ...env, ...override });
    assert.equal((await menu.status()).supported, false);
    await assert.rejects(menu.install(), /Linux AppImage/);
  }
  await assert.rejects(stat(join(env.home, ".local")), { code: "ENOENT" });
});

test("menu identity matches packaging and Exec quoting handles reserved characters without a shell", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.desktopName, `${DESKTOP_ID}.desktop`);
  const entry = desktopEntry('/home/a b/100%/"cash$`\\/akm-desktop.AppImage');
  assert.ok(entry.includes("100%%"));
  assert.ok(entry.includes('\\\\"cash\\\\$\\\\`\\\\\\\\'));
  assert.ok(entry.includes(`StartupWMClass=${DESKTOP_ID}\n`));
  assert.ok(!entry.includes("sh -c") && !entry.includes("%U"));
  assert.throws(() => desktopEntry("relative"), /absolute/);
  assert.throws(() => desktopEntry("/home/a=b/app"), /equals/);
});
