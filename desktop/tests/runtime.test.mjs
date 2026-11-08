// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFixture } from "../scripts/fixture.mjs";

const appRoot = process.env.AKM_DESKTOP_TEST_APP_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const electron = process.env.AKM_DESKTOP_TEST_RUNTIME ?? require("electron");

async function launch(t, { runtime = process.execPath, electronMode = false } = {}) {
  const fixture = await createFixture({ packageRoot: appRoot });
  t.after(() => fixture.cleanup());
  const child = fork(path.join(appRoot, "server/server.mjs"), [], {
    execPath: runtime,
    execArgv: [],
    env: { ...fixture.env, ...(electronMode ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.send("shutdown");
    });
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${stderr}`)), 15000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exit ${code}: ${stderr}`));
    });
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  const bootstrap = await fetch(ready.url, { redirect: "manual" });
  assert.equal(bootstrap.status, 303);
  assert.equal(bootstrap.headers.get("location"), "/");
  assert.match(bootstrap.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
  const request = (route, body, extra = {}) =>
    fetch(`${ready.origin}/api${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: cookie,
        ...(body === undefined ? {} : { Origin: ready.origin, "Content-Type": "application/json" }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...ready, fixture, cookie, request, child };
}

test("loopback session bootstrap, authentication and strict write origin", async (t) => {
  const app = await launch(t);
  const denied = await fetch(`${app.origin}/api/meta`);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, "UNAUTHORIZED");
  assert.equal(
    (await fetch(`${app.origin}/api/meta`, { headers: { Cookie: "akm_desktop_session_80=invalid" } })).status,
    401,
  );
  assert.equal(
    (await app.request("/knowledge/create", { name: "bad", content: "# bad" }, { Origin: "http://evil.example" }))
      .status,
    403,
  );
  assert.equal((await app.request("/knowledge/create", { name: "bad", content: "# bad" }, { Origin: "" })).status, 403);
  assert.equal(
    (await app.request("/knowledge/create", { name: "bad", content: "# bad" }, { "Content-Type": "text/plain" }))
      .status,
    415,
  );
  assert.equal((await app.request("/unknown")).status, 404);
  assert.equal((await fetch(`${app.origin}/api/desktop/software`)).status, 401);
  assert.equal(
    (await app.request("/desktop/software", { action: "install-cli" }, { Origin: "http://evil.example" })).status,
    403,
  );
  assert.equal(
    (await app.request("/desktop/software", { action: "desktop-menu-install" }, { Origin: "http://evil.example" }))
      .status,
    403,
  );
  assert.equal((await app.request("/desktop/software", { action: "shell", command: "anything" })).status, 400);
  assert.equal(
    (await app.request("/desktop/software", { action: "install-plugin", harness: "unexpected" })).status,
    400,
  );
  const software = (await (await app.request("/desktop/software")).json()).data;
  assert.equal(software.host.phase, "idle", "Reading status must not invoke installers or model-backed operations");
  assert.equal(
    software.desktop.menu.supported,
    false,
    "A server without Electron must not claim it can install a menu entry",
  );
  const badHost = await new Promise((resolve, reject) => {
    const req = http.get(`${app.origin}/api/meta`, { headers: { Host: "evil.example", Cookie: app.cookie } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.once("error", reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await app.request("/meta", undefined, { "x-akm-desktop-protocol": "https" })).status, 200);
  const rawAction = (body) =>
    fetch(`${app.origin}/api/feedback`, {
      method: "POST",
      headers: { Cookie: app.cookie, Origin: app.origin, "Content-Type": "application/json" },
      body,
    });
  assert.equal((await rawAction("{")).status, 400);
  assert.equal((await rawAction(" ".repeat(65_537))).status, 413);
  const page = await fetch(app.origin, { headers: { Cookie: app.cookie } });
  assert.equal(page.status, 200, "Serve the completed production build before checking its CSP");
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /script-src[^;]*'nonce-/);
  assert.doesNotMatch(csp.match(/script-src[^;]*/)[0], /unsafe-inline/);
  const desktop = await (await app.request("/desktop")).json();
  assert.equal(desktop.ok, true);
  assert.equal(typeof desktop.data.hostname, "string");
  assert.equal(typeof desktop.data.akmVersion, "string");
  assert.equal((await (await app.request("/desktop/preferences")).json()).data.theme, "system");
  assert.equal((await app.request("/desktop/preferences", { theme: "invalid" })).status, 400);
  // An unknown field is ignored (with one warning), never an error.
  assert.equal((await app.request("/desktop/preferences", { theme: "dark", unrelated: true })).status, 200);
  assert.equal((await (await app.request("/desktop/preferences")).json()).data.theme, "dark");
  assert.equal(
    JSON.parse(await readFile(path.join(app.fixture.env.XDG_CONFIG_HOME, "akm-desktop/preferences.json"), "utf8"))
      .theme,
    "dark",
  );
  const configResponse = await app.request("/config");
  const configText = await configResponse.text();
  const token = new URL(app.url).searchParams.get("desktop_session");
  assert.ok(!configText.includes(token), "The session credential must never be returned by AKM config inspection");
  const config = JSON.parse(configText).data;
  assert.equal(
    config.env.find((item) => item.name === "AKM_DESKTOP_SESSION_TOKEN"),
    undefined,
    "the credential is removed from the server environment",
  );
  assert.ok(!config.env.some((item) => item.name === "AKM_DESKTOP_SESSION"));
});

test("existing AKM reads, revision-safe editing, creation and non-overwriting copy", async (t) => {
  const app = await launch(t);
  const sourceRoute = `/desktop/file?ref=${encodeURIComponent(app.fixture.refs.document)}`;
  const source = (await (await app.request(sourceRoute)).json()).data;
  assert.equal(source.content, app.fixture.content);
  const saved = await app.request("/desktop/file/save", {
    ref: source.ref,
    revision: source.revision,
    content: `${source.content}\nA verified extra step.\n`,
  });
  assert.equal(saved.status, 200, await saved.text());
  const conflict = await app.request("/desktop/file/save", {
    ref: source.ref,
    revision: source.revision,
    content: "# obsolete",
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "ASSET_CONTENT_CHANGED");
  const created = await app.request("/knowledge/create", {
    name: "created-in-test",
    content: "# Created\n\nA synthetic new note.",
    bundle: "personal",
  });
  assert.equal(created.status, 200, await created.text());
  const copied = await app.request("/asset/copy", {
    sourceRef: app.fixture.refs.vendor,
    target: "personal",
    newName: "vendor-copy",
  });
  assert.equal(copied.status, 200, await copied.text());
  const repeat = await app.request("/asset/copy", {
    sourceRef: app.fixture.refs.vendor,
    target: "personal",
    newName: "vendor-copy",
  });
  assert.notEqual(repeat.status, 200);
  assert.notEqual(
    (
      await app.request("/asset/copy", {
        sourceRef: app.fixture.refs.vendor,
        target: "personal",
        newName: "vendor-copy",
        force: true,
      })
    ).status,
    200,
    "an unknown force field is ignored; a copy never overwrites",
  );
  const vendor = await app.request(`/desktop/file?ref=${encodeURIComponent(app.fixture.refs.vendor)}`);
  assert.equal(vendor.status, 200, "the owner may read any file in a configured bundle");
  const history = await app.request(`/asset/history?ref=${encodeURIComponent(app.fixture.refs.document)}`);
  assert.equal(history.status, 200);
  assert.match(await readFile(app.fixture.documentPath, "utf8"), /verified extra step/);
  const memory = (await (await app.request(`/desktop/file?ref=${encodeURIComponent(app.fixture.refs.memory)}`)).json())
    .data;
  assert.equal(memory.type, "memory");
  const memorySaved = await app.request("/desktop/file/save", {
    ref: memory.ref,
    revision: memory.revision,
    content: `${memory.content}\nVerify the copy regularly.\n`,
  });
  assert.equal(memorySaved.status, 200, await memorySaved.text());
});

test("Electron Node child loads native SQLite and existing CLI-spawning workspace actions", async (t) => {
  const app = await launch(t, { runtime: electron, electronMode: true });
  const search = await app.request("/search?q=backup");
  assert.equal(search.status, 200, await search.text());
  // feedback executes AKM's existing argument-validated CLI subprocess.
  const action = await app.request("/feedback", { ref: app.fixture.refs.document, signal: "positive" });
  assert.equal(action.status, 200, await action.text());
  const proposals = await app.request("/proposals");
  assert.equal(proposals.status, 200, await proposals.text());
  const missing = await app.request("/proposals/nonexistent/accept", {});
  assert.equal(missing.status, 404);
});

test("a request before the app has loaded gets the 503 error shape the renderer reads", async (t) => {
  const { mkdtemp, mkdir, copyFile, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const root = await mkdtemp(path.join(os.tmpdir(), "akm-desktop-starting-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "server"));
  await mkdir(path.join(root, "build"));
  await copyFile(path.join(appRoot, "server/server.mjs"), path.join(root, "server/server.mjs"));
  await copyFile(path.join(appRoot, "package.json"), path.join(root, "package.json"));
  // A stand-in app that reports the listening origin, then finishes loading only when told to.
  await writeFile(
    path.join(root, "build/handler.js"),
    `process.send({ type: 'loading', origin: process.env.AKM_DESKTOP_ORIGIN });
await new Promise(resolve => process.on('message', message => { if (message === 'load') resolve(); }));
export const handler = (req, res) => res.end('loaded');
`,
  );
  const child = fork(path.join(root, "server/server.mjs"), [], {
    execArgv: [],
    env: { ...process.env, HOME: root },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(() => child.kill());
  const loading = await new Promise((resolve) =>
    child.on("message", (message) => {
      if (message.type === "loading") resolve(message);
    }),
  );
  const response = await fetch(`${loading.origin}/api/meta`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: "STARTING", error: "AKM Desktop is still starting." });
  const ready = new Promise((resolve) =>
    child.on("message", (message) => {
      if (message.type === "ready") resolve();
    }),
  );
  child.send("load");
  await ready;
  assert.equal(await (await fetch(`${loading.origin}/`)).text(), "loaded");
});

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Starts the server with flags, then talks to its bind address while claiming the configured host name. */
async function launchWith(t, args) {
  const fixture = await createFixture({ packageRoot: appRoot });
  t.after(() => fixture.cleanup());
  const child = fork(path.join(appRoot, "server/server.mjs"), args, {
    execArgv: [],
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => child.kill());
  const ready = await new Promise((resolve, reject) => {
    child.once("exit", (code) => reject(new Error(`Server exit ${code}`)));
    child.once("message", resolve);
  });
  const token = new URL(ready.url).searchParams.get("desktop_session");
  const send = (route, { host = new URL(ready.origin).host, method = "GET", headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: bindPort(args), path: route, method, headers: { Host: host, ...headers } },
        (res) => {
          res.resume();
          res.once("end", () => resolve({ status: res.statusCode, headers: res.headers }));
        },
      );
      req.once("error", reject);
      req.end();
    });
  return { ready, token, send };
}
const bindPort = (args) => Number(args[args.indexOf("--port") + 1]);

test("a configured --origin and --host serve under that address, with every check still on", async (t) => {
  const port = await freePort();
  const origin = `http://akm.test:${port}`;
  const app = await launchWith(t, ["--host", "127.0.0.1", "--port", String(port), "--origin", origin]);
  assert.equal(app.ready.origin, origin);
  assert.equal(app.ready.url, `${origin}/?desktop_session=${app.token}`);
  const bootstrap = await app.send(`/?desktop_session=${app.token}`);
  assert.equal(bootstrap.status, 303);
  const setCookie = bootstrap.headers["set-cookie"][0];
  assert.match(setCookie, new RegExp(`^akm_desktop_session_${port}=`));
  assert.doesNotMatch(setCookie, /Secure/);
  const cookie = setCookie.split(";")[0];
  assert.equal((await app.send("/api/desktop", { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await app.send("/api/desktop")).status, 401, "no token");
  assert.equal(
    (await app.send("/api/desktop", { host: `127.0.0.1:${port}`, headers: { Cookie: cookie } })).status,
    403,
    "a Host other than the configured origin",
  );
  const write = (originHeader) =>
    app.send("/api/feedback", {
      method: "POST",
      headers: { Cookie: cookie, Origin: originHeader, "Content-Type": "application/json", "Content-Length": "2" },
    });
  assert.equal((await write("http://evil.example")).status, 403, "a write from another origin");
});

test("an https origin marks the session cookie Secure", async (t) => {
  const port = await freePort();
  const app = await launchWith(t, ["--port", String(port), "--origin", `https://akm.test:${port}`]);
  const bootstrap = await app.send(`/?desktop_session=${app.token}`);
  assert.equal(bootstrap.status, 303);
  assert.match(bootstrap.headers["set-cookie"][0], /; Secure$/);
});

test("instances on different ports use different cookie names", async (t) => {
  const [first, second] = [await freePort(), await freePort()];
  const names = [];
  for (const port of [first, second]) {
    const app = await launchWith(t, ["--port", String(port)]);
    names.push((await app.send(`/?desktop_session=${app.token}`)).headers["set-cookie"][0].split("=")[0]);
  }
  assert.notEqual(names[0], names[1]);
});

test("a wildcard --host without --origin exits non-zero and says why", async () => {
  const child = spawn(process.execPath, [path.join(appRoot, "server/server.mjs"), "--host", "0.0.0.0"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [code] = await new Promise((resolve) => child.once("exit", (...exit) => resolve(exit)));
  assert.notEqual(code, 0);
  assert.match(stderr, /--origin/);
});
