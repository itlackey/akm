#!/usr/bin/env node

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";

/** In-flight requests get this long to finish on shutdown; then the remaining connections are closed. */
const SHUTDOWN_GRACE_MS = 10_000;

let prepared = false;
async function prepareEnvironment() {
  if (prepared) return;
  prepared = true;
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
}

/**
 * Called only in a Node child (Electron supplies ELECTRON_RUN_AS_NODE before spawn). The settings are already resolved
 * (`resolveSettings`). `host` is the bind address. `origin` is the address the browser uses, which differs from the bind
 * behind a Docker port mapping or a proxy; it defaults to the bind address and the port actually chosen.
 * `allowedHosts` are extra `Host` names accepted, for a proxy that reaches the server under a private name.
 * @param {{ host?: string, port?: number, origin?: string, secret: string, allowedHosts?: string[], frameParents?: string[] }} options
 */
export async function startServer({
  host = "127.0.0.1",
  port = 0,
  origin: configured,
  secret,
  allowedHosts = [],
  frameParents = [],
}) {
  const configuredOrigin = configured === undefined ? undefined : parseOrigin(configured, "origin");
  validateSecret(secret);
  const frames = frameParents.map((parent) => parseOrigin(parent, "frameParents entry"));
  await prepareEnvironment();
  /** @type {import("node:http").RequestListener | undefined} */
  let handler;
  let protocol = "http";
  let originHost = "";
  /** @type {Set<string>} */
  let hosts = new Set();
  // The settings the request hook reads (src/lib/server/web-access.ts). `inflight` backs GET /api/session `active`.
  const web = { secret, origin: "", frameParents: frames, inflight: 0 };
  /** @type {{ __akmWeb?: typeof web }} */ (globalThis).__akmWeb = web;
  const server = http.createServer((req, res) => {
    web.inflight++;
    res.once("close", () => web.inflight--);
    const requested = hostOf(req.headers.host);
    if (
      requested === undefined ||
      !(requested === originHost || hosts.has(requested) || hosts.has(requested.replace(/:\d+$/, "")))
    ) {
      res.writeHead(403, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          ok: false,
          code: "HOST_NOT_ALLOWED",
          error: "This application only accepts the address it was started with.",
        }),
      );
      return;
    }
    // The framework derives its origin from these two, so it always sees the configured origin, whichever allowed
    // name the proxy used. The protocol header is server-owned: set for every request, never trusted from the network.
    req.headers.host = originHost;
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
  originHost = new URL(origin).host;
  hosts = new Set(allowedHosts.map((name) => name.toLowerCase()));
  web.origin = origin;
  // Import after environment initialization, including for loader subprocesses.
  // A computed specifier: the build output is generated and is not part of the type-checked program.
  ({ handler } = await import(new URL("../build/handler.js", import.meta.url).href));

  /**
   * A request to this server the way a proxy makes it: the origin's Host and Origin, and the secret in the header.
   * @param {string} method
   * @param {string} route
   * @returns {Promise<{ status: number, body: string }>}
   */
  const ask = (method, route) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: address.address === "0.0.0.0" ? "127.0.0.1" : address.address === "::" ? "::1" : address.address,
          port: address.port,
          path: route,
          method,
          headers: { Host: originHost, Origin: origin, Authorization: `Bearer ${secret}` },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.once("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.once("error", reject);
      req.end();
    });
  // Ready means the server answers authenticated requests, which is what a launcher waits for.
  const probe = await ask("GET", "/api/session");
  if (probe.status !== 200) throw new Error(`The server did not answer authenticated requests (${probe.status}).`);

  // Stop accepting; give requests in flight the grace period; then close what remains.
  let closing;
  const close = () =>
    (closing ??= new Promise((resolve) => {
      server.close(resolve);
      const idle = setInterval(() => server.closeIdleConnections(), 50);
      const limit = setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS);
      server.once("close", () => {
        clearInterval(idle);
        clearTimeout(limit);
      });
    }));
  /** A one-time login link for a browser this process opens. It is never printed. */
  const loginLink = async () => {
    const issued = await ask("POST", "/api/session/link");
    if (issued.status !== 200) throw new Error(`The server did not issue a login link (${issued.status}).`);
    return /** @type {string} */ (JSON.parse(issued.body).url);
  };
  return { server, origin, close, loginLink };
}

/**
 * Best effort: a missing opener or a failed open costs one line on stderr, never the server.
 * `url` may carry a one-time login code, so what is shown on failure is `shown`.
 * @param {string} url
 * @param {string} shown
 */
function openBrowser(url, shown) {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const opener = spawn(/** @type {string} */ (command), args, { detached: true, stdio: "ignore" });
    opener.once("error", () => console.error(`Could not open a browser; open ${shown} yourself.`));
    opener.unref();
  } catch {
    console.error(`Could not open a browser; open ${shown} yourself.`);
  }
}

/**
 * The Host header as `host[:port]` in lower case, or undefined when it is not one.
 * @param {string | undefined} value
 */
function hostOf(value) {
  if (!value || !/^[A-Za-z0-9.:[\]_-]+$/.test(value)) return undefined;
  try {
    return new URL(`http://${value}`).host;
  } catch {
    return undefined;
  }
}

/**
 * @param {string} value
 * @param {string} name
 */
function parseOrigin(value, name) {
  const message = `${name === "origin" ? "--origin" : name} must be http(s)://host[:port] with no path, the address the browser opens (got "${value}").`;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(message);
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password)
    throw new Error(message);
  return url.origin;
}

/** @param {string | undefined} secret */
function validateSecret(secret) {
  if (!secret)
    throw new Error(
      "No secret. Set the AKM_WEB_SECRET environment variable, or experimental.web.secret in the akm config, to at least 32 characters.",
    );
  if (secret.length < 32)
    throw new Error(
      "The secret is shorter than 32 characters. Set AKM_WEB_SECRET (or experimental.web.secret) to a longer one.",
    );
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const name = flag?.replace(/^--/, "").split("=")[0];
    if (flag?.startsWith("--") && ["open", "auto-login"].includes(name ?? "")) {
      values[/** @type {string} */ (name)] = true;
      continue;
    }
    if (!flag?.startsWith("--") || !["host", "port", "origin"].includes(name ?? "")) {
      console.warn(`Ignoring unknown argument ${flag}.`);
      continue;
    }
    values[/** @type {string} */ (name)] = flag.includes("=") ? flag.slice(flag.indexOf("=") + 1) : (argv[++i] ?? "");
  }
  return values;
}

/**
 * The web settings in akm's config (`experimental.web`), through akm-cli. Nothing is configured when akm-cli has none.
 * @returns {Promise<{ host?: string, port?: number, origin?: string, allowedHosts: string[], frameParents: string[], secret?: string }>}
 */
async function webSettings() {
  const { config } = await import("akm-cli/workspace");
  // Until akm-cli ships webSettings, nothing is configured. Remove this fallback (and the cast) when it does.
  const settings = /** @type {any} */ (config)?.webSettings;
  return typeof settings === "function" ? settings() : { allowedHosts: [], frameParents: [] };
}

/**
 * Flags override the config per key; the environment's AKM_WEB_SECRET overrides the configured secret and is removed
 * from the environment here, so CLI children never inherit it. AKM Desktop (AKM_DESKTOP_NATIVE=1) reads none of
 * `experimental.web`: loopback, the given or a free port, the bound address as origin, no extra hosts, no frame parents.
 * @param {Record<string, string | true>} args
 * @param {NodeJS.ProcessEnv} env
 */
async function resolveSettings(args, env) {
  const envSecret = env.AKM_WEB_SECRET;
  delete env.AKM_WEB_SECRET;
  const port = args.port === undefined ? undefined : Number(args.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535))
    throw new Error(`--port must be a number from 0 to 65535, not "${args.port}".`);
  if (args["auto-login"] && !args.open)
    throw new Error("--auto-login needs --open: it logs in the browser that --open starts.");
  if (env.AKM_DESKTOP_NATIVE === "1")
    return { host: "127.0.0.1", port: port ?? 0, secret: envSecret || undefined, allowedHosts: [], frameParents: [] };
  const web = await webSettings();
  return {
    host: /** @type {string | undefined} */ (args.host) || web.host,
    port: port ?? web.port ?? 0,
    origin: /** @type {string | undefined} */ (args.origin) || web.origin,
    secret: envSecret || web.secret,
    allowedHosts: web.allowedHosts ?? [],
    frameParents: web.frameParents ?? [],
  };
}

// The entry point is compared by real path: an npm bin link makes argv[1] a symlink to this file.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  let runtime;
  try {
    await prepareEnvironment();
    const settings = await resolveSettings(args, process.env);
    runtime = await startServer(/** @type {Parameters<typeof startServer>[0]} */ (settings));
  } catch (error) {
    console.error(/** @type {Error} */ (error).message);
    process.exit(2);
  }
  const ready = { type: "ready", origin: runtime.origin };
  if (process.send) process.send(ready);
  else console.log(JSON.stringify(ready));
  if (args.open) {
    try {
      openBrowser(args["auto-login"] ? await runtime.loginLink() : runtime.origin, runtime.origin);
    } catch (error) {
      console.error(`${/** @type {Error} */ (error).message} Open ${runtime.origin} yourself.`);
    }
  }
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
