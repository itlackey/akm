// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Starts the packaged app's own server with the packaged Electron runtime (no window, no display needed) and checks
// that it answers with the version it was built for. Run after `node scripts/package.mjs`; it tests the newest
// package in out/. Any platform; this is what proves a macOS or Windows build starts.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixture } from "./fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = path.join(root, "out");
const newest = (await readdir(out)).sort().at(-1);
assert.ok(newest, "Nothing is packaged in out/. Run node scripts/package.mjs first.");
const [packaged] = (await readdir(path.join(out, newest))).filter((name) => name.startsWith("AKM Desktop-"));
const dir = path.join(out, newest, packaged);
const mac = process.platform === "darwin";
const base = mac ? path.join(dir, "AKM Desktop.app/Contents") : dir;
const appRoot = path.join(base, mac ? "Resources/app" : "resources/app");
// macOS names the binary after the app, so take the only file in MacOS/.
const executable = mac
  ? path.join(base, "MacOS", (await readdir(path.join(base, "MacOS")))[0])
  : path.join(dir, process.platform === "win32" ? "akm-desktop.exe" : "akm-desktop");
const expected = JSON.parse(await readFile(path.join(root, ".core/package.json"), "utf8")).version;

const fixture = await createFixture({ index: false, packageRoot: appRoot });
const child = fork(path.join(appRoot, "electron/server.mjs"), [], {
  execPath: executable,
  execArgv: [],
  env: { ...fixture.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let logs = "";
child.stderr?.on("data", (chunk) => {
  logs += chunk;
});
try {
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The packaged server did not start in 60 s.\n${logs}`)), 60_000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`The packaged server exited (${code}).\n${logs}`)));
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  const bootstrap = await fetch(ready.url, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "The packaged server did not start a session.");
  const desktop = await (await fetch(`${ready.origin}/api/desktop`, { headers: { cookie } })).json();
  assert.equal(desktop.ok, true, JSON.stringify(desktop));
  assert.equal(desktop.data.version, expected, "Desktop reports a version other than the engine it embeds.");
  assert.equal(desktop.data.akmVersion, expected);
  const page = await fetch(ready.origin, { headers: { cookie } });
  assert.equal(page.status, 200, "The packaged server did not serve the built UI.");
  console.log(
    `Packaged AKM Desktop ${desktop.data.version} (${process.platform}-${process.arch}) started and answered.`,
  );
} finally {
  child.removeAllListeners("exit");
  if (child.connected) child.send("shutdown");
  await new Promise((/** @type {(value?: unknown) => void} */ resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await fixture.cleanup();
}
