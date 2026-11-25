// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The UI served under a path (`https://app.example/akm/`) by a proxy that removes the prefix before forwarding
// (issue #1801, "Under a path"). The proxy here records every URL the browser asks it for and answers 404 to anything
// outside `/akm/`, so a link, an asset or an API call that assumes the root of the site shows up as a failure.

import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { chromium, expect } from "@playwright/test";
import { answered, launchFixture } from "./support.mjs";

const PREFIX = "/akm";
const FRAME_HOST = "/frame-host.html"; // a page of the proxy's own origin (the "app"), not part of the UI

const FORM = "application/x-www-form-urlencoded";

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * A prefix-stripping proxy and the server behind it, as a broker serving the UI under `/akm/` would run them. The
 * server's origin is the proxy's, it listens on a port of its own, and the proxy reaches it under another name
 * (`allowedHosts`). `header` makes the proxy add the secret (a broker); without it the browser logs in itself.
 * Every URL the browser asks the proxy for is recorded, and anything outside `/akm/` answers 404, so a link, an asset
 * or an API call that assumes the root of the site shows up as a failure.
 */
async function startProxied(t, { header = true, ...options } = {}) {
  const requests = [];
  let server;
  const proxy = http.createServer((req, res) => {
    const url = req.url ?? "/";
    requests.push({ method: req.method, url });
    if (url === FRAME_HOST) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(
        `<!doctype html><title>app</title><iframe id="akm" src="${PREFIX}/" width="1200" height="800"></iframe>`,
      );
    }
    if (url === PREFIX) {
      res.writeHead(308, { location: `${PREFIX}/` });
      return res.end();
    }
    if (!url.startsWith(`${PREFIX}/`)) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("outside the prefix");
    }
    // The browser's own Origin and cookies pass through; the proxy names the server by its private host.
    const headers = { ...req.headers, host: `127.0.0.1:${serverPort}` };
    if (header) headers.authorization = server.headers.Authorization;
    else delete headers.authorization;
    const upstream = http.request(
      { host: "127.0.0.1", port: serverPort, method: req.method, path: url.slice(PREFIX.length), headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res); // streamed, not buffered
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const serverPort = await freePort();
  server = await launchFixture({
    ...options,
    login: false,
    configureFixture: async (fixture) => {
      await options.configureFixture?.(fixture);
      const file = path.join(fixture.root, "config/config.json");
      const config = JSON.parse(await readFile(file, "utf8"));
      config.experimental = {
        ...config.experimental,
        web: { port: serverPort, origin, allowedHosts: ["127.0.0.1"], frameParents: [origin] },
      };
      await writeFile(file, JSON.stringify(config));
    },
  });
  t.after(() => server.stop());
  t.after(() => new Promise((resolve) => (proxy.closeAllConnections(), proxy.close(resolve))));
  assert.equal(server.origin, origin);
  return {
    server,
    serverPort,
    origin,
    requests,
    at: (route) => `${origin}${PREFIX}${route}`,
    outside: () => requests.filter((r) => r.url !== FRAME_HOST && !r.url.startsWith(`${PREFIX}/`) && r.url !== PREFIX),
  };
}

// The UI has no streamed request (no SSE, no streamed fetch body; `grep` of `desktop/src` finds none), so there is no
// streaming case here; the proxy still pipes every response rather than buffering it.
test("the UI works under a path prefix that the proxy removes", { timeout: 180000 }, async (t) => {
  const proxy = await startProxied(t, { proposals: true });
  const { server } = proxy;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  const at = proxy.at;
  const nav = (name) =>
    page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: new RegExp(`^${name}(?:\\s|$)`) });

  await t.test("opens at /akm/ and loads its assets from under the prefix", async () => {
    await page.goto(at("/"));
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    const assets = proxy.requests.filter((r) => r.url.startsWith(`${PREFIX}/_app/`));
    assert.ok(assets.length > 0, "the page loads scripts from /akm/_app/");
    const failed = await page.evaluate(() =>
      [...document.querySelectorAll("script[src],link[href]")]
        .map((el) => el.getAttribute("src") ?? el.getAttribute("href"))
        .filter((url) => new URL(url, location.href).pathname.indexOf("/akm/") !== 0),
    );
    assert.deepEqual(failed, []);
  });

  await t.test("clicking links moves between pages, each address under the prefix", async () => {
    await nav("Review").click();
    await expect(page).toHaveURL(/\/akm\/review/);
    await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
    await nav("Library").click();
    await expect(page).toHaveURL(/\/akm\/library\//);
    await nav("Activity").click();
    await expect(page).toHaveURL(/\/akm\/activity\//);
    await nav("Settings").click();
    await expect(page).toHaveURL(/\/akm\/settings\//);
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    // The title and the current section come from the address without the prefix.
    await expect(page).toHaveTitle("Bundles & index · Settings · AKM Desktop");
    await expect(nav("Settings")).toHaveAttribute("aria-current", "page");
  });

  await t.test("a redirect stays under the prefix", async () => {
    await page.goto(at("/settings"));
    await expect(page).toHaveURL(at("/settings/bundles"));
    await page.goto(at("/library"));
    await expect(page).toHaveURL(at("/library/search"));
  });

  await t.test("a nested route reloads directly", async () => {
    await page.goto(at("/settings/bundles"));
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page).toHaveURL(at("/settings/bundles"));
  });

  await t.test("an API read, then an edit and save (a write), then the saved text on reload", async () => {
    await page.goto(at(`/library/edit?${new URLSearchParams({ ref: server.refs.document })}`));
    const editor = page.getByRole("textbox", { name: /^Markdown (body|source, including optional frontmatter)$/ });
    const draft = `${await editor.inputValue()}\nEdited through the prefix.\n`;
    await editor.fill(draft);
    await Promise.all([
      answered(page, `${PREFIX}/api/desktop/file/save`),
      page.getByRole("button", { name: "Save changes", exact: true }).click(),
    ]);
    await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
    assert.match(await readFile(server.documentPath, "utf8"), /Edited through the prefix\./);
    await page.reload();
    await expect(page.locator(".document-body, .markdown").first()).toContainText("Edited through the prefix.");
  });

  await t.test(
    "a direct load of any nested route has its root: a link and an API call on each stay under the prefix",
    async () => {
      for (const route of [
        "/settings/connections",
        "/library/files?bundle=personal&path=knowledge",
        "/activity/overview",
      ]) {
        const before = proxy.requests.length;
        await page.goto(at(route));
        await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
        // The shell reads /api/desktop on every load; the link is the brand link, present on every page.
        await expect
          .poll(() => proxy.requests.slice(before).some((r) => r.url.startsWith(`${PREFIX}/api/`)))
          .toBe(true);
        await expect(page.locator("a.brand")).toHaveAttribute("href", `${PREFIX}/`);
        await nav("Review").click();
        await expect(page).toHaveURL(/\/akm\/review/);
      }
    },
  );

  await t.test("a trailing slash is stripped by a redirect that stays under the prefix", async () => {
    await page.goto(at("/settings/bundles/"));
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page).toHaveURL(at("/settings/bundles"));
    await expect(page.locator("a.brand")).toHaveAttribute("href", `${PREFIX}/`);
  });

  await t.test("no request left the prefix, and no page error occurred", () => {
    assert.deepEqual(proxy.outside(), []);
    assert.deepEqual(errors, []);
  });
});

// Framed on a page of the proxy's origin, which `frameParents` names: the response allows exactly that parent.
test("the UI works under a path prefix in a frame, as served", { timeout: 120000 }, async (t) => {
  const proxy = await startProxied(t);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(`${proxy.origin}${FRAME_HOST}`);
  const frame = page.frameLocator("#akm");
  const link = (label) =>
    frame
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: new RegExp(`^${label}(?:\\s|$)`) });
  await expect(link("Review")).toBeVisible();
  await link("Settings").click();
  await expect(frame.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  assert.match(page.frames().at(-1).url(), /\/akm\/settings\//);
  assert.deepEqual(proxy.outside(), []);
});

// A person without the header: the form is served at /akm/ and its post lands back under /akm/ (relative redirects).
test("a person logs in through the proxy under the prefix, by the form and by a login link", {
  timeout: 120000,
}, async (t) => {
  const proxy = await startProxied(t, { header: false });
  const { server } = proxy;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await page.goto(proxy.at("/settings/bundles"));
  await expect(page.getByLabel("Secret")).toBeVisible();
  await page.getByLabel("Secret").fill("x".repeat(40));
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(proxy.at("/api/session"));
  await page.getByLabel("Secret").fill(server.secret);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(nav).toBeVisible();
  await expect(page).toHaveURL(proxy.at("/"));

  // A login link: a program asks the server for it (with the header and the public Origin); the app puts its own
  // prefix in front of the address it gets back, and the person opens that through the proxy.
  const issued = await fetch(`http://127.0.0.1:${proxy.serverPort}/api/session/link`, {
    method: "POST",
    headers: { ...server.headers, Origin: proxy.origin, Host: `127.0.0.1:${proxy.serverPort}` },
  });
  assert.equal(issued.status, 200);
  const { url } = await issued.json();
  assert.match(url, new RegExp(`^${proxy.origin}/\\?login=`));
  const fresh = await browser.newPage();
  await fresh.goto(`${proxy.origin}${PREFIX}/${new URL(url).search}`);
  await expect(fresh.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await expect(fresh).toHaveURL(proxy.at("/"));
  assert.deepEqual(proxy.outside(), []);
});

// A root-absolute address in source ignores the prefix. Links, `goto`, `fetch` and `redirect` take app paths through
// `appHref` (`lib/client.ts`); this fails, naming file and line, if a literal slips past it.
test("no source file uses a root-absolute address without appHref", async () => {
  const files = (await readdir(new URL("../src", import.meta.url), { recursive: true })).filter(
    (name) => /\.(svelte|ts)$/.test(name) && !name.startsWith("lib/server") && name !== "hooks.server.ts",
  );
  const bare = /href="\/(?!\/)|\b(goto|fetch)\(\s*["'`]\/(?!\/)|redirect\(\s*\d+,\s*["'`]\//;
  const found = [];
  for (const name of files)
    (await readFile(new URL(`../src/${name}`, import.meta.url), "utf8")).split("\n").forEach((line, i) => {
      if (bare.test(line)) found.push(`src/${name}:${i + 1}: ${line.trim()}`);
    });
  assert.deepEqual(found, []);
});
