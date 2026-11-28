// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The server's secret handling and Host checks that web-access.test.mjs does not cover: a configured secret reference
// leaves no copy in the environment, a refused Host can be diagnosed, and `allowedHosts` entries are validated and
// compared with the origin's default port in mind.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFixture } from "../scripts/fixture.mjs";
import { startServer } from "../server/server.mjs";
import { withFreePort } from "./support.mjs";

const appRoot = process.env.AKM_DESKTOP_TEST_APP_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const server = path.join(appRoot, "server/server.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the server on plain Node with `web` as `experimental.web`, and `env` on top of the fixture's. */
const start = (t, options) => withFreePort((port) => launch(t, port, options));

async function launch(t, port, { web, env = {} }) {
  const fixture = await createFixture({ packageRoot: appRoot, index: false });
  t.after(() => fixture.cleanup());
  const file = path.join(fixture.root, "config/config.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  config.experimental = { ...config.experimental, web: { ...web, port } };
  await writeFile(file, JSON.stringify(config));
  const bin = path.join(fixture.root, "fake-bin");
  await mkdir(bin);
  const dump = path.join(fixture.root, "child-env");
  await writeFile(path.join(bin, "akm"), `#!/bin/sh\nenv > "${dump}"\necho 0.10.0\n`);
  await chmod(path.join(bin, "akm"), 0o755);
  const child = spawn(process.execPath, [server], {
    env: { ...fixture.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    child.kill("SIGTERM");
    await exited;
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ready line.\n${output}`)), 60_000);
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
  return { ready, output: () => output, dump, send: (route, options) => send(port, route, options) };
}

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
        res.once("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}

test("a configured secret reference leaves no copy of the secret in the environment", async (t) => {
  const secret = randomBytes(32).toString("hex");
  const app = await start(t, { web: { secret: "$AKM_HARDENING_OTHER" }, env: { AKM_HARDENING_OTHER: secret } });
  const headers = { Authorization: `Bearer ${secret}` };
  const config = await app.send("/api/config", { headers });
  assert.equal(config.status, 200);
  assert.ok(!config.text.includes(secret));
  assert.equal(
    JSON.parse(config.text).data.env.find((item) => item.name === "AKM_HARDENING_OTHER"),
    undefined,
    "the variable is gone from the server environment",
  );
  // A host tool is a child of the server: it must not see the secret under any name.
  const started = await app.send("/api/desktop/software", {
    method: "POST",
    headers: { ...headers, Origin: app.ready.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "check" }),
  });
  assert.equal(started.status, 200, started.text);
  let seen;
  for (let i = 0; i < 100 && seen === undefined; i++) {
    seen = await readFile(app.dump, "utf8").catch(() => undefined);
    if (seen === undefined) await sleep(50);
  }
  assert.ok(seen, "the host tool ran");
  assert.ok(!seen.includes(secret), "the child's environment has the secret under no name");
  assert.doesNotMatch(seen, /AKM_HARDENING_OTHER|AKM_WEB_SECRET/);
});

test("a refused Host is named in the answer and once on stderr; an http origin accepts its default port", async (t) => {
  const app = await start(t, {
    web: { origin: "http://akm.test", allowedHosts: ["akm-internal:8080"] },
    env: { AKM_WEB_SECRET: "s".repeat(32) },
  });
  const refused = await app.send("/api/session", { host: "evil.example:81" });
  assert.equal(refused.status, 403);
  assert.equal(JSON.parse(refused.text).code, "HOST_NOT_ALLOWED");
  assert.match(JSON.parse(refused.text).error, /evil\.example:81/);
  await app.send("/api/session", { host: "evil.example:81", headers: { Cookie: "secret=x" } });
  await sleep(100);
  const lines = app
    .output()
    .split("\n")
    .filter((line) => line.includes("evil.example:81"));
  assert.equal(lines.length, 1, app.output());
  assert.match(lines[0], /akm\.test/);
  assert.match(lines[0], /akm-internal:8080/);
  assert.doesNotMatch(app.output(), /Cookie|secret=x/);
  const not403 = async (host) => assert.notEqual((await app.send("/api/session", { host })).status, 403, host);
  await not403("akm.test");
  await not403("akm.test:80");
  await not403("akm-internal:8080");
  for (const host of ["akm-internal", "akm-internal:9", "akm.test:81"])
    assert.equal((await app.send("/api/session", { host })).status, 403, host);
});

test("an https origin accepts its default port, and an entry without a port accepts any port", async (t) => {
  const app = await start(t, {
    web: { origin: "https://akm.test", allowedHosts: ["akm-internal"] },
    env: { AKM_WEB_SECRET: "s".repeat(32) },
  });
  for (const host of ["akm.test", "akm.test:443", "akm-internal", "akm-internal:8080", "akm-internal:443"])
    assert.notEqual((await app.send("/api/session", { host })).status, 403, host);
  assert.equal((await app.send("/api/session", { host: "akm.test:80" })).status, 403);
});

test("allowedHosts entries are validated at startup", async () => {
  for (const entry of ["http://akm-internal", "akm-internal/path", "akm-internal:99999", "*.internal", "a b"]) {
    await assert.rejects(
      startServer({ secret: "s".repeat(32), allowedHosts: [entry] }),
      /allowedHosts entry .* must be a host name or address with an optional port/,
      entry,
    );
  }
});
