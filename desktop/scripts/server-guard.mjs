// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Starts server/server.mjs with plain Node (no Electron, no display) against a synthetic fixture home, reads the ready
// line it prints, and checks that the page shell, /api/desktop and a workspace read answer 200 with its secret, and that
// the login form and the API refuse a request without one.
// This keeps the web process runnable without the Electron shell. Run after `npm run build`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createFixture } from "./fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await createFixture({ index: false, packageRoot: root });
const secret = randomBytes(32).toString("hex");
const child = spawn(process.execPath, [path.join(root, "server/server.mjs")], {
  env: { ...fixture.env, AKM_WEB_SECRET: secret },
  stdio: ["ignore", "pipe", "inherit"],
});
try {
  const lines = readline.createInterface({ input: /** @type {import("node:stream").Readable} */ (child.stdout) });
  /** @type {{ origin: string }} */
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
  assert.deepEqual(Object.keys(ready).sort(), ["origin", "type"], "The ready line carries the origin and nothing else.");
  const page = await fetch(ready.origin, { headers: { accept: "text/html" } });
  assert.equal(page.status, 401, "A browser without a session gets the login form.");
  assert.match(await page.text(), /<form method="post" action="api\/session">/);
  assert.equal((await fetch(`${ready.origin}/api/desktop`)).status, 401, "The API refuses a request without a session.");
  for (const route of ["/", "/api/desktop", "/api/bundles"]) {
    /** @type {number} */
    const status = (await fetch(ready.origin + route, { headers: { authorization: `Bearer ${secret}` } })).status;
    assert.equal(status, 200, `${route} answered ${status}`);
  }
  console.log("server/server.mjs started under plain Node and answered /, /api/desktop and /api/bundles.");
} finally {
  child.removeAllListeners("exit");
  child.kill("SIGTERM");
  if (child.exitCode === null) await once(child, "exit");
  await fixture.cleanup();
}
