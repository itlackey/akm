// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Integration (network clause: crawls a loopback `Bun.serve` site).
 *
 * A website bundle is crawled when it is added and when `akm bundle update`
 * forces a sync. The index path (`ensureSourceCaches`, a non-forced sync)
 * crawls it only when it has never been materialized on this host; the age of
 * the cached snapshot never triggers a re-crawl.
 */

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig, SourceConfigEntry } from "../../../src/core/config/config";
import { ensureSourceCaches } from "../../../src/indexer/search/search-source";
import { createWebsiteProvider } from "../../../src/sources/providers/website";
import { ensureWebsiteMirror, getWebsiteCachePaths } from "../../../src/sources/snapshot-fetchers/website-ingest";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const servers: Array<{ stop: (force: boolean) => void }> = [];
let storage: IsolatedAkmStorage | undefined;

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  storage?.cleanup();
  storage = undefined;
});

/** A one-page loopback site whose body can change and whose page hits are counted. */
function startSite(initialBody: string): {
  url: string;
  pageHits: () => number;
  resetHits: () => void;
  setBody: (b: string) => void;
} {
  let body = initialBody;
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/robots.txt") return new Response("not found", { status: 404 });
      if (url.pathname !== "/") return new Response("not found", { status: 404 });
      hits += 1;
      return new Response(`<html><body>${body}</body></html>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}`,
    pageHits: () => hits,
    resetHits: () => {
      hits = 0;
    },
    setBody: (next) => {
      body = next;
    },
  };
}

function snapshotText(stashDir: string): string {
  const knowledgeDir = path.join(stashDir, "knowledge");
  if (!fs.existsSync(knowledgeDir)) return "";
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) out.push(fs.readFileSync(full, "utf8"));
    }
  };
  walk(knowledgeDir);
  return out.join("\n");
}

function ageManifest(manifestPath: string): void {
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(manifestPath, longAgo, longAgo);
}

function configFor(url: string): AkmConfig {
  return { semanticSearchMode: "off", bundles: { docs: { website: { url } } } };
}

test("index crawls a website bundle that was never materialized, then never again however old it gets", async () => {
  storage = withIsolatedAkmStorage();
  const site = startSite("generation one");
  const config = configFor(site.url);
  const cachePaths = getWebsiteCachePaths(site.url);

  // Never materialized on this host: the index path crawls it.
  expect(fs.existsSync(cachePaths.manifestPath)).toBe(false);
  await ensureSourceCaches(config);
  expect(site.pageHits()).toBeGreaterThan(0);
  expect(snapshotText(cachePaths.stashDir)).toContain("generation one");

  // Thirty days later the site has changed; the index path leaves the snapshot alone.
  ageManifest(cachePaths.manifestPath);
  site.setBody("generation two");
  site.resetHits();
  await ensureSourceCaches(config);
  expect(site.pageHits()).toBe(0);
  expect(snapshotText(cachePaths.stashDir)).toContain("generation one");
  expect(snapshotText(cachePaths.stashDir)).not.toContain("generation two");
});

test("index crawls again when the materialization is missing or incomplete", async () => {
  storage = withIsolatedAkmStorage();
  const site = startSite("generation one");
  const config = configFor(site.url);
  const cachePaths = getWebsiteCachePaths(site.url);

  await ensureSourceCaches(config);
  expect(site.pageHits()).toBeGreaterThan(0);

  // The manifest survives but the snapshot is gone: not materialized.
  fs.rmSync(cachePaths.stashDir, { recursive: true, force: true });
  site.resetHits();
  await ensureSourceCaches(config);
  expect(site.pageHits()).toBeGreaterThan(0);
  expect(snapshotText(cachePaths.stashDir)).toContain("generation one");

  // The whole cache is gone: not materialized.
  fs.rmSync(cachePaths.rootDir, { recursive: true, force: true });
  site.resetHits();
  await ensureSourceCaches(config);
  expect(site.pageHits()).toBeGreaterThan(0);
  expect(fs.existsSync(cachePaths.manifestPath)).toBe(true);
});

test("a forced sync (the `akm bundle update` path) re-crawls regardless of the snapshot's age", async () => {
  storage = withIsolatedAkmStorage();
  const site = startSite("generation one");
  const entry = { type: "website", name: "docs", url: site.url } as SourceConfigEntry;
  const cachePaths = getWebsiteCachePaths(site.url);
  const provider = createWebsiteProvider(entry);

  await provider.sync({ ensureWebsiteMirror });
  expect(snapshotText(cachePaths.stashDir)).toContain("generation one");

  // A just-materialized snapshot: a plain sync leaves it, a forced one re-crawls.
  site.setBody("generation two");
  await provider.sync({ ensureWebsiteMirror });
  expect(snapshotText(cachePaths.stashDir)).toContain("generation one");
  await provider.sync({ force: true, ensureWebsiteMirror });
  expect(snapshotText(cachePaths.stashDir)).toContain("generation two");

  // An old snapshot is re-crawled by a forced sync as well.
  ageManifest(cachePaths.manifestPath);
  site.setBody("generation three");
  await provider.sync({ force: true, ensureWebsiteMirror });
  expect(snapshotText(cachePaths.stashDir)).toContain("generation three");
});
