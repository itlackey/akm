// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * SPEC-6 (docs/design/stash-conventions-code-spec.md) — deterministic
 * MEASUREMENT + regression test for convention-fact crowding of domain-term
 * queries, plus the index-capture (entry_json) round-trip for the fact
 * `category:` frontmatter key.
 *
 * Fixture: a sandbox stash containing the FULL shipped stash-skeleton
 * convention facts (src/assets/stash-skeleton/facts — every file carries
 * `category: convention`) plus one real domain asset at knowledge/auth/.
 *
 * The measurement: for the untyped query "auth", the real knowledge/auth
 * asset must outrank every category:convention fact. If this fails on a tree
 * without the SPEC-6 demotion, crowding is CONFIRMED and this test doubles as
 * the demotion regression test. No LLM, no embeddings (semanticSearchMode
 * "off") — pure FTS + ranking contributors.
 *
 * MEASUREMENT RESULT (2026-07-11, pre-implementation tree): the headline
 * measurement PASSES without any demotion. searchFts is exact-first — the
 * prefix fallback ("auth*" → the facts' "authoring…" tokens) only runs when
 * the exact token query matches NOTHING, and a real knowledge/auth asset
 * always matches "auth" exactly (name + path-derived tag). So convention
 * facts never even co-rank with a real domain asset; they fill the results
 * only when the stash has NO exact match at all (see the companion
 * "facts-only stash" test below). Crowding as hypothesized by the intake item
 * is therefore NOT confirmed. These tests stay as regression pins for that
 * invariant; the capture test (entry.category → entry_json) is the RED
 * groundwork SPEC-6/SPEC-8 need either way.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { resetConfigCache, saveConfig } from "../../src/core/config/config";
import { closeDatabase, getAllEntries, openExistingDatabase } from "../../src/indexer/db/db";
import { akmIndex } from "../../src/indexer/indexer";
import type { StashEntry } from "../../src/indexer/passes/metadata";
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

const KNOWLEDGE_REF = "knowledge:auth/oauth-refresh-races";

let stashDir = "";
let envCleanup: Cleanup = () => {};

interface Hit {
  type: string;
  name: string;
  ref: string;
  score?: number;
}

/**
 * SPEC-6 adds `category?: string` to StashEntry. Read it through a typed
 * accessor so this file compiles before the implementation lands; the capture
 * test then goes red on the runtime value instead of a compile error.
 */
function entryCategory(entry: StashEntry): string | undefined {
  return (entry as StashEntry & { category?: string }).category;
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
  return withEnv({ AKM_STASH_DIR: stashDir }, async () => {
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
    // The one crowding mode the measurement actually found: in a stash where
    // nothing matches the exact token "auth", the prefix fallback surfaces the
    // skeleton facts (via their "authoring…" tokens). Rank-time demotion
    // (SPEC-6's chosen remedy over exclusion) keeps every hit LISTED, so this
    // fail-open behavior must survive any demotion implementation — facts
    // remain reachable when they are all there is.
    installSkeletonConventionFacts(stashDir);
    saveConfig({ semanticSearchMode: "off" });
    await akmIndex({ stashDir, full: true });

    const hits = await searchHits(["search", "auth", "--format=json", "--limit", "25"]);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.type === "fact")).toBe(true);
    expect(hits.some((h) => h.ref.startsWith("fact:conventions/"))).toBe(true);
  });

  test("index captures category: convention onto fact entries (entry_json round-trip)", async () => {
    await buildFixture();

    // Read the freshly built index back: every skeleton convention fact must
    // carry its frontmatter `category` on the persisted StashEntry. This is
    // the SPEC-6 capture prerequisite — without it neither demotion nor any
    // category-keyed policy is implementable.
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

    // Typed search is the sanctioned opt-back-in: `--type fact` must surface
    // the convention facts for the same domain-term query regardless of any
    // untyped-rank demotion. ("auth" prefix-expands to the facts' "authoring"
    // tokens once no exact fact match exists.)
    const hits = await searchHits(["search", "auth", "--type", "fact", "--format=json", "--limit", "25"]);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.type).toBe("fact");
    }
    expect(hits.some((h) => h.ref.startsWith("fact:conventions/"))).toBe(true);
  });

  test("exact-name query still surfaces a convention fact in the top 3", async () => {
    await buildFixture();

    // The demotion must NOT hide convention facts from users who ask for them
    // by name: the exact-name boost (+2.0) dominates the category demotion.
    const hits = await searchHits(["search", "backlinks", "--format=json", "--limit", "25"]);
    const idx = hits.findIndex((h) => h.ref === "fact:conventions/backlinks");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(3);
  });
});
