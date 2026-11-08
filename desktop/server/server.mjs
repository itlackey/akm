#!/usr/bin/env node

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";

/**
 * Called only in a Node child (Electron supplies ELECTRON_RUN_AS_NODE before spawn).
 * `host` is the bind address. `origin` is the address the browser uses, which differs from the bind behind a Docker
 * port mapping or a proxy; it defaults to the bind address and the port actually chosen.
 * @param {{ host?: string, port?: number, origin?: string }} [options]
 */
export async function startServer({ host = "127.0.0.1", port = 0, origin: configured } = {}) {
  const configuredOrigin = configured === undefined ? undefined : parseOrigin(configured);
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
  if (!configuredOrigin && (address.address === "0.0.0.0" || address.address === "::")) {
    server.close();
    throw new Error(
      `--host ${host} listens on every interface, so the browser's address cannot be known. Pass --origin <url> with the address you will open.`,
    );
  }
  // Without --origin, the browser uses the address actually bound (so "Localhost" and "0:0:0:0:0:0:0:1" normalise).
  const origin =
    configuredOrigin ??
    new URL(`http://${net.isIPv6(address.address) ? `[${address.address}]` : address.address}:${address.port}`).origin;
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

/**
 * Whether to open the printed URL in the default browser: only for a person at a terminal on a machine with a screen.
 * @param {{ env: NodeJS.ProcessEnv, platform: string, hasParent: boolean, isTTY: boolean, exists?: (file: string) => boolean }} context
 */
export function shouldOpenBrowser({ env, platform, hasParent, isTTY, exists = existsSync }) {
  if (hasParent || !isTTY) return false; // Electron (IPC parent), scripts and supervisors (piped stdout)
  if (env.SSH_CONNECTION || env.SSH_TTY || env.CI) return false;
  if (exists("/.dockerenv") || exists("/run/.containerenv")) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

/**
 * Best effort: a missing opener or a failed open costs one line on stderr, never the server.
 * @param {string} url
 */
function openBrowser(url) {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", '""', url]
        : ["xdg-open", url];
  try {
    const opener = spawn(/** @type {string} */ (command), args, { detached: true, stdio: "ignore" });
    opener.once("error", () => console.error(`Could not open a browser; open ${url} yourself.`));
    opener.unref();
  } catch {
    console.error(`Could not open a browser; open ${url} yourself.`);
  }
}

/** @param {string} value */
function parseOrigin(value) {
  const message = "--origin must be http(s)://host[:port], the address the browser opens.";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(message);
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash)
    console.warn(`Ignoring the path in --origin ${value}: the app is always served from /.`);
  return url.origin;
}

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
  if (
    shouldOpenBrowser({
      env: process.env,
      platform: process.platform,
      hasParent: process.send !== undefined,
      isTTY: Boolean(process.stdout.isTTY),
    })
  )
    openBrowser(runtime.url);
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
