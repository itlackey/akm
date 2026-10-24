// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Convention facts do not crowd out real domain assets on a domain-term query,
 * and the fact `category:` frontmatter key round-trips through the index
 * (document_json).
 *
 * Fixture: a sandbox stash containing the FULL shipped stash-skeleton
 * convention facts (src/assets/stash-skeleton/facts — every file carries
 * `category: convention`) plus one real domain asset at knowledge/auth/.
 *
 * For the untyped query "auth", the real knowledge/auth asset must outrank
 * every category:convention fact. When the stash has no real auth asset, the
 * facts are all there is and must still be returned. No LLM, no embeddings
 * (semanticSearchMode "off") — lexical ranking only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import type { IndexDocument } from "../../src/indexer/passes/metadata";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { getAllEntries } from "../../src/storage/repositories/index-entries-repository";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
  withEnv,
} from "../_helpers/sandbox";

/** The shipped skeleton convention facts — the exact files `akm init` installs. */
const SKELETON_FACTS_DIR = path.join(import.meta.dir, "..", "..", "src", "assets", "stash-skeleton", "facts");

const KNOWLEDGE_REF = "knowledge/auth/oauth-refresh-races";

let stashDir = "";
let envCleanup: Cleanup = () => {};

interface Hit {
  type: string;
  name: string;
  ref: string;
  score?: number;
}

/** Read the optional `category` frontmatter field through a typed accessor. */
function entryCategory(entry: IndexDocument): string | undefined {
  return (entry as IndexDocument & { category?: string }).category;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function listMarkdownFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFilesRecursive(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * Copy the full shipped skeleton convention facts into the sandbox stash and
 * return the copied .md file paths. Also verifies the fixture premise: every
 * skeleton fact carries `category: convention` frontmatter (the boundary the
 * init tests pin), so "every fact hit in this stash" ≡ "every
 * category:convention fact".
 */
function installSkeletonConventionFacts(stash: string): string[] {
  fs.cpSync(SKELETON_FACTS_DIR, path.join(stash, "facts"), { recursive: true });
  const copied = listMarkdownFilesRecursive(path.join(stash, "facts"));
  expect(copied.length).toBeGreaterThanOrEqual(12);
  for (const file of copied) {
    const content = fs.readFileSync(file, "utf8");
    expect(content).toMatch(/^category:\s*convention\s*$/m);
  }
  return copied;
}

/** Build the fixture: skeleton convention facts + one real knowledge/auth asset, indexed. */
async function buildFixture(): Promise<void> {
  installSkeletonConventionFacts(stashDir);
  writeFile(
    path.join(stashDir, "knowledge", "auth", "oauth-refresh-races.md"),
    [
      "---",
      "description: OAuth refresh-token rotation race — concurrent workers refreshing the same token cause intermittent 401s; serialize the refresh",
      "tags:",
      "  - auth",
      "  - oauth",
      "---",
      "",
      "# OAuth refresh-token races",
      "",
      "Two workers holding the same refresh token race on rotation: the loser",
      "presents an already-rotated token and the provider revokes the grant.",
      "Serialize refresh through a single flight lock per token.",
      "",
    ].join("\n"),
  );
  saveConfig({ semanticSearchMode: "off" });
  await akmIndex({ stashDir, full: true });
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return withEnv({ AKM_BUNDLE_DIR: stashDir }, async () => {
    resetConfigCache();
    return runCliCapture(args);
  });
}

async function searchHits(args: string[]): Promise<Hit[]> {
  const res = await runCli(args);
  expect(res.code).toBe(0);
  return (JSON.parse(res.stdout).hits as Hit[]) ?? [];
}

beforeEach(() => {
  const cacheResult = sandboxXdgCacheHome();
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
  const stateResult = sandboxXdgStateHome(dataResult.cleanup);
  const stashResult = sandboxStashDir(stateResult.cleanup);
  stashDir = stashResult.dir;
  envCleanup = stashResult.cleanup;
});

afterEach(() => {
  envCleanup();
  envCleanup = () => {};
  stashDir = "";
});

describe("SPEC-6 measurement: convention facts vs a real domain asset on an untyped query", () => {
  test("untyped 'auth' query — the real knowledge/auth asset outranks every category:convention fact", async () => {
    await buildFixture();

    const hits = await searchHits(["search", "auth", "--format=json", "--limit", "25"]);

    // The real domain asset must be found at all…
    const knowledgeIdx = hits.findIndex((h) => h.ref === KNOWLEDGE_REF);
    expect(knowledgeIdx).toBeGreaterThanOrEqual(0);

    // …and must rank ABOVE every convention fact that also matched. Every
    // fact in this fixture is a category:convention skeleton fact (premise
    // asserted in installSkeletonConventionFacts), so any fact hit ranked at
    // or above the knowledge asset is convention-fact crowding.
    const factIndexes = hits.map((h, i) => (h.type === "fact" ? i : -1)).filter((i) => i >= 0);
    for (const factIdx of factIndexes) {
      expect(knowledgeIdx).toBeLessThan(factIdx);
    }
  });

  test("measurement evidence: with NO real auth asset, the untyped 'auth' query falls back to prefix expansion and returns the convention facts", async () => {
    // In a stash where only the skeleton facts match "auth", the facts are all
    // there is: they must stay listed, not be hidden.
    installSkeletonConventionFacts(stashDir);
    saveConfig({ semanticSearchMode: "off" });
    await akmIndex({ stashDir, full: true });

    const hits = await searchHits(["search", "auth", "--format=json", "--limit", "25"]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.type === "fact")).toBe(true);
    expect(hits.some((h) => h.ref.startsWith("facts/conventions/"))).toBe(true);
  });

  test("index captures category: convention onto fact entries (document_json round-trip)", async () => {
    await buildFixture();

    // Read the freshly built index back: every skeleton convention fact must
    // carry its frontmatter `category` on the persisted IndexDocument, which any
    // category-keyed policy needs.
    const db = openExistingDatabase();
    try {
      const facts = getAllEntries(db, "fact");
      expect(facts.length).toBeGreaterThanOrEqual(12);
      for (const fact of facts) {
        expect(entryCategory(fact.entry)).toBe("convention");
      }
    } finally {
      closeDatabase(db);
    }
  });

  test("convention facts stay reachable via typed search (--type fact wins over demotion)", async () => {
    await buildFixture();

    // Typed search is the way to ask for the convention facts: `--type fact`
    // must surface them for the same domain-term query.
    const hits = await searchHits(["search", "auth", "--type", "fact", "--format=json", "--limit", "25"]);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.type).toBe("fact");
    }
    expect(hits.some((h) => h.ref.startsWith("facts/conventions/"))).toBe(true);
  });

  test("exact-name query still surfaces a convention fact in the top 3", async () => {
    await buildFixture();

    // A user who asks for a convention fact by name must find it near the top.
    const hits = await searchHits(["search", "backlinks", "--format=json", "--limit", "25"]);
    const idx = hits.findIndex((h) => h.ref === "facts/conventions/backlinks");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(3);
  });
});
