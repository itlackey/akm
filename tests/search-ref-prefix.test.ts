// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * D4 (docs/architecture/specs/0.9.0-decisions.md) — conceptId-prefix browse.
 *
 * Subtree enumeration is spelled in the grammar refs are actually emitted in:
 * `akm search "memories/projecta/"`, not the retired `"memory:projecta/"`.
 * These tests drive the `akm search` command layer (akmSearch) over a real
 * indexed stash and pin:
 *
 *   - `<conceptId prefix>/` returns exactly that subtree (recursive,
 *     `/`-boundary exact — a sibling `projectalpha/` scope must not leak);
 *   - the prefix matches conceptIds, so a ref copied out of search output and
 *     truncated to a prefix enumerates its own subtree (the round-trip that
 *     the retired name-matching grammar broke silently);
 *   - `bundle//` and `bundle//<prefix>/` scope enumeration to one bundle,
 *     replacing the removed `akm bundle items` (D5);
 *   - the retired `<type>:` spelling no longer enumerates, and says so;
 *   - an explicit `--type` flag wins (branch fires only on the untyped path);
 *   - ordinary keyword queries and bare refs (no trailing slash) are unaffected;
 *   - belief / named-source / scope filters and `limit` compose with it;
 *   - a parsed prefix is explicit intent, so the default `session`
 *     type-exclusion does not apply to `sessions/`.
 *
 * Fixture discipline: no fixture puts the token "memory"/"memories" (or any
 * "memor…" prefix) into an indexed field, so the AND/prefix FTS fallback can
 * never accidentally satisfy a `memories/…` query — a hit can only come from
 * the enumeration branch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../src/commands/read/search";
import { saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import type { SourceSearchHit } from "../src/sources/types";
import {
  type Cleanup,
  makeSandboxDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "./_helpers/sandbox";

let stashDir = "";
let cleanup: Cleanup = () => {};

function writeMd(root: string, relPath: string, frontmatter: Record<string, string>, body: string): void {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const fmLines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
  fs.writeFileSync(fullPath, ["---", ...fmLines, "---", "", body, ""].join("\n"), "utf8");
}

async function reindex(): Promise<void> {
  await akmIndex({ stashDir, full: true });
}

/** Run akmSearch with test-friendly defaults and return only the local hits. */
async function search(input: Parameters<typeof akmSearch>[0]): Promise<SourceSearchHit[]> {
  const result = await akmSearch({
    skipLogging: true,
    ...input,
  });
  return result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
}

const PROJECTA_MEMORIES = ["projecta/auth-tip", "projecta/deploy-note", "projecta/nested/db-tip"] as const;
const ALL_MEMORIES = [
  ...PROJECTA_MEMORIES,
  "ProjCase/case-note",
  "projectalpha/stray-note",
  "projectb/other-note",
  "root-note",
].sort();

beforeEach(async () => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  stashDir = stashResult.dir;
  cleanup = stashResult.cleanup;

  writeMd(
    stashDir,
    "memories/root-note.md",
    { description: "Root level tip about shell aliases" },
    "Shell alias tips live at the top level.",
  );
  writeMd(
    stashDir,
    "memories/projecta/auth-tip.md",
    { description: "OAuth token refresh gotcha for the auth service" },
    "Refresh tokens rotate; re-read the keychain after rotation.",
  );
  writeMd(
    stashDir,
    "memories/projecta/deploy-note.md",
    { description: "Deploy pipeline flake workaround" },
    "Retry the flaky smoke stage once before failing the release.",
  );
  writeMd(
    stashDir,
    "memories/projecta/nested/db-tip.md",
    { description: "Postgres pool sizing hint" },
    "Keep the pool under twenty connections in staging.",
  );
  // Sibling scope sharing "projecta" as a STRING prefix — pins the `/`
  // boundary: `memories/projecta/` must not leak `projectalpha/…`.
  writeMd(
    stashDir,
    "memories/projectalpha/stray-note.md",
    { description: "Stray alpha observation" },
    "The alpha stack still uses the old queue.",
  );
  writeMd(
    stashDir,
    "memories/projectb/other-note.md",
    { description: "Beta stack observation" },
    "The beta stack migrated to the new queue.",
  );
  writeMd(
    stashDir,
    "memories/ProjCase/case-note.md",
    { description: "Mixed case scope observation" },
    "Scope directories can carry mixed case on disk.",
  );
  // Same trailing subpath under a DIFFERENT conceptId root — pins that the
  // prefix is matched against the whole conceptId, so `memories/projecta/`
  // cannot reach `knowledge/projecta/…`.
  writeMd(
    stashDir,
    "knowledge/projecta/setup-guide.md",
    { description: "Build setup guide for the alpha stack" },
    "Install the toolchain, then run the bootstrap script.",
  );
  writeMd(
    stashDir,
    "sessions/claude/fixture-session.md",
    { description: "Recorded harness transcript fixture" },
    "Transcript summary body.",
  );

  saveConfig({ semanticSearchMode: "off" });
  await reindex();
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

describe("akm search conceptId-prefix enumeration (D4)", () => {
  test('"memories/projecta/" enumerates exactly that subtree, recursive', async () => {
    const hits = await search({ query: "memories/projecta/", source: "local" });
    const names = hits.map((h) => h.name).sort();

    expect(names).toEqual([...PROJECTA_MEMORIES].sort());
    // `/`-boundary exactness: the sibling scope sharing the string prefix and
    // the same-subpath knowledge doc must both stay out.
    expect(names).not.toContain("projectalpha/stray-note");
    for (const hit of hits) {
      expect(hit.type).toBe("memory");
      // F4b: search hits now emit the 0.9.0 conceptId spelling.
      expect(hit.ref).toBe(`memories/${hit.name}`);
      // Enumeration is a deterministic listing, not a relevance ranking — hits
      // carry the fixed browse score (same contract as the empty-query path).
      expect(hit.score).toBe(1);
    }
  });

  test('bare "memories/" equals the empty-query --type memory enumeration', async () => {
    const enumHits = await search({ query: "", type: "memory", source: "local" });
    // Fixture sanity (existing behavior): the empty-query typed enumeration
    // sees every memory fixture. If THIS line fails the fixtures are broken,
    // not the feature.
    expect(enumHits.map((h) => h.name).sort()).toEqual(ALL_MEMORIES);

    const prefixHits = await search({ query: "memories/", source: "local" });
    expect(prefixHits.map((h) => h.name).sort()).toEqual(ALL_MEMORIES);
  });

  test("limit caps ref-prefix enumeration", async () => {
    const hits = await search({ query: "memories/projecta/", source: "local", limit: 2 });
    expect(hits).toHaveLength(2);
    for (const hit of hits) {
      expect(hit.name.startsWith("projecta/")).toBe(true);
    }
  });

  test("an explicit --type wins over a conceptId-prefix query", async () => {
    // Discriminating fixtures: if the branch fired with the PARSED type the
    // three projecta memories would come back. The specified behavior — the
    // branch fires only on the untyped path — leaves an ordinary keyword
    // query ("memories projecta") against knowledge entries, which ranks the
    // one knowledge entry carrying "projecta" with a fused score, not the
    // browse score 1.
    const hits = await search({ query: "memories/projecta/", type: "knowledge", source: "local" });
    expect(hits.map((h) => h.name)).toEqual(["projecta/setup-guide"]);
    expect(hits[0]?.score).toBeLessThan(1);
  });

  test("ordinary keyword queries are unaffected", async () => {
    const hits = await search({ query: "oauth", source: "local" });
    const names = hits.map((h) => h.name);
    expect(names).toContain("projecta/auth-tip");
    expect(names).not.toContain("projecta/deploy-note");
  });

  test("a bare ref without the trailing slash does NOT enumerate the subtree", async () => {
    // `memories/projecta/auth-tip` is `akm show` territory — it stays an
    // ordinary keyword search, ranked by relevance rather than listed: the
    // named asset leads and every hit carries a fused score, not the browse
    // score 1.
    const hits = await search({ query: "memories/projecta/auth-tip", source: "local" });
    expect(hits[0]?.name).toBe("projecta/auth-tip");
    expect(hits.every((h) => (h.score ?? 1) < 1)).toBe(true);
  });

  test("mixed-case scope dirs enumerate through the command layer", async () => {
    // The subtree match compares case-insensitively, so it is not defeated by
    // on-disk mixed case — this is the exact spelling an agent copies out of
    // a ref like `memories/ProjCase/case-note`.
    const hits = await search({ query: "memories/ProjCase/", source: "local" });
    expect(hits.map((h) => h.name)).toEqual(["ProjCase/case-note"]);
  });

  test("belief filter composes with ref-prefix enumeration", async () => {
    writeMd(
      stashDir,
      "memories/projecta/deploy-note.md",
      { description: "Deploy pipeline flake workaround", beliefState: "superseded" },
      "Retry the flaky smoke stage once before failing the release.",
    );
    await reindex();

    // Fixture sanity (existing behavior): the empty-query enumerate path
    // already honors the belief filter, proving the frontmatter was captured.
    const sanity = await search({ query: "", type: "memory", belief: "current", source: "local" });
    expect(sanity.map((h) => h.name)).not.toContain("projecta/deploy-note");

    const current = await search({ query: "memories/projecta/", belief: "current", source: "local" });
    expect(current.map((h) => h.name).sort()).toEqual(["projecta/auth-tip", "projecta/nested/db-tip"]);

    const historical = await search({ query: "memories/projecta/", belief: "historical", source: "local" });
    expect(historical.map((h) => h.name)).toEqual(["projecta/deploy-note"]);
  });

  test("named --from filter composes with ref-prefix enumeration", async () => {
    const extra = makeSandboxDir("akm-ref-prefix-extra");
    try {
      writeMd(
        extra.dir,
        "memories/projecta/extra-note.md",
        { description: "Companion observation from the extra stash" },
        "Extra stash body.",
      );
      saveConfig({
        semanticSearchMode: "off",
        bundles: { extra: { path: extra.dir } },
      });
      await reindex();

      // Fixture sanity (existing behavior): the extra source is indexed and
      // the named-source filter narrows the empty-query enumeration to it.
      const sanity = await search({ query: "", type: "memory", source: "extra" });
      expect(sanity.map((h) => h.name)).toEqual(["projecta/extra-note"]);

      // Ref-prefix enumeration must honor the same narrowing…
      const narrowed = await search({ query: "memories/projecta/", source: "extra" });
      expect(narrowed.map((h) => h.name)).toEqual(["projecta/extra-note"]);

      // …while the unnarrowed search spans both sources.
      const all = await search({ query: "memories/projecta/", source: "local" });
      const allNames = all.map((h) => h.name);
      expect(allNames).toContain("projecta/auth-tip");
      expect(allNames).toContain("projecta/extra-note");
    } finally {
      extra.cleanup();
    }
  });

  test("scope --filter composes with ref-prefix enumeration", async () => {
    writeMd(
      stashDir,
      "memories/projecta/alice-context.md",
      { description: "Alice-scoped deployment context", scope_user: "alice" },
      "Alice-only deployment context body.",
    );
    writeMd(
      stashDir,
      "memories/projecta/bob-context.md",
      { description: "Bob-scoped deployment context", scope_user: "bob" },
      "Bob-only deployment context body.",
    );
    await reindex();

    // Fixture sanity (existing behavior): the empty-query enumerate path
    // already honors the scope filter, proving the frontmatter was captured
    // (scope-less fixtures are excluded once any filter key is supplied).
    const sanity = await search({ query: "", type: "memory", filters: { user: "alice" }, source: "local" });
    expect(sanity.map((h) => h.name)).toEqual(["projecta/alice-context"]);

    // The ref-prefix branch must pass the same `filters` through its
    // enumerateEntries call site — a regression that special-cases that one
    // invocation (dropping the filters field) would return every projecta/
    // entry here instead of just the alice-scoped one.
    const hits = await search({ query: "memories/projecta/", filters: { user: "alice" }, source: "local" });
    expect(hits.map((h) => h.name)).toEqual(["projecta/alice-context"]);
  });

  test("proposed-quality exclusion composes with ref-prefix enumeration", async () => {
    writeMd(
      stashDir,
      "memories/projecta/draft-note.md",
      { description: "Draft observation awaiting curation", quality: "proposed" },
      "Draft body awaiting curation.",
    );
    await reindex();

    // Fixture sanity (existing behavior): the empty-query enumerate path
    // already hides `quality: proposed` by default, proving the frontmatter
    // was captured.
    const sanity = await search({ query: "", type: "memory", source: "local" });
    expect(sanity.map((h) => h.name)).not.toContain("projecta/draft-note");

    // Default-off on the ref-prefix branch too…
    const defaults = await search({ query: "memories/projecta/", source: "local" });
    expect(defaults.map((h) => h.name).sort()).toEqual([...PROJECTA_MEMORIES].sort());

    // …and `--include-proposed` restores it through the same branch.
    const opted = await search({ query: "memories/projecta/", source: "local", includeProposed: true });
    expect(opted.map((h) => h.name).sort()).toEqual([...PROJECTA_MEMORIES, "projecta/draft-note"].sort());
  });

  test('"sessions/" enumeration bypasses the default session exclusion', async () => {
    // Fixture sanity (existing behavior): --type session already bypasses the
    // default exclusion, so the fixture is reachable via typed enumeration.
    const sanity = await search({ query: "", type: "session", source: "local" });
    expect(sanity.map((h) => h.name)).toEqual(["claude/fixture-session"]);

    // The parsed type is explicit intent, exactly like --type session — the
    // untyped-path defaultExcludeTypes policy must not hide the result.
    const hits = await search({ query: "sessions/", source: "local" });
    expect(hits.map((h) => h.name)).toEqual(["claude/fixture-session"]);
  });

  test("an empty subtree returns no hits with the standard tip", async () => {
    const result = await akmSearch({
      query: "memories/doesnotexist/",
      source: "local",
      skipLogging: true,
    });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");
    expect(hits).toHaveLength(0);
    expect(result.tip ?? "").toContain("No matching stash assets");
  });

  // The defect D4 exists to fix: the retired grammar matched `namePrefix`
  // against entry NAMES while every emitted ref is a conceptId, so taking a
  // ref out of search output and pasting a prefix of it back in silently
  // degraded to a keyword search. Nothing here hardcodes a spelling — the
  // prefix is derived from what the previous search actually printed.
  test("a ref emitted by search round-trips back in as a prefix query", async () => {
    const seed = await search({ query: "oauth", source: "local" });
    const ref = seed[0]?.ref ?? "";
    expect(ref).toBe("memories/projecta/auth-tip");

    const prefix = ref.slice(0, ref.lastIndexOf("/") + 1);
    expect(prefix).toBe("memories/projecta/");

    const hits = await search({ query: prefix, source: "local" });
    expect(hits.map((h) => h.name).sort()).toEqual([...PROJECTA_MEMORIES].sort());
  });

  // Enumeration is prefix-matching over conceptIds, so it is not bound to the
  // `akm` adapter's placement types — any conceptId root browses the same way.
  test("a non-memory conceptId root enumerates through the same branch", async () => {
    const hits = await search({ query: "knowledge/projecta/", source: "local" });
    expect(hits.map((h) => h.ref)).toEqual(["knowledge/projecta/setup-guide"]);
    expect(hits[0]?.score).toBe(1);
  });

  test("the retired `<type>:` spelling no longer enumerates", async () => {
    const result = await akmSearch({
      query: "memory:projecta/",
      source: "local",
      skipLogging: true,
    });
    const hits = result.hits.filter((h): h is SourceSearchHit => h.type !== "registry");

    // No fixture carries a "memor…" token in an indexed field, so the retired
    // spelling can only come back empty.
    expect(hits).toHaveLength(0);
  });
});

describe("akm search bundle-qualified enumeration (D4)", () => {
  beforeEach(async () => {
    saveConfig({
      semanticSearchMode: "off",
      bundles: { main: { path: stashDir } },
      defaultBundle: "main",
    });
    await reindex();
  });

  test('"main//" enumerates every item in the bundle, across conceptId roots', async () => {
    const hits = await search({ query: "main//", source: "local" });
    const refs = hits.map((h) => h.ref).sort();

    expect(refs).toContain("memories/root-note");
    expect(refs).toContain("knowledge/projecta/setup-guide");
    // A bundle-wide browse is explicit intent, so the default `session`
    // type-exclusion does not hide the session fixture.
    expect(refs).toContain("sessions/claude/fixture-session");
    for (const hit of hits) expect(hit.score).toBe(1);
  });

  test('"main//memories/projecta/" narrows to one subtree of one bundle', async () => {
    const hits = await search({ query: "main//memories/projecta/", source: "local" });
    expect(hits.map((h) => h.name).sort()).toEqual([...PROJECTA_MEMORIES].sort());
  });

  test("an unknown bundle enumerates nothing rather than falling back to keywords", async () => {
    const hits = await search({ query: "nosuchbundle//memories/", source: "local" });
    expect(hits).toHaveLength(0);
  });
});
