// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The ways into the web UI (docs: AKM Web): the secret as a header, the login form and its session, the one-time login
// link, the checks that are always on, framing, and what a launcher can rely on. Server level: each test starts the real
// server with plain Node against a synthetic home, and talks to it over HTTP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { createFixture } from "../scripts/fixture.mjs";
import { withFreePort } from "./support.mjs";

const appRoot = process.env.AKM_DESKTOP_TEST_APP_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const server = path.join(appRoot, "server/server.mjs");
const form = (fields) => new URLSearchParams(fields).toString();
const FORM = "application/x-www-form-urlencoded";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One HTTP request to `port` on loopback, claiming `host`. Resolves with the whole response. */
function send(port, route, { host, method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        agent: false,
        headers: { ...(host ? { Host: host } : {}), ...headers },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.once("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }),
        );
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

/**
 * Starts the server and waits for its ready line on stdout.
 * `web` is written to `experimental.web` in the config; `setup(fixture)` may change the fixture first.
 */
async function start(t, { args = [], env = {}, web, secret = randomBytes(32).toString("hex"), setup } = {}) {
  const fixture = await createFixture({ packageRoot: appRoot, index: false });
  t.after(() => fixture.cleanup());
  if (web) {
    const file = path.join(fixture.root, "config/config.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.experimental = { ...config.experimental, web };
    await writeFile(file, JSON.stringify(config));
  }
  await setup?.(fixture);
  const child = spawn(process.execPath, [server, ...args], {
    env: { ...fixture.env, ...(secret ? { AKM_WEB_SECRET: secret } : {}), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(async () => {
    child.kill("SIGTERM");
    await exited;
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ready line in 60 s.\n${output}`)), 60_000);
    exited.then((code) => reject(new Error(`Server exit ${code}.\n${output}`)));
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output += chunk;
        const line = output.split("\n").find((l) => l.startsWith('{"type":"ready"'));
        if (line) {
          clearTimeout(timer);
          resolve(JSON.parse(line));
        }
      });
  });
  const url = new URL(ready.origin);
  // The origin's port is the address as the browser has it; the server listens on --port when that is given.
  const flagged = args.includes("--port") ? args[args.indexOf("--port") + 1] : "0";
  const port = Number(flagged) || Number(url.port);
  const bearer = { Authorization: `Bearer ${secret}` };
  const app = {
    ready,
    origin: ready.origin,
    port,
    secret,
    bearer,
    child,
    exited,
    fixture,
    output: () => output,
    request: (route, options = {}) => send(port, route, { host: url.host, ...options }),
    /** A write the way a browser makes it: with the origin. */
    write: (route, body, extra = {}) =>
      app.request(route, {
        method: "POST",
        headers: { Origin: ready.origin, "Content-Type": "application/json", ...extra },
        body: JSON.stringify(body),
      }),
    /** The login form's post. */
    login: (value = secret) =>
      app.request("/api/session", {
        method: "POST",
        headers: { Origin: ready.origin, "Content-Type": FORM },
        body: form({ secret: value }),
      }),
  };
  return app;
}

/** The session cookie a login or link response set, as `name=value`. */
const cookieOf = (response) => response.headers["set-cookie"]?.[0]?.split(";")[0];

/** Runs the server until it exits; resolves with its exit code and what it printed. */
async function refusal(args, env) {
  const fixture = await createFixture({ packageRoot: appRoot, index: false });
  try {
    const child = spawn(process.execPath, [server, ...args], {
      env: { ...fixture.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output += chunk;
      });
    const [code] = await new Promise((resolve) => child.once("exit", (...exit) => resolve(exit)));
    return { code, output };
  } finally {
    await fixture.cleanup();
  }
}

test("startup refuses with a message that says what to set", async () => {
  const secret = "s".repeat(32);
  const none = await refusal([], {});
  assert.equal(none.code, 2);
  assert.match(none.output, /AKM_WEB_SECRET/);
  assert.match(none.output, /experimental\.web\.secret/);
  const short = await refusal([], { AKM_WEB_SECRET: "short" });
  assert.equal(short.code, 2);
  assert.match(short.output, /shorter than 32 characters/);
  for (const origin of ["http://akm.test/akm", "http://akm.test/?x=1", "http://akm.test/#top"]) {
    const bad = await refusal(["--origin", origin], { AKM_WEB_SECRET: secret });
    assert.equal(bad.code, 2, origin);
    assert.match(bad.output, /--origin must be http\(s\):\/\/host\[:port\] with no path/, origin);
  }
  const lonely = await refusal(["--auto-login"], { AKM_WEB_SECRET: secret });
  assert.equal(lonely.code, 2);
  assert.match(lonely.output, /--auto-login needs --open/);
  for (const output of [none.output, short.output]) assert.ok(!output.includes(secret));
});

test("the login form, the session cookie and logout", async (t) => {
  const app = await start(t);
  assert.deepEqual(app.ready, { type: "ready", origin: app.origin }, "the ready line is the origin and nothing else");
  const form1 = await app.request("/", { headers: { Accept: "text/html" } });
  assert.equal(form1.status, 401);
  assert.match(form1.headers["content-type"], /^text\/html/);
  assert.match(form1.text, /<input type="password" name="secret"/);
  assert.match(form1.text, /<form method="post" action="api\/session">/);
  assert.equal(form1.headers["x-frame-options"], "DENY");
  assert.equal(form1.headers["referrer-policy"], "same-origin", "a no-referrer form would post with Origin: null");
  assert.doesNotMatch(form1.text, /<script|https?:\/\//, "a self-contained page: no script, no external asset");
  const nested = await app.request("/settings/bundles", { headers: { Accept: "text/html" } });
  assert.match(nested.text, /action="\.\.\/api\/session"/, "the form posts back to the site root from a nested route");
  const api = await app.request("/api/meta", { headers: { Accept: "text/html" } });
  assert.equal(api.status, 401, "an API request never gets HTML");
  assert.equal(api.json().code, "UNAUTHORIZED");

  const wrong = await app.login("x".repeat(32));
  assert.equal(wrong.status, 401);
  assert.match(wrong.text, /role="alert"/);
  assert.equal(wrong.headers["set-cookie"], undefined);
  assert.equal(
    (
      await app.request("/api/session", {
        method: "POST",
        headers: { "Content-Type": FORM },
        body: form({ secret: app.secret }),
      })
    ).status,
    403,
    "no Origin",
  );
  assert.equal(
    (
      await app.request("/api/session", {
        method: "POST",
        headers: { Origin: "http://evil.example", "Content-Type": FORM },
        body: form({ secret: app.secret }),
      })
    ).status,
    403,
    "foreign Origin",
  );
  assert.equal(
    (
      await app.request("/api/session", {
        method: "POST",
        headers: { Origin: app.origin, "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    415,
  );

  const right = await app.login();
  assert.equal(right.status, 303);
  assert.equal(right.headers.location, "../", "redirects are relative");
  const setCookie = right.headers["set-cookie"][0];
  assert.match(setCookie, new RegExp(`^akm_desktop_session_${app.port}=[\\w-]{40,};`));
  assert.match(setCookie, /; HttpOnly; SameSite=Strict$/);
  assert.doesNotMatch(setCookie, /Domain=/, "host-only");
  assert.ok(!setCookie.includes(app.secret), "the secret is never in a cookie");
  const cookie = cookieOf(right);
  assert.deepEqual((await app.request("/api/session", { headers: { Cookie: cookie } })).json(), {
    ok: true,
    active: false,
    session: true,
  });
  assert.equal((await app.request("/", { headers: { Cookie: cookie, Accept: "text/html" } })).status, 200);

  assert.equal((await app.write("/api/session/logout", {})).status, 401, "logout needs a session");
  assert.equal(
    (await app.request("/api/session/logout", { method: "POST", headers: { Cookie: cookie } })).status,
    403,
    "logout is a write",
  );
  const out = await app.write("/api/session/logout", {}, { Cookie: cookie });
  assert.equal(out.status, 200);
  assert.match(out.headers["set-cookie"][0], /Max-Age=0/);
  assert.equal((await app.request("/api/session", { headers: { Cookie: cookie } })).status, 401, "the session is gone");
});

test("a restart ends sessions; two instances do not share them", async (t) => {
  const first = await start(t, { args: ["--port", "0"] });
  const second = await start(t, { args: ["--port", "0"] });
  const one = cookieOf(await first.login());
  const two = cookieOf(await second.login());
  assert.notEqual(one.split("=")[0], two.split("=")[0], "a cookie name per port");
  assert.equal((await first.request("/api/session", { headers: { Cookie: one } })).status, 200);
  assert.equal((await second.request("/api/session", { headers: { Cookie: one } })).status, 401);
  assert.equal((await second.request("/api/session", { headers: { Cookie: two } })).status, 200);
  // The same secret and port after a restart: the cookie is not accepted by a server that never issued it.
  const secret = randomBytes(32).toString("hex");
  const before = await start(t, { args: ["--port", "0"], secret });
  const { port } = before;
  const cookie = cookieOf(await before.login());
  assert.equal((await before.request("/api/session", { headers: { Cookie: cookie } })).status, 200);
  before.child.kill("SIGTERM");
  assert.equal(await before.exited, 0);
  const after = await start(t, { args: ["--port", String(port)], secret });
  assert.equal((await after.request("/api/session", { headers: { Cookie: cookie } })).status, 401);
  assert.equal(
    (await after.request("/api/session", { headers: after.bearer })).status,
    200,
    "the header needs no session",
  );
});

test("the header allows a request without a session, and the secret appears nowhere", async (t) => {
  const app = await start(t);
  const ok = await app.request("/api/session", { headers: app.bearer });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["set-cookie"], undefined, "no session, so no cookie");
  const page = await app.request("/", { headers: { ...app.bearer, Accept: "text/html" } });
  assert.equal(page.status, 200);
  assert.equal(page.headers["set-cookie"], undefined);
  assert.equal(
    (await app.request("/api/session", { headers: { Authorization: `Bearer ${"x".repeat(64)}` } })).status,
    401,
  );
  assert.equal(
    (await app.request("/api/session", { headers: { Authorization: app.secret } })).status,
    401,
    "not a Bearer header",
  );
  const wrongPage = await app.request("/", { headers: { Authorization: "Bearer nope", Accept: "text/html" } });
  assert.equal(wrongPage.status, 401);
  assert.doesNotMatch(wrongPage.text, /<form/, "a program with the wrong secret is not offered a form");
  assert.equal(
    (await app.write("/api/desktop/preferences", { theme: "dark" }, app.bearer)).status,
    200,
    "a write with the header",
  );
  const config = (await app.request("/api/config", { headers: app.bearer })).text;
  assert.ok(!config.includes(app.secret), "AKM config inspection never shows it");
  assert.equal(
    JSON.parse(config).data.env.find((item) => item.name === "AKM_WEB_SECRET"),
    undefined,
    "not in the server's environment",
  );
  assert.ok(!page.text.includes(app.secret));
  const link = await app.write("/api/session/link", {}, app.bearer);
  assert.ok(!link.text.includes(app.secret));
  assert.ok(!app.output().includes(app.secret), "nothing is printed");
  assert.ok(!JSON.stringify(Object.fromEntries(Object.entries(ok.headers))).includes(app.secret));
});

test("a proxy's own Authorization scheme does not lock a person out; only a Bearer header is the secret's", async (t) => {
  const app = await start(t);
  const basic = { Authorization: `Basic ${Buffer.from("user:pass").toString("base64")}` };
  const html = { Accept: "text/html" };
  const page = await app.request("/", { headers: { ...basic, ...html } });
  assert.equal(page.status, 401);
  assert.match(page.text, /<form/, "a navigation behind Basic auth is offered the login form");
  assert.equal((await app.request("/api/session", { headers: basic })).status, 401, "an API call is not served");
  const cookie = cookieOf(await app.login());
  const served = await app.request("/api/session", { headers: { ...basic, Cookie: cookie } });
  assert.equal(served.status, 200, "Basic header and a valid session");
  assert.equal(served.json().session, true);
  const wrong = await app.request("/api/session", { headers: { Authorization: "Bearer nope", Cookie: cookie } });
  assert.equal(wrong.status, 401, "a wrong Bearer secret is not rescued by the cookie");
  const wrongPage = await app.request("/", { headers: { Authorization: "Bearer nope", Cookie: cookie, ...html } });
  assert.equal(wrongPage.status, 401);
  assert.doesNotMatch(wrongPage.text, /<form/);
});

test("a program that writes sends the origin itself, with the header too", async (t) => {
  const app = await start(t);
  for (const [route, body] of [
    ["/api/session/link", {}],
    ["/api/desktop/preferences", { theme: "dark" }],
  ]) {
    const post = (headers) =>
      app.request(route, {
        method: "POST",
        headers: { ...app.bearer, "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const none = await post({});
    assert.equal(none.status, 403, `${route} without Origin`);
    assert.equal(none.json().code, "ORIGIN_NOT_ALLOWED");
    assert.equal((await post({ Origin: "http://evil.example" })).status, 403, `${route} with a foreign Origin`);
    assert.equal((await post({ Origin: app.origin })).status, 200, `${route} with the configured Origin`);
  }
  const cookie = cookieOf(await app.login());
  assert.equal(
    (await app.write("/api/session/link", {}, { Cookie: cookie })).status,
    403,
    "a link is issued only to the header",
  );
  assert.equal(
    (
      await app.request("/api/session/link", {
        headers: { Origin: app.origin, Authorization: "Bearer nope" },
        method: "POST",
      })
    ).status,
    401,
  );
  const preflight = await app.request("/api/desktop", {
    method: "OPTIONS",
    headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(preflight.headers["access-control-allow-origin"], undefined, "no CORS");
  assert.equal(
    (await app.request("/api/desktop", { headers: { ...app.bearer, Origin: "http://evil.example" } })).headers[
      "access-control-allow-origin"
    ],
    undefined,
  );
  assert.equal((await app.request("/api/desktop", { headers: app.bearer })).headers["cache-control"], "no-store");
});

test("a login link works once, and opens a session", async (t) => {
  const app = await start(t);
  const issued = await app.write("/api/session/link", {}, app.bearer);
  const { url } = issued.json();
  assert.match(url, new RegExp(`^${app.origin}/\\?login=[\\w-]{40,}$`));
  const route = url.slice(app.origin.length);
  // As a launcher or an address typed in the bar: the visit starts on no site or on this one, and the redirect follows.
  for (const site of ["none", "same-origin"]) {
    const again = JSON.parse((await app.write("/api/session/link", {}, app.bearer)).text).url.slice(app.origin.length);
    const redirect = await app.request(again, { headers: { "Sec-Fetch-Site": site } });
    assert.equal(redirect.status, 303, site);
    assert.equal(redirect.headers.location, "./");
    assert.match(redirect.headers["set-cookie"][0], /HttpOnly; SameSite=Strict$/);
    assert.equal(redirect.headers["cache-control"], "no-store");
    assert.equal(redirect.headers["referrer-policy"], "no-referrer");
  }
  // A navigation that began on another site does not send the cookie on a redirect; a refresh does.
  for (const site of ["cross-site", "same-site"]) {
    const again = JSON.parse((await app.write("/api/session/link", {}, app.bearer)).text).url.slice(app.origin.length);
    const refresh = await app.request(again, { headers: { "Sec-Fetch-Site": site } });
    assert.equal(refresh.status, 200, site);
    assert.equal(refresh.headers["referrer-policy"], "no-referrer");
    assert.match(refresh.text, /http-equiv="refresh" content="0;url=\.\/"/);
    assert.match(refresh.headers["set-cookie"][0], /HttpOnly; SameSite=Strict$/);
  }
  const used = await app.request(route, { headers: { "Sec-Fetch-Site": "none" } });
  assert.equal(used.status, 303);
  const cookie = cookieOf(used);
  assert.equal((await app.request("/api/session", { headers: { Cookie: cookie } })).status, 200);
  const second = await app.request(route, { headers: { "Sec-Fetch-Site": "none", Accept: "text/html" } });
  assert.equal(second.headers["set-cookie"], undefined, "a link works once");
  assert.equal(second.status, 401);
  assert.match(second.text, /<form/, "a used link leads to the login form");
});

test("a browser opens only with --open, and logs in only with --auto-login", {
  skip: process.platform === "win32" && "the opener is a shell script",
}, async (t) => {
  const bin = path.join(await mkdtemp(path.join(os.tmpdir(), "akm-web-opener-")), "bin");
  t.after(() => rm(path.dirname(bin), { recursive: true, force: true }));
  await mkdir(bin);
  const log = path.join(bin, "opened.log");
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  await writeFile(path.join(bin, opener), `#!/bin/sh\necho "$1" >> "${log}"\n`);
  await chmod(path.join(bin, opener), 0o755);
  const withOpener = (args) =>
    start(t, {
      args,
      setup: (fixture) => {
        fixture.env.PATH = `${bin}:${fixture.env.PATH}`;
      },
    });
  const opened = async () => {
    for (let i = 0; i < 40; i++) {
      const text = await readFile(log, "utf8").catch(() => "");
      if (text) return text.trim().split("\n");
      await sleep(50);
    }
    return [];
  };

  const plain = await withOpener([]);
  await sleep(500);
  assert.deepEqual(await opened(), [], "nothing opens without --open");
  plain.child.kill("SIGTERM");
  await plain.exited;

  const shown = await withOpener(["--open"]);
  assert.deepEqual(await opened(), [shown.origin], "--open opens the address, with no credential");
  const login = await shown.request("/", { headers: { Accept: "text/html" } });
  assert.equal(login.status, 401);
  assert.match(login.text, /<form/);
  await readFile(log, "utf8").then(() => writeFile(log, ""));

  const auto = await withOpener(["--open", "--auto-login"]);
  const [link] = await opened();
  assert.match(link, new RegExp(`^${auto.origin}/\\?login=[\\w-]{40,}$`));
  assert.ok(!auto.output().includes(link.split("login=")[1]), "the link is never printed");
  assert.ok(!auto.output().includes(auto.secret));
  const arrived = await auto.request(link.slice(auto.origin.length), { headers: { "Sec-Fetch-Site": "none" } });
  assert.equal(arrived.status, 303);
  assert.equal((await auto.request("/api/session", { headers: { Cookie: cookieOf(arrived) } })).status, 200);
});

test("the environment's secret does not depend on the configured reference", async (t) => {
  const reference = "$AKM_WEB_TEST_UNSET_REFERENCE";
  const app = await start(t, { web: { secret: reference } });
  assert.equal((await app.request("/api/session", { headers: app.bearer })).status, 200);
  const unread = await createFixture({ packageRoot: appRoot, index: false });
  try {
    const file = path.join(unread.root, "config/config.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    config.experimental = { web: { secret: reference } };
    await writeFile(file, JSON.stringify(config));
    const child = spawn(process.execPath, [server], { env: { ...unread.env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output += chunk;
      });
    const [code] = await new Promise((resolve) => child.once("exit", (...exit) => resolve(exit)));
    assert.equal(code, 2, "with no AKM_WEB_SECRET the unreadable reference stops startup");
    assert.match(output, /AKM_WEB_TEST_UNSET_REFERENCE/);
  } finally {
    await unread.cleanup();
  }
});

test("AKM Desktop's launch settings ignore the address flags", async (t) => {
  const app = await start(t, {
    env: { AKM_DESKTOP_NATIVE: "1" },
    args: ["--host", "0.0.0.0", "--origin", "http://remote.test:9999"],
  });
  assert.match(app.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("active is true while another request is served, false after", async (t) => {
  const app = await start(t);
  const active = async () => (await app.request("/api/session", { headers: app.bearer })).json().active;
  assert.equal(await active(), false);
  // A write whose body has not arrived is a request being served.
  const pending = http.request({
    host: "127.0.0.1",
    port: app.port,
    path: "/api/desktop/preferences",
    method: "POST",
    agent: false,
    headers: {
      Host: new URL(app.origin).host,
      ...app.bearer,
      Origin: app.origin,
      "Content-Type": "application/json",
      "Content-Length": "16",
    },
  });
  pending.on("error", () => {});
  pending.write('{"theme"');
  await sleep(300);
  assert.equal(await active(), true);
  pending.destroy();
  for (let i = 0; i < 40 && (await active()); i++) await sleep(50);
  assert.equal(await active(), false);
});

test("active is true while a host-tool operation runs", async (t) => {
  const release = "release";
  const app = await start(t, {
    setup: async (fixture) => {
      // Only stubs are on PATH. The `akm` stub answers its checks at once and holds the upgrade until released.
      const bin = path.join(fixture.root, "bin");
      await mkdir(bin);
      const state = JSON.stringify({
        currentVersion: "0.10.261104",
        latestVersion: "0.10.261104",
        updateAvailable: false,
        currentChannel: "latest",
        channel: "latest",
        plugins: [],
      });
      await writeFile(
        path.join(bin, "akm"),
        `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nif (args[0] === '--version') console.log('0.10.261104');\nelse if (args.includes('--check')) console.log(${JSON.stringify(state)});\nelse { const wait = () => fs.existsSync(${JSON.stringify(path.join(fixture.root, release))}) ? console.log(${JSON.stringify(state)}) : setTimeout(wait, 50); wait(); }\n`,
        { mode: 0o755 },
      );
      await writeFile(path.join(bin, "bun"), `#!${process.execPath}\nconsole.log('1.3.14');\n`, { mode: 0o755 });
      fixture.env.PATH = bin;
    },
  });
  const active = async () => (await app.request("/api/session", { headers: app.bearer })).json().active;
  assert.equal(await active(), false);
  assert.equal((await app.write("/api/desktop/software", { action: "check" }, app.bearer)).status, 200);
  assert.equal(await active(), false, "a check is not an operation");
  for (let i = 0; i < 100; i++) {
    const phase = (await app.request("/api/desktop/software", { headers: app.bearer })).json().data.host.phase;
    if (phase === "idle") break;
    await sleep(100);
  }
  const started = await app.write("/api/desktop/software", { action: "upgrade-cli" }, app.bearer);
  assert.equal(started.status, 200, started.text);
  assert.equal(await active(), true);
  await writeFile(path.join(app.fixture.root, release), "");
  for (let i = 0; i < 100 && (await active()); i++) await sleep(100);
  assert.equal(await active(), false);
});

test("SIGTERM lets a request in flight finish, refuses new ones, then exits 0", async (t) => {
  const app = await start(t);
  const body = '{"theme":"dark"}';
  const req = http.request({
    host: "127.0.0.1",
    port: app.port,
    path: "/api/desktop/preferences",
    method: "POST",
    agent: false,
    headers: {
      Host: new URL(app.origin).host,
      ...app.bearer,
      Origin: app.origin,
      "Content-Type": "application/json",
      "Content-Length": String(body.length),
    },
  });
  const answered = new Promise((resolve, reject) => {
    req.once("response", (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
  });
  req.write(body.slice(0, 5));
  await sleep(300);
  app.child.kill("SIGTERM");
  await sleep(300);
  await assert.rejects(
    app.request("/api/session", { headers: app.bearer }),
    "a new connection is refused while it drains",
  );
  req.end(body.slice(5));
  assert.equal(await answered, 200, "the request in flight finished");
  assert.equal(await app.exited, 0);
});

/** A small reverse proxy: calls the server under `internal`, adds the header when asked, leaves Origin alone. */
async function proxy(t, { port, internal, secret }) {
  const listener = http.createServer((req, res) => {
    const headers = { ...req.headers, host: internal };
    if (secret) headers.authorization = `Bearer ${secret}`;
    else delete headers.authorization;
    const upstream = http.request(
      { host: "127.0.0.1", port, path: req.url, method: req.method, headers, agent: false },
      (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      },
    );
    req.pipe(upstream);
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => listener.close());
  return listener.address().port;
}

test("different internal and public hosts: the public origin is what the framework sees", async (t) => {
  // The public origin is the proxy's address as the browser sees it; no name needs to resolve for these requests.
  const origin = "http://public.example:4242";
  const app = await withFreePort((port) =>
    start(t, {
      args: ["--port", String(port), "--origin", origin],
      web: { allowedHosts: ["akm-internal"] },
    }),
  );
  assert.equal(app.origin, origin);
  const throughHeader = await proxy(t, { port: app.port, internal: `akm-internal:${app.port}`, secret: app.secret });
  const throughNothing = await proxy(t, { port: app.port, internal: "akm-internal", secret: undefined });
  const viaHeader = (route, options = {}) => send(throughHeader, route, { ...options });
  const viaNothing = (route, options = {}) => send(throughNothing, route, { ...options });
  // A JSON write under the allowed private name, with the public Origin the browser sends.
  const json = await viaHeader("/api/desktop/preferences", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ theme: "light" }),
  });
  assert.equal(json.status, 200, json.text);
  assert.equal(
    (
      await viaHeader("/api/desktop/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
    "the program sends Origin itself",
  );
  // A form submission: the framework's own origin check runs before the hook, and passes for the public origin.
  const login = await viaNothing("/api/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": FORM },
    body: form({ secret: app.secret }),
  });
  assert.equal(login.status, 303, login.text);
  assert.match(login.headers["set-cookie"][0], /^akm_desktop_session_4242=/);
  const page = await viaHeader("/", { headers: { Accept: "text/html" } });
  assert.equal(page.status, 200);
  // A name nobody listed is refused, and so is the bare bind address.
  for (const host of ["evil.example", `127.0.0.1:${app.port}`, "akm-internal.evil.example"]) {
    const refused = await app.request("/api/session", { host, headers: app.bearer });
    assert.equal(refused.status, 403, host);
    assert.equal(refused.json().code, "HOST_NOT_ALLOWED");
  }
  assert.equal((await app.request("/api/session", { host: "akm-internal", headers: app.bearer })).status, 200);
});

test("an embedding app sets the UI's tokens on #akm-web: in its document, or by message from the frame's parent", {
  timeout: 120000,
}, async (t) => {
  const css = "#akm-web { --accent: #0a7f5a; --font: Georgia, serif; --radius: 0px; --radius-small: 0px; }";
  // The embedding app on another origin: a page that frames the UI at `?src=` and answers the UI's `akmReady` with its overrides.
  const listener = http.createServer((req, res) => {
    const src = new URL(req.url, "http://parent").searchParams.get("src");
    const send = new URL(req.url, "http://parent").searchParams.has("send");
    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end(
        `<!doctype html><iframe id="f" src="${src}" width="1200" height="800"></iframe>` +
          (send
            ? `<script>addEventListener("message", (e) => { if (e.data?.akmReady) e.source.postMessage({ akmCss: ${JSON.stringify(css)} }, "*"); });</script>`
            : ""),
      );
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => listener.close());
  const parent = `http://127.0.0.1:${listener.address().port}`;
  const app = await start(t, { web: { frameParents: [parent] } });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const screenshots = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(app.fixture.root, "screenshots");
  await mkdir(screenshots, { recursive: true });
  const accentOf = (frame) =>
    frame
      .locator("html")
      .evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  /** A new tab on the parent page, framing the UI at `route`; `send` has the parent answer with its overrides. */
  const framed = async (route, send) => {
    const page = await browser.newPage({ viewport: { width: 1240, height: 840 } });
    await page.setExtraHTTPHeaders(app.bearer);
    await page.goto(`${parent}/?${send ? "send&" : ""}src=${encodeURIComponent(`${app.origin}${route}`)}`);
    const frame = page.frameLocator("#f");
    await expect(frame.getByRole("navigation", { name: "Primary navigation" })).toBeVisible({ timeout: 30000 });
    return { page, frame };
  };

  const plain = await framed("/settings/config", false);
  const own = await accentOf(plain.frame);
  assert.notEqual(own, "#0a7f5a");
  await plain.page.screenshot({ path: path.join(screenshots, "theme-framed-without-css.png") });
  // A message from anything but the parent page (here the frame itself) is ignored.
  await plain.frame.locator("html").evaluate((_, akmCss) => window.postMessage({ akmCss }, "*"), css);
  await plain.page.waitForTimeout(200);
  assert.equal(await accentOf(plain.frame), own);

  const themed = await framed("/settings/config", true);
  await expect.poll(() => accentOf(themed.frame)).toBe("#0a7f5a");
  await themed.page.screenshot({ path: path.join(screenshots, "theme-framed-with-css.png") });
  // Client navigation keeps it.
  await themed.frame
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: /^Library(?:\s|$)/ })
    .click();
  await expect.poll(() => themed.page.frames()[1].url()).toMatch(new RegExp(`^${app.origin}/library`));
  assert.equal(await accentOf(themed.frame), "#0a7f5a", "after client navigation");

  // In the UI's own document (a same-origin app or an extension) a plain style does it, and the Theme control still works.
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders(app.bearer);
  await page.goto(`${app.origin}/settings/config`);
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible({ timeout: 30000 });
  await page.addStyleTag({ content: "#akm-web { --accent: light-dark(#0a7f5a, #5fd3a6); }" });
  // The colour the accent resolves to, through a probe that uses it.
  const accent = () =>
    page.evaluate(() => {
      const probe = document.body.appendChild(
        Object.assign(document.createElement("span"), { style: "color: var(--accent)" }),
      );
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
  for (const [scheme, color] of [
    ["light", "rgb(10, 127, 90)"],
    ["dark", "rgb(95, 211, 166)"],
  ]) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), scheme);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), scheme);
    assert.equal(await accent(), color, scheme);
  }
});

test("framing: denied by default; allowed for exactly the configured parents", async (t) => {
  const plain = await start(t);
  const denied = await plain.request("/", { headers: { ...plain.bearer, Accept: "text/html" } });
  assert.match(denied.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(denied.headers["x-frame-options"], "DENY");
  assert.match(cookieOf(await plain.login()) ?? "", /^akm_desktop_session_/);
  assert.match((await plain.login()).headers["set-cookie"][0], /SameSite=Strict/);

  const framed = await start(t, { web: { frameParents: ["http://parent.example:8080", "https://other.example"] } });
  const allowed = await framed.request("/", { headers: { ...framed.bearer, Accept: "text/html" } });
  const csp = allowed.headers["content-security-policy"];
  assert.equal(
    csp.match(/frame-ancestors[^;]*/)[0],
    "frame-ancestors http://parent.example:8080 https://other.example",
  );
  assert.doesNotMatch(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src[^;]*'nonce-/, "the rest of the policy is Kit's");
  // Framing changes only `frame-ancestors`; style sheets stay the UI's own.
  const policy = (value) => value.replace(/'nonce-[^']+'/g, "'nonce'");
  const unframed = policy(denied.headers["content-security-policy"]);
  assert.equal(csp.match(/style-src[^;]*/)[0], "style-src 'self' 'unsafe-inline'");
  assert.equal(
    policy(csp),
    unframed.replace(/frame-ancestors[^;]*/, "frame-ancestors http://parent.example:8080 https://other.example"),
  );
  assert.equal(allowed.headers["x-frame-options"], undefined);
  const unlisted = (await framed.request("/", { headers: { Accept: "text/html" } })).headers;
  assert.equal(
    unlisted["content-security-policy"].match(/frame-ancestors[^;]*/)[0],
    "frame-ancestors http://parent.example:8080 https://other.example",
    "the login form too",
  );
  assert.equal(unlisted["x-frame-options"], undefined);
  assert.match(
    (await framed.login()).headers["set-cookie"][0],
    /; HttpOnly; SameSite=Strict$/,
    "over http the cookie stays Strict",
  );

  // An https origin with parents: the cookie a browser needs to keep inside a frame on another site.
  const secure = await withFreePort((port) =>
    start(t, {
      args: ["--port", String(port), "--origin", "https://akm.example:8443"],
      web: { frameParents: ["https://parent.example"] },
    }),
  );
  const cookie = (
    await secure.request("/api/session", {
      host: "akm.example:8443",
      method: "POST",
      headers: { Origin: "https://akm.example:8443", "Content-Type": FORM },
      body: form({ secret: secure.secret }),
    })
  ).headers["set-cookie"][0];
  assert.match(cookie, /; HttpOnly; SameSite=None; Secure; Partitioned$/);
  // An https origin without parents is Strict and Secure.
  const strict = await withFreePort((port) =>
    start(t, { args: ["--port", String(port), "--origin", "https://akm.example:8443"] }),
  );
  const strictCookie = (
    await strict.request("/api/session", {
      host: "akm.example:8443",
      method: "POST",
      headers: { Origin: "https://akm.example:8443", "Content-Type": FORM },
      body: form({ secret: strict.secret }),
    })
  ).headers["set-cookie"][0];
  assert.match(strictCookie, /; HttpOnly; SameSite=Strict; Secure$/);
});

test("a frame shows the login form or follows a login link, for an allowed parent only", {
  timeout: 120000,
}, async (t) => {
  // A page that frames `target()`, on a port of its own (listened first, so the config can name it). The allowed parent's origin is in the server's config.
  const parentOn = async (target) => {
    const listener = http.createServer((_req, res) => {
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(`<!doctype html><iframe id="f" src="${target()}" width="900" height="600"></iframe>`);
    });
    await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
    t.after(() => listener.close());
    return listener.address().port;
  };
  let target;
  const allowed = await parentOn(() => target);
  const other = await parentOn(() => app.origin);
  const app = await start(t, { web: { frameParents: [`http://127.0.0.1:${allowed}`] } });
  target = app.origin;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const ui = (page) => page.frameLocator("#f").getByRole("navigation", { name: "Primary navigation" });

  // The login form inside the frame.
  const typed = await browser.newPage();
  await typed.goto(`http://127.0.0.1:${allowed}/`);
  await typed.frameLocator("#f").getByLabel("Secret").fill(app.secret);
  await typed.frameLocator("#f").getByRole("button", { name: "Log in" }).click();
  await ui(typed).waitFor({ timeout: 30000 });

  // A one-time login link as the frame's address.
  target = (await app.write("/api/session/link", {}, app.bearer)).json().url;
  const linked = await browser.newPage();
  await linked.goto(`http://127.0.0.1:${allowed}/`);
  await ui(linked).waitFor({ timeout: 30000 });

  // A parent nobody listed: the browser refuses to show the server in its frame.
  const refused = await browser.newPage();
  const answer = refused.waitForResponse((response) => response.url().startsWith(app.origin));
  await refused.goto(`http://127.0.0.1:${other}/`);
  const csp = (await answer).headers()["content-security-policy"];
  assert.match(csp, new RegExp(`frame-ancestors http://127\\.0\\.0\\.1:${allowed}(;|$)`), "only the listed parent");
  // The signal that the browser blocked it: the frame's document is its error page, not the server's.
  const inner = () => refused.frames().find((frame) => frame !== refused.mainFrame());
  await expect.poll(() => inner()?.url()).toMatch(/^chrome-error:/);
  assert.equal(await refused.frameLocator("#f").getByLabel("Secret").count(), 0, "no login form in an unlisted parent");
});
