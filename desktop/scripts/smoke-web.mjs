// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Packs the akm-web package (package-web.mjs) with the locally unpacked engine, installs both into a temporary prefix,
// starts `akm-web` through the npm bin link with plain Node against a synthetic home, and checks /api/desktop.
// Local only: nothing is published and no registry login is used. Run after `npm run build`.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createFixture } from "./fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = await mkdtemp(path.join(os.tmpdir(), "akm-web-smoke-"));
const fixture = await createFixture({ index: false, packageRoot: root });
/** @type {import("node:child_process").ChildProcess | undefined} */
let child;
try {
  const { stage } = JSON.parse(
    execFileSync(process.execPath, [path.join(root, "scripts/package-web.mjs")], { encoding: "utf8" }).trim(),
  );
  const pack = (/** @type {string} */ dir) =>
    path.join(
      work,
      execFileSync("npm", ["pack", "--silent", "--pack-destination", work, dir], { encoding: "utf8" }).trim(),
    );
  const tarballs = [pack(stage), pack(path.join(root, ".core"))];
  const prefix = path.join(work, "prefix");
  execFileSync("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], {
    stdio: "inherit",
  });
  await rm(stage, { recursive: true, force: true });
  const bin = path.join(prefix, "node_modules/.bin/akm-web");
  child = spawn(process.execPath, [bin], { env: fixture.env, stdio: ["ignore", "pipe", "inherit"] });
  const lines = readline.createInterface({ input: /** @type {import("node:stream").Readable} */ (child.stdout) });
  /** @type {{ url: string, origin: string }} */
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("akm-web printed no ready line in 60 s.")), 60_000);
    child?.once("exit", (code) => reject(new Error(`akm-web exited (${code}) before it was ready.`)));
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type !== "ready") return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  const cookie = (await fetch(ready.url, { redirect: "manual" })).headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "akm-web did not start a session from its token.");
  const response = await fetch(`${ready.origin}/api/desktop`, { headers: { cookie } });
  assert.equal(response.status, 200, `/api/desktop answered ${response.status}`);
  console.log("The packed akm-web package installed and answered /api/desktop through its bin link.");
} finally {
  if (child && child.exitCode === null) {
    child.removeAllListeners("exit");
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  await fixture.cleanup();
  await rm(work, { recursive: true, force: true });
}
