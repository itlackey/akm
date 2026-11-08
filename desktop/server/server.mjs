#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";

/**
 * Called only in a Node child (Electron supplies ELECTRON_RUN_AS_NODE before spawn).
 * `host` is the bind address. `origin` is the address the browser uses, which differs from the bind behind a Docker
 * port mapping or a proxy; it defaults to the bind address and the port actually chosen.
 * @param {{ host?: string, port?: number, origin?: string }} [options]
 */
export async function startServer({ host = "127.0.0.1", port = 0, origin: configured } = {}) {
  if (!configured && isWildcard(host)) {
    throw new Error(
      `--host ${host} listens on every interface, so the browser's address cannot be known. Pass --origin <url> with the address you will open.`,
    );
  }
  if (configured) new URL(configured); // fail on a malformed --origin before listening
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
  let protocol = "http";
  const server = http.createServer((req, res) => {
    req.headers["x-akm-desktop-protocol"] = protocol;
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
    server.listen(port, host, () => resolve(undefined));
  });
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  const origin = configured ? new URL(configured).origin : `http://${hostname(host)}:${address.port}`;
  protocol = new URL(origin).protocol.slice(0, -1);
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

/** @param {string} host */
const isWildcard = (host) => host === "0.0.0.0" || host === "::" || host === "[::]";
/** @param {string} host */
const hostname = (host) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const name = flag?.replace(/^--/, "").split("=")[0];
    if (!flag?.startsWith("--") || !["host", "port", "origin"].includes(name ?? "")) {
      console.warn(`Ignoring unknown argument ${flag}.`);
      continue;
    }
    values[/** @type {string} */ (name)] = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : (argv[++i] ?? "");
  }
  return values;
}

// The entry point is compared by real path: an npm bin link makes argv[1] a symlink to this file.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const port = args.port === undefined ? 0 : Number(args.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`--port must be a number from 0 to 65535, not "${args.port}".`);
    process.exit(2);
  }
  let runtime;
  try {
    runtime = await startServer({ host: args.host || undefined, port, origin: args.origin || undefined });
  } catch (error) {
    console.error(/** @type {Error} */ (error).message);
    process.exit(2);
  }
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
