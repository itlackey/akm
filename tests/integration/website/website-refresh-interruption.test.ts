// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Issue #759 (3/3) — website snapshot refresh interrupted mid-write.
 *
 * A refresh replaces the source's whole stash directory. It used to do that in
 * place: `fs.rmSync(stashDir, …)` and then write the new pages one at a time,
 * with no staging directory and no atomic rename. A process killed anywhere in
 * that loop left the mirror empty or holding an arbitrary SUBSET of the new
 * pages, with the previous snapshot already destroyed — and because the
 * freshness marker is only rewritten on success, the marker still existed, so
 * the next non-forced `sync()` could serve the wreckage instead of rebuilding
 * it.
 *
 * `scrapeWebsiteToStash` / `writeSnapshotToStash` now build into a sibling
 * staging directory and swap it in with renames. These tests interrupt a
 * refresh partway through the page-write loop (via the
 * `_setWebsiteSnapshotWriteHookForTests` seam, which is how a `kill -9` is
 * simulated inside one synchronous burst) and pin both halves of the
 * guarantee: the interrupted run leaves the previous COMPLETE snapshot in
 * place, and the next run swaps in the new one with nothing from either the
 * old snapshot or the aborted attempt mixed in.
 */

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { SourceConfigEntry } from "../../../src/core/config/config";
import {
  _setWebsiteSnapshotWriteHookForTests,
  ensureWebsiteMirror,
  getWebsiteCachePaths,
  type WebsiteSnapshotWriteEvent,
} from "../../../src/sources/snapshot-fetchers/website-ingest";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";
import { withSeam } from "../../_helpers/seams";

// ── Fixture server ───────────────────────────────────────────────────────────

const servers: Array<{ stop: (force: boolean) => void }> = [];
let storage: IsolatedAkmStorage | undefined;

/**
 * A loopback site whose page set can be swapped between refreshes, so a
 * "leftover from the previous generation" is observable as a file that must
 * NOT survive the next run.
 */
function startMutableSite(initial: Record<string, string>): {
  url: string;
  setPages: (p: Record<string, string>) => void;
} {
  let pages = initial;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/robots.txt") return new Response("not found", { status: 404 });
      const body = pages[url.pathname];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}`,
    setPages: (next) => {
      pages = next;
    },
  };
}

function websiteEntry(url: string): SourceConfigEntry {
  return { type: "website", url, options: { maxPages: 20, maxDepth: 2 } } as SourceConfigEntry;
}

/** Every `.md` file under the mirror's knowledge dir, stash-relative, sorted. */
function snapshotFiles(stashDir: string): string[] {
  const knowledgeDir = path.join(stashDir, "knowledge");
  if (!fs.existsSync(knowledgeDir)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) out.push(path.relative(knowledgeDir, full));
    }
  };
  walk(knowledgeDir);
  return out.sort();
}

/** Sibling entries of the stash dir — staging/retired leftovers show up here. */
function cacheRootEntries(rootDir: string): string[] {
  return fs.readdirSync(rootDir).sort();
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  storage?.cleanup();
  storage = undefined;
});

const GENERATION_ONE: Record<string, string> = {
  "/": '<html><body>Home<a href="/alpha">a</a><a href="/bravo">b</a><a href="/charlie">c</a></body></html>',
  "/alpha": "<html><body>Alpha generation one</body></html>",
  "/bravo": "<html><body>Bravo generation one</body></html>",
  "/charlie": "<html><body>Charlie generation one</body></html>",
};

const GENERATION_TWO: Record<string, string> = {
  "/": '<html><body>Home<a href="/alpha">a</a><a href="/delta">d</a></body></html>',
  "/alpha": "<html><body>Alpha generation two</body></html>",
  "/delta": "<html><body>Delta generation two</body></html>",
};

test("an interrupted refresh keeps the previous snapshot whole and is recovered by the next run", async () => {
  storage = withIsolatedAkmStorage();
  const site = startMutableSite(GENERATION_ONE);
  const entry = websiteEntry(site.url);

  // Generation 1: a complete four-page mirror.
  const cachePaths = await ensureWebsiteMirror(entry, { allowPrivateHosts: true, requireStashDir: true });
  const generationOneFiles = snapshotFiles(cachePaths.stashDir);
  expect(generationOneFiles.length).toBe(4);
  const manifestBefore = fs.readFileSync(cachePaths.manifestPath, "utf8");

  // Generation 2 has a DIFFERENT page set: /bravo and /charlie are gone.
  site.setPages(GENERATION_TWO);

  // Kill the refresh in the middle of its page-write loop.
  const events: WebsiteSnapshotWriteEvent[] = [];
  const stashDuringWrite: string[][] = [];
  // The forced refresh reports its failure: no window masks it as a success.
  await expect(
    withSeam(
      _setWebsiteSnapshotWriteHookForTests,
      (event: WebsiteSnapshotWriteEvent) => {
        events.push(event);
        stashDuringWrite.push(snapshotFiles(cachePaths.stashDir));
        if (event.index === 2) throw new Error("simulated kill -9 mid-refresh");
      },
      () => ensureWebsiteMirror(entry, { allowPrivateHosts: true, requireStashDir: true, force: true }),
    ),
  ).rejects.toThrow("simulated kill -9 mid-refresh");

  // The interruption really landed MID-loop: at least one page of generation 2
  // had already been written to disk when the process "died", and there was
  // more still to write.
  expect(events.map((e) => e.index)).toEqual([1, 2]);
  expect(events[0]?.total).toBeGreaterThan(2);

  // …and while those writes were happening, the live mirror still showed the
  // complete previous generation. This is the property the in-place refresh
  // could not offer: it had already deleted the whole directory by this point.
  for (const observed of stashDuringWrite) expect(observed).toEqual(generationOneFiles);

  // After the interrupted run: previous snapshot intact, nothing partial, and
  // no abandoned staging directory left in the cache root.
  expect(snapshotFiles(cachePaths.stashDir)).toEqual(generationOneFiles);
  expect(cacheRootEntries(cachePaths.rootDir)).toEqual(["manifest.json", "stash"]);
  // The freshness marker was NOT advanced by the failed refresh.
  expect(fs.readFileSync(cachePaths.manifestPath, "utf8")).toBe(manifestBefore);

  // The next run recovers: exactly generation 2, with no leftovers from either
  // the old snapshot or the aborted attempt mixed in.
  await ensureWebsiteMirror(entry, { allowPrivateHosts: true, requireStashDir: true, force: true });
  const generationTwoFiles = snapshotFiles(cachePaths.stashDir);
  expect(generationTwoFiles.length).toBe(3);
  expect(generationTwoFiles).not.toEqual(generationOneFiles);
  // Not one byte of generation 1 survives — a path reused by both generations
  // (the index page, `/alpha`) carries the NEW content, not stale bytes.
  for (const file of generationTwoFiles) {
    const body = fs.readFileSync(path.join(cachePaths.stashDir, "knowledge", file), "utf8");
    expect(body).not.toContain("generation one");
    expect(body).not.toContain("/bravo");
    expect(body).not.toContain("/charlie");
  }
  expect(generationTwoFiles.some((f) => f.includes("bravo"))).toBe(false);
  expect(generationTwoFiles.some((f) => f.includes("charlie"))).toBe(false);
  expect(generationTwoFiles.some((f) => f.includes("delta"))).toBe(true);
  expect(cacheRootEntries(cachePaths.rootDir)).toEqual(["manifest.json", "stash"]);
  expect(fs.readFileSync(cachePaths.manifestPath, "utf8")).not.toBe(manifestBefore);
});

test("a plain (non-forced) run after an interruption never serves a partial mirror", async () => {
  // The freshness marker is only rewritten on success, so after an interrupted
  // FORCED refresh the marker still exists and a plain `sync()` skips the
  // refresh entirely. With the in-place write that meant serving whatever
  // subset of pages happened to have landed; with staging the skipped refresh
  // serves the previous COMPLETE snapshot instead.
  storage = withIsolatedAkmStorage();
  const site = startMutableSite(GENERATION_ONE);
  const entry = websiteEntry(site.url);

  const cachePaths = await ensureWebsiteMirror(entry, { allowPrivateHosts: true, requireStashDir: true });
  const generationOneFiles = snapshotFiles(cachePaths.stashDir);
  expect(generationOneFiles.length).toBe(4);

  site.setPages(GENERATION_TWO);
  await expect(
    withSeam(
      _setWebsiteSnapshotWriteHookForTests,
      (event: WebsiteSnapshotWriteEvent) => {
        if (event.index === 1) throw new Error("simulated kill -9 mid-refresh");
      },
      () => ensureWebsiteMirror(entry, { allowPrivateHosts: true, requireStashDir: true, force: true }),
    ),
  ).rejects.toThrow("simulated kill -9 mid-refresh");

  await ensureWebsiteMirror(entry, { allowPrivateHosts: true, requireStashDir: true });

  expect(snapshotFiles(cachePaths.stashDir)).toEqual(generationOneFiles);
  expect(cacheRootEntries(cachePaths.rootDir)).toEqual(["manifest.json", "stash"]);
});

test("a staging directory abandoned by a hard kill is swept by the next refresh", async () => {
  // The `finally` that discards a staging directory cannot run when the process
  // is killed outright, so the next refresh must sweep it. Construct that
  // mid-state directly rather than pretending a JS throw is a SIGKILL.
  storage = withIsolatedAkmStorage();
  const site = startMutableSite(GENERATION_ONE);
  const entry = websiteEntry(site.url);

  const cachePaths = await ensureWebsiteMirror(entry, { allowPrivateHosts: true, requireStashDir: true });
  const generationOneFiles = snapshotFiles(cachePaths.stashDir);

  const orphanName = ".stash.staging-999999-deadbeef";
  const orphan = path.join(cachePaths.rootDir, orphanName);
  fs.mkdirSync(path.join(orphan, "knowledge"), { recursive: true });
  fs.writeFileSync(path.join(orphan, "knowledge", "half-written.md"), "abandoned\n", "utf8");
  // The sweep is age-gated so it can never delete a sibling refresh that is
  // still running; backdate this one past the gate to make it "abandoned".
  const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  fs.utimesSync(orphan, longAgo, longAgo);
  expect(cacheRootEntries(cachePaths.rootDir)).toContain(orphanName);

  site.setPages(GENERATION_TWO);
  await ensureWebsiteMirror(entry, { allowPrivateHosts: true, requireStashDir: true, force: true });

  expect(cacheRootEntries(cachePaths.rootDir)).toEqual(["manifest.json", "stash"]);
  const after = snapshotFiles(cachePaths.stashDir);
  expect(after).not.toEqual(generationOneFiles);
  expect(after.some((f) => f.includes("half-written"))).toBe(false);
});

test("a staging directory from a concurrent in-flight refresh is left alone", async () => {
  // Nothing serializes refreshes of the same source, so an un-gated sweep would
  // delete a sibling process's live staging directory and break a healthy run.
  storage = withIsolatedAkmStorage();
  const site = startMutableSite(GENERATION_ONE);
  const entry = websiteEntry(site.url);

  const cachePaths = await ensureWebsiteMirror(entry, { allowPrivateHosts: true, requireStashDir: true });

  const inFlightName = ".stash.staging-424242-c0ffee";
  const inFlight = path.join(cachePaths.rootDir, inFlightName);
  fs.mkdirSync(path.join(inFlight, "knowledge"), { recursive: true });

  site.setPages(GENERATION_TWO);
  await ensureWebsiteMirror(entry, { allowPrivateHosts: true, requireStashDir: true, force: true });

  expect(cacheRootEntries(cachePaths.rootDir)).toContain(inFlightName);
  // …and it is invisible to the indexer regardless: dot-prefixed directories
  // are skipped by the stash walk.
  expect(inFlightName.startsWith(".")).toBe(true);
});
