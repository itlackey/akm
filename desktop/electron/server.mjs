// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Called only in a Node child (Electron supplies ELECTRON_RUN_AS_NODE before spawn). */
export async function startServer() {
  delete process.env.AKM_LAUNCHER_PATH;
  delete process.env.AKM_LAUNCHER_PID;
  process.env.AKM_LAUNCHER_NODE = process.execPath;
  process.env.AKM_DESKTOP_VERSION = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  try {
    process.env.AKM_DESKTOP_COMMIT = JSON.parse(
      await readFile(new URL("../build-info.json", import.meta.url), "utf8"),
    ).commit;
  } catch {
    process.env.AKM_DESKTOP_COMMIT = "development";
  }
  // Kit 3's custom handler defaults to HTTPS, and adapter-node 6 reads the origin only from the build-time
  // `paths.origin` (our port is chosen at run time), so the protocol comes from this header. It is server-owned,
  // overwritten for every request, never trusted from the network.
  process.env.PROTOCOL_HEADER = "x-akm-desktop-protocol";
  process.env.BODY_SIZE_LIMIT = String(8 * 1024 * 1024);
  delete process.env.HOST_HEADER;
  delete process.env.PORT_HEADER;
  const token = randomBytes(32).toString("hex");
  // AKM's native config inspection redacts credential-shaped variable names.
  // Keep TOKEN explicit so this private launch credential can never be shown.
  delete process.env.AKM_DESKTOP_SESSION;
  process.env.AKM_DESKTOP_SESSION_TOKEN = token;
  /** @type {import("node:http").RequestListener | undefined} */
  let handler;
  const server = http.createServer((req, res) => {
    req.headers["x-akm-desktop-protocol"] = "http";
    if (!handler) {
      res
        .writeHead(503, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ok: false, code: "STARTING", error: "AKM Desktop is still starting." }));
      return;
    }
    handler(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${address.port}`;
  process.env.AKM_DESKTOP_ORIGIN = origin;
  // Import after environment initialization, including for loader subprocesses.
  // A computed specifier: the build output is generated and is not part of the type-checked program.
  ({ handler } = await import(new URL("../build/handler.js", import.meta.url).href));
  const url = `${origin}/?desktop_session=${token}`;
  let closing;
  const close = () =>
    (closing ??= new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }));
  return { server, origin, url, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const runtime = await startServer();
  const ready = { type: "ready", url: runtime.url, origin: runtime.origin };
  if (process.send) process.send(ready);
  else console.log(JSON.stringify(ready));
  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("disconnect", shutdown);
  process.on("message", (message) => {
    if (message === "shutdown") void shutdown();
  });
}
