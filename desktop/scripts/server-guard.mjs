// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Starts server/server.mjs with plain Node (no Electron, no display) against a synthetic fixture home, reads the ready
// line it prints, and checks that the page shell, /api/desktop and a workspace read answer 200 with its token.
// This keeps the web process runnable without the Electron shell. Run after `npm run build`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createFixture } from "./fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await createFixture({ index: false, packageRoot: root });
const child = spawn(process.execPath, [path.join(root, "server/server.mjs")], {
  env: fixture.env,
  stdio: ["ignore", "pipe", "inherit"],
});
try {
  const lines = readline.createInterface({ input: /** @type {import("node:stream").Readable} */ (child.stdout) });
  /** @type {{ url: string, origin: string }} */
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The server printed no ready line in 60 s.")), 60_000);
    child.once("exit", (code) => reject(new Error(`The server exited (${code}) before it was ready.`)));
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type !== "ready") return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  const bootstrap = await fetch(ready.url, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "The server did not start a session from its token.");
  for (const route of ["/", "/api/desktop", "/api/bundles"]) {
    /** @type {number} */
    const status = (await fetch(ready.origin + route, { headers: { cookie } })).status;
    assert.equal(status, 200, `${route} answered ${status}`);
  }
  console.log("server/server.mjs started under plain Node and answered /, /api/desktop and /api/bundles.");
} finally {
  child.removeAllListeners("exit");
  child.kill("SIGTERM");
  if (child.exitCode === null) await once(child, "exit");
  await fixture.cleanup();
}
