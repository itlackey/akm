/**
 * SPEC-7 (stash-conventions-code-spec.md): `akm mv <ref> <new-name>` — rename
 * with inbound-xref rewrite and utility-history preservation.
 *
 * Pins the rename procedure the conventions make agent-executable EXCEPT for
 * the index part only the CLI can do:
 *   - A rename within a type dir moves the file on disk and reports the
 *     JSON shape `{ok, from, to, rewrote, readOnlyCiters}` (from/to are refs;
 *     rewrote is `[{file, count}]`).
 *   - Inbound refs are rewritten across the WRITABLE stash's md files — in
 *     body prose, in frontmatter ref-list keys (xrefs/refs/...), AND inside
 *     fenced code blocks (a rename must not leave stale examples; note lint's
 *     missing-ref scan strips fences, the rewriter must not). Rewrites use
 *     complete-ref boundary matching: a longer ref sharing the old ref as a
 *     prefix is untouched.
 *   - `akm lint` reports zero missing-ref findings afterwards (SPEC-1 synergy:
 *     the "grep and fix inbound xrefs in the same pass" convention rule).
 *   - Read-only sources are scanned but never written: their citing files are
 *     byte-identical afterwards and reported in `readOnlyCiters` as manual
 *     follow-ups.
 *   - Memory renames move the `.derived.md` twin together, and the index
 *     re-key preserves BOTH row ids with the twin `entry_key` staying exactly
 *     `<base entry_key>.derived` (the coupling pinned at db.ts
 *     getBaseBeliefStatesForDerivedTwins).
 *   - The entries row is re-keyed IN PLACE: the row id survives the rename, so
 *     the `utility_scores` row keyed by entry_id (accumulated usage-ranking
 *     history) survives; entry_key/file_path reflect the new name, the old
 *     entry_key is gone, and search immediately reflects the new name (moved
 *     row FTS refresh + rewritten citers reindexed via indexWrittenAssets).
 *   - Bad input fails with the standard `{ok:false,error,code}` envelope and
 *     exit 2, moving nothing: wiki refs (wiki has its own xref+lint system),
 *     cross-type targets, existing targets, unresolvable source refs, and
 *     type-root escapes (`../`).
 *   - A successful mv appends an `mv` event to the state.db events stream; a
 *     failed mv appends none.
 *
 * Uses the in-process CLI harness (tests/_helpers/cli.ts) with the composite
 * isolation fixture (fresh stash + XDG dirs per test, so index.db/state.db
 * assertions are hermetic), following tests/commands/remember-import-*.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint/index";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { readEvents } from "../../src/core/events";
import { getDbPath } from "../../src/core/paths";
import {
  applyFeedbackToUtilityScore,
  closeDatabase,
  getUtilityScore,
  openExistingDatabase,
} from "../../src/indexer/db/db";
import type { Database } from "../../src/storage/database";
import { runCliCapture } from "../_helpers/cli";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];
let storage: IsolatedAkmStorage;
let stashDir = "";

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stashDir = storage.stashDir;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  storage.cleanup();
  stashDir = "";
  for (const d of disposers.splice(0)) d.cleanup();
});

/** Create an isolated dir (auto-cleaned) for extra read-only stashes. */
function makeDir(prefix: string): string {
  const d = makeSandboxDir(prefix);
  disposers.push(d);
  return d.dir;
}

/** Seed an asset file under a stash root (e.g. "memories/projectA/old.md"). */
function seedAsset(root: string, relPath: string, content: string): string {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

/** Every .md file under `root` (relative paths), for whole-stash grep asserts. */
function allMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .filter((p) => p.endsWith(".md"));
}

interface RewroteItem {
  file: string;
  count: number;
}

interface MvOutput {
  ok: boolean;
  from: string;
  to: string;
  rewrote: RewroteItem[];
  readOnlyCiters: RewroteItem[];
  utilityPreserved: boolean;
}

interface ErrorEnvelope {
  ok: boolean;
  error: string;
  code?: string;
}

/** Build the local index by driving a real read (ensureIndex bootstrap). */
async function buildIndex(): Promise<void> {
  const { code } = await runCliCapture(["search", "bootstrap-index-probe"]);
  expect(code).toBe(0);
}

/**
 * Look up an entries row whose entry_key ends with `:type:name`. Normalizes
 * the driver's no-row result to `undefined` (bun:sqlite `get()` returns
 * `null`, better-sqlite3 returns `undefined` — the storage boundary's
 * `Statement.get` is typed `Row | null | undefined`) so absent-row
 * assertions can use `toBeUndefined()` on either driver.
 */
function entryByKeySuffix(
  db: Database,
  suffix: string,
): { id: number; entry_key: string; file_path: string } | undefined {
  return (
    (db.prepare("SELECT id, entry_key, file_path FROM entries WHERE entry_key LIKE ?").get(`%${suffix}`) as
      | { id: number; entry_key: string; file_path: string }
      | null
      | undefined) ?? undefined
  );
}

/** Look up an entries row by its (stable) row id. */
function entryById(db: Database, id: number): { id: number; entry_key: string; file_path: string } | undefined {
  return db.prepare("SELECT id, entry_key, file_path FROM entries WHERE id = ?").get(id) as
    | { id: number; entry_key: string; file_path: string }
    | undefined;
}

// ── rename within a type dir ─────────────────────────────────────────────────

describe("akm mv — rename within a type dir", () => {
  test("moves the file and reports the {ok,from,to,rewrote,readOnlyCiters} shape", async () => {
    const body = "---\ndescription: A note worth renaming\n---\n\nKeep this exact body.\n";
    const oldPath = seedAsset(stashDir, "memories/projectA/old-note.md", body);

    const { code, stdout } = await runCliCapture(["mv", "memory:projectA/old-note", "projectA/new-note"]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as MvOutput;
    expect(json.ok).toBe(true);
    expect(json.from).toBe("memory:projectA/old-note");
    expect(json.to).toBe("memory:projectA/new-note");
    // No citers in this stash: both report lists are present and empty.
    expect(json.rewrote).toEqual([]);
    expect(json.readOnlyCiters).toEqual([]);

    // The file moved byte-for-byte within the type dir.
    expect(fs.existsSync(oldPath)).toBe(false);
    const newPath = path.join(stashDir, "memories/projectA/new-note.md");
    expect(fs.existsSync(newPath)).toBe(true);
    expect(fs.readFileSync(newPath, "utf8")).toBe(body);
  });

  test("accepts a SAME-type ref-shaped target (what makes cross-type rejection expressible)", async () => {
    seedAsset(stashDir, "memories/solo.md", "A standalone note.\n");

    const { code, stdout } = await runCliCapture(["mv", "memory:solo", "memory:renamed-solo"]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as MvOutput;
    expect(json.ok).toBe(true);
    expect(json.to).toBe("memory:renamed-solo");
    expect(fs.existsSync(path.join(stashDir, "memories/solo.md"))).toBe(false);
    expect(fs.existsSync(path.join(stashDir, "memories/renamed-solo.md"))).toBe(true);
  });
});

// ── inbound ref rewrite ──────────────────────────────────────────────────────

describe("akm mv — inbound ref rewrite across the writable stash", () => {
  test("rewrites body refs AND frontmatter ref-list keys; lint reports zero missing-ref afterwards", async () => {
    seedAsset(stashDir, "knowledge/guides/old-guide.md", "# Guide\n\nThe canonical guide content.\n");
    // Citer 1: two body occurrences (prose + inline code span).
    const bodyCiter = seedAsset(
      stashDir,
      "knowledge/citing-doc.md",
      "---\ndescription: Cites the guide twice\n---\n\nSee knowledge:guides/old-guide for details.\nRun `akm show knowledge:guides/old-guide` to read it.\n",
    );
    // Citer 2: frontmatter xrefs list only — the conventions' provenance channel.
    const xrefCiter = seedAsset(
      stashDir,
      "memories/citer-note.md",
      "---\ndescription: Derived from the guide\nxrefs:\n  - knowledge:guides/old-guide\n---\n\nDerived note body (no inline ref).\n",
    );
    // Citer 3: frontmatter refs list (the authoritative refs channel lint scans).
    const refsCiter = seedAsset(
      stashDir,
      "knowledge/refs-citer.md",
      "---\ndescription: Lists the guide in refs\nrefs:\n  - knowledge:guides/old-guide\n---\n\nRefs-list citer body.\n",
    );

    const { code, stdout } = await runCliCapture(["mv", "knowledge:guides/old-guide", "guides/renamed-guide"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;
    expect(json.ok).toBe(true);
    expect(json.to).toBe("knowledge:guides/renamed-guide");

    // Body citer: BOTH occurrences rewritten.
    const bodyAfter = fs.readFileSync(bodyCiter, "utf8");
    expect(bodyAfter).toContain("See knowledge:guides/renamed-guide for details.");
    expect(bodyAfter).toContain("`akm show knowledge:guides/renamed-guide`");
    expect(bodyAfter).not.toContain("old-guide");

    // Frontmatter xrefs citer: the list entry is rewritten, everything else
    // (other keys, body, single frontmatter block) is preserved.
    const xrefRaw = fs.readFileSync(xrefCiter, "utf8");
    const xrefParsed = parseFrontmatter(xrefRaw);
    expect(xrefParsed.data.xrefs).toEqual(["knowledge:guides/renamed-guide"]);
    expect(xrefParsed.data.description).toBe("Derived from the guide");
    expect(xrefParsed.content).toContain("Derived note body (no inline ref).");
    expect(xrefRaw.match(/^---\s*$/gm)?.length).toBe(2);

    // Frontmatter refs citer: ref-list keys beyond xrefs are rewritten too.
    const refsParsed = parseFrontmatter(fs.readFileSync(refsCiter, "utf8"));
    expect(refsParsed.data.refs).toEqual(["knowledge:guides/renamed-guide"]);

    // Report: every rewritten citer appears with its occurrence count.
    const findRewrote = (rel: string): RewroteItem | undefined => json.rewrote.find((r) => r.file.endsWith(rel));
    expect(findRewrote("knowledge/citing-doc.md")?.count).toBe(2);
    expect(findRewrote("memories/citer-note.md")?.count).toBe(1);
    expect(findRewrote("knowledge/refs-citer.md")?.count).toBe(1);

    // The convention's whole point: the rename dangles NOTHING. The old ref is
    // gone from every md file, and lint's missing-ref check (SPEC-1, which
    // covers body text, refs: and xrefs:) comes back clean.
    for (const rel of allMarkdownFiles(stashDir)) {
      expect(fs.readFileSync(path.join(stashDir, rel), "utf8")).not.toContain("knowledge:guides/old-guide");
    }
    const lint = akmLint({ dir: stashDir });
    expect(lint.flagged.filter((i) => i.issue === "missing-ref")).toEqual([]);
  });

  test("rewrites occurrences inside fenced code blocks (stale examples must not survive)", async () => {
    seedAsset(stashDir, "memories/projectA/fenced-target.md", "The target memory.\n");
    const fencedCiter = seedAsset(
      stashDir,
      "knowledge/fenced.md",
      "---\ndescription: Fenced example citer\n---\n\n# Usage\n\n```bash\nakm show memory:projectA/fenced-target\n```\n",
    );

    const { code, stdout } = await runCliCapture(["mv", "memory:projectA/fenced-target", "projectA/fenced-target-v2"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;

    const after = fs.readFileSync(fencedCiter, "utf8");
    // The occurrence lives ONLY inside the fence: lint's missing-ref scan
    // strips fences, but the rewriter must not.
    expect(after).toContain("```bash\nakm show memory:projectA/fenced-target-v2\n```");
    expect(after).not.toContain("memory:projectA/fenced-target\n```");
    expect(json.rewrote.find((r) => r.file.endsWith("knowledge/fenced.md"))?.count).toBe(1);
  });

  test("boundary matching: a longer ref sharing the old ref as a prefix is NOT rewritten", async () => {
    seedAsset(stashDir, "memories/projectA/base-note.md", "The note being renamed.\n");
    seedAsset(stashDir, "memories/projectA/base-note-extra.md", "A neighbor whose ref extends the old one.\n");
    const citer = seedAsset(
      stashDir,
      "knowledge/prefix-citer.md",
      "---\ndescription: Cites both\nxrefs:\n  - memory:projectA/base-note-extra\n---\n\nPrimary: memory:projectA/base-note\nNeighbor: memory:projectA/base-note-extra\n",
    );

    const { code, stdout } = await runCliCapture(["mv", "memory:projectA/base-note", "projectA/base-note-v2"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;

    const after = fs.readFileSync(citer, "utf8");
    // The exact old ref was rewritten...
    expect(after).toContain("Primary: memory:projectA/base-note-v2");
    // ...the prefix-sharing neighbor was NOT (body and frontmatter): complete-ref
    // boundary matching, not substring replacement.
    expect(after).toContain("Neighbor: memory:projectA/base-note-extra");
    expect(parseFrontmatter(after).data.xrefs).toEqual(["memory:projectA/base-note-extra"]);
    // No bare occurrence of the old ref remains (the two survivors continue
    // with `-v2` / `-extra`, which the boundary regex excludes).
    expect(after.match(/memory:projectA\/base-note(?![\w.-])/)).toBeNull();
    // Exactly ONE occurrence was replaced in this file.
    expect(json.rewrote.find((r) => r.file.endsWith("knowledge/prefix-citer.md"))?.count).toBe(1);
  });
});

// ── read-only citers ─────────────────────────────────────────────────────────

describe("akm mv — read-only citers are reported, never written", () => {
  test("a citer in a read-only source stays byte-identical and lands in readOnlyCiters", async () => {
    const roDir = makeDir("akm-mv-readonly");
    const roCiter = seedAsset(
      roDir,
      "knowledge/shared-note.md",
      "Shared doc citing memory:projectA/ro-note from the team stash.\n",
    );
    const roRaw = fs.readFileSync(roCiter, "utf8");
    writeSandboxConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "shared", path: roDir, writable: false }],
    });
    seedAsset(stashDir, "memories/projectA/ro-note.md", "The note being renamed.\n");

    const { code, stdout } = await runCliCapture(["mv", "memory:projectA/ro-note", "projectA/ro-note-renamed"]);
    expect(code).toBe(0);

    const json = JSON.parse(stdout) as MvOutput;
    expect(json.ok).toBe(true);
    // The read-only citing file is reported as a manual follow-up, with the
    // {file, count} element shape (file is the citer's ABSOLUTE path — it
    // lives outside the writable stash, so no stash-relative form exists)...
    expect(json.readOnlyCiters).toEqual([{ file: roCiter, count: 1 }]);
    // ...and is NOT in the rewrote list, NOT touched on disk.
    expect(json.rewrote.some((r) => r.file.endsWith("shared-note.md"))).toBe(false);
    expect(fs.readFileSync(roCiter, "utf8")).toBe(roRaw);
  });
});

// ── memory .derived twin ─────────────────────────────────────────────────────

describe("akm mv — memory .derived.md twin coupling", () => {
  test("moves the .derived.md twin together on disk", async () => {
    seedAsset(stashDir, "memories/projectA/twin-note.md", "Base memory body.\n");
    seedAsset(stashDir, "memories/projectA/twin-note.derived.md", "Distilled twin body.\n");

    const { code, stdout } = await runCliCapture(["mv", "memory:projectA/twin-note", "projectA/twin-note-renamed"]);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as MvOutput).ok).toBe(true);

    expect(fs.existsSync(path.join(stashDir, "memories/projectA/twin-note.md"))).toBe(false);
    expect(fs.existsSync(path.join(stashDir, "memories/projectA/twin-note.derived.md"))).toBe(false);
    expect(fs.readFileSync(path.join(stashDir, "memories/projectA/twin-note-renamed.md"), "utf8")).toBe(
      "Base memory body.\n",
    );
    expect(fs.readFileSync(path.join(stashDir, "memories/projectA/twin-note-renamed.derived.md"), "utf8")).toBe(
      "Distilled twin body.\n",
    );
  });

  test("an explicit .derived twin ref cannot be moved alone (exit 2, both files intact)", async () => {
    const basePath = seedAsset(stashDir, "memories/coupled.md", "Base memory body.\n");
    const twinPath = seedAsset(stashDir, "memories/coupled.derived.md", "Distilled twin body.\n");

    const { code, stderr } = await runCliCapture(["mv", "memory:coupled.derived", "orphan-twin"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as ErrorEnvelope;
    expect(json.ok).toBe(false);
    // The error steers to renaming the base (the twin moves with it).
    expect(json.error).toContain("memory:coupled");
    expect(typeof json.code).toBe("string");
    expect(fs.readFileSync(basePath, "utf8")).toBe("Base memory body.\n");
    expect(fs.readFileSync(twinPath, "utf8")).toBe("Distilled twin body.\n");
    expect(fs.existsSync(path.join(stashDir, "memories/orphan-twin.md"))).toBe(false);
  });

  test("a target name ending in .derived is rejected (reserved twin suffix; exit 2, nothing moved)", async () => {
    const srcPath = seedAsset(stashDir, "memories/plain-note.md", "A base memory.\n");

    const { code, stderr } = await runCliCapture(["mv", "memory:plain-note", "evil.derived"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(json.error).toContain(".derived");
    expect(typeof json.code).toBe("string");
    expect(fs.readFileSync(srcPath, "utf8")).toBe("A base memory.\n");
    expect(fs.existsSync(path.join(stashDir, "memories/evil.derived.md"))).toBe(false);
    expect(fs.existsSync(path.join(stashDir, "memories/evil.derived.derived.md"))).toBe(false);
  });

  test("re-keys base AND twin in place: both row ids survive and the entry_key suffix relation holds", async () => {
    seedAsset(stashDir, "memories/projectA/twin-note.md", "Base memory body.\n");
    seedAsset(stashDir, "memories/projectA/twin-note.derived.md", "Distilled twin body.\n");
    await buildIndex();

    let db = openExistingDatabase(getDbPath());
    let baseId: number;
    let twinId: number;
    try {
      const base = entryByKeySuffix(db, ":memory:projectA/twin-note");
      const twin = entryByKeySuffix(db, ":memory:projectA/twin-note.derived");
      expect(base).toBeDefined();
      expect(twin).toBeDefined();
      baseId = (base as { id: number }).id;
      twinId = (twin as { id: number }).id;
    } finally {
      closeDatabase(db);
    }

    const { code } = await runCliCapture(["mv", "memory:projectA/twin-note", "projectA/twin-note-renamed"]);
    expect(code).toBe(0);

    db = openExistingDatabase(getDbPath());
    try {
      // Same row ids — the belief-inheritance coupling (twin entry_key ===
      // base entry_key + ".derived", db.ts getBaseBeliefStatesForDerivedTwins)
      // must survive the rename without minting new rows.
      const baseAfter = entryById(db, baseId);
      const twinAfter = entryById(db, twinId);
      expect(baseAfter?.entry_key.endsWith(":memory:projectA/twin-note-renamed")).toBe(true);
      expect(twinAfter?.entry_key).toBe(`${baseAfter?.entry_key}.derived`);
      // The old keys are gone (re-key, not insert-alongside).
      expect(entryByKeySuffix(db, ":memory:projectA/twin-note")).toBeUndefined();
      expect(entryByKeySuffix(db, ":memory:projectA/twin-note.derived")).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });
});

// ── utility-history preservation ─────────────────────────────────────────────

describe("akm mv — utility history and index re-key", () => {
  test("the entries row id and utility_scores row survive; search reflects the new name and reindexed citers", async () => {
    seedAsset(stashDir, "memories/projectA/util-note.md", "A memory with earned ranking history.\n");
    // A citer whose ONLY connection to the moved asset is its xrefs entry —
    // findable via FTS hints only after the rewritten file is reindexed.
    seedAsset(
      stashDir,
      "memories/citer-of-util.md",
      "---\ndescription: Cites the util note\nxrefs:\n  - memory:projectA/util-note\n---\n\nDerived from the util note.\n",
    );
    await buildIndex();

    // Accumulate utility history on the entry (the "learned ranking" a rename
    // must not reset — the verified cost the conventions warn about).
    let db = openExistingDatabase(getDbPath());
    let entryId: number;
    let utilityBefore: number;
    try {
      const row = entryByKeySuffix(db, ":memory:projectA/util-note");
      expect(row).toBeDefined();
      entryId = (row as { id: number }).id;
      applyFeedbackToUtilityScore(db, entryId, 1, 0);
      const score = getUtilityScore(db, entryId);
      expect(score).toBeDefined();
      utilityBefore = (score as { utility: number }).utility;
    } finally {
      closeDatabase(db);
    }

    const { code, stdout } = await runCliCapture(["mv", "memory:projectA/util-note", "projectA/util-note-renamed"]);
    expect(code).toBe(0);
    const mvJson = JSON.parse(stdout) as MvOutput;
    expect(mvJson.ok).toBe(true);
    // The command CLAIMS the history survived — pinned here against the DB
    // assertions below that prove it actually did.
    expect(mvJson.utilityPreserved).toBe(true);

    db = openExistingDatabase(getDbPath());
    try {
      // Re-keyed IN PLACE: same row id, new entry_key + file_path.
      const after = entryById(db, entryId);
      expect(after).toBeDefined();
      expect(after?.entry_key).toBe(`${stashDir}:memory:projectA/util-note-renamed`);
      expect(after?.file_path.endsWith(path.join("memories", "projectA", "util-note-renamed.md"))).toBe(true);
      // No row remains under the old key (no orphan duplicate was minted).
      expect(
        db.prepare("SELECT id FROM entries WHERE entry_key = ?").get(`${stashDir}:memory:projectA/util-note`),
      ).toBeNull();
      // The utility row keyed by entry_id survived with its accumulated value.
      const scoreAfter = getUtilityScore(db, entryId);
      expect(scoreAfter).toBeDefined();
      expect(scoreAfter?.utility).toBeCloseTo(utilityBefore, 10);
    } finally {
      closeDatabase(db);
    }

    // Search is immediately consistent: the token unique to the NEW name finds
    // the moved asset (moved row's FTS text refreshed) AND the citer (its
    // rewritten xref folded into hints via write-path reindexing).
    const search = await runCliCapture(["search", "renamed", "--type", "memory"]);
    expect(search.code).toBe(0);
    const refs = ((JSON.parse(search.stdout).hits ?? []) as Array<{ ref: string }>).map((h) => h.ref);
    expect(refs).toContain("memory:projectA/util-note-renamed");
    expect(refs).toContain("memory:citer-of-util");
    expect(refs).not.toContain("memory:projectA/util-note");
  });
});

// ── utilityPreserved honesty ─────────────────────────────────────────────────

describe("akm mv — the utilityPreserved flag is honest", () => {
  test("an existing index with an UNINDEXED source file: mv succeeds fail-open, utilityPreserved stays true, no ghost row", async () => {
    seedAsset(stashDir, "memories/indexed-note.md", "Indexed before the newcomer.\n");
    await buildIndex();
    // Created AFTER the index build — no entries row exists for it.
    seedAsset(stashDir, "memories/late-note.md", "Not yet indexed.\n");

    const { code, stdout } = await runCliCapture(["mv", "memory:late-note", "late-note-renamed"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;
    expect(json.ok).toBe(true);
    // Nothing was indexed under the old name, so nothing was lost: true.
    expect(json.utilityPreserved).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories/late-note-renamed.md"))).toBe(true);

    const db = openExistingDatabase(getDbPath());
    try {
      // No stale row under the old key (there never was one).
      expect(entryByKeySuffix(db, ":memory:late-note")).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("the file's row sits under an UNEXPECTED entry_key: the move succeeds but utilityPreserved reports false", async () => {
    seedAsset(stashDir, "memories/stranded-note.md", "History under a weird key.\n");
    await buildIndex();
    // Simulate a row indexed under a differently-normalized key (e.g. a
    // symlinked stash path at index time): the re-key by the canonical old
    // key finds nothing, but the file WAS indexed — history is stranded.
    let db = openExistingDatabase(getDbPath());
    try {
      db.prepare("UPDATE entries SET entry_key = ? WHERE entry_key = ?").run(
        `/somewhere/else:memory:stranded-note`,
        `${stashDir}:memory:stranded-note`,
      );
    } finally {
      closeDatabase(db);
    }

    const { code, stdout } = await runCliCapture(["mv", "memory:stranded-note", "stranded-note-renamed"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;
    expect(json.ok).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories/stranded-note-renamed.md"))).toBe(true);
    // The command must not claim it preserved history it never re-keyed.
    expect(json.utilityPreserved).toBe(false);

    // The ghost row is still there under the odd key — disclosed, not hidden.
    db = openExistingDatabase(getDbPath());
    try {
      expect(entryByKeySuffix(db, "/somewhere/else:memory:stranded-note")?.entry_key).toBe(
        "/somewhere/else:memory:stranded-note",
      );
    } finally {
      closeDatabase(db);
    }
  });

  test("an unreadable index.db: the move still succeeds but utilityPreserved reports false", async () => {
    seedAsset(stashDir, "memories/blocked-note.md", "History fate unknown.\n");
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, "definitely not a sqlite database", "utf8");

    const { code, stdout } = await runCliCapture(["mv", "memory:blocked-note", "blocked-note-renamed"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;
    // Fail-open: the rename itself lands...
    expect(json.ok).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories/blocked-note-renamed.md"))).toBe(true);
    // ...but the command must NOT claim it verified a re-key it could not run.
    expect(json.utilityPreserved).toBe(false);
  });
});

// ── canonical spelling ───────────────────────────────────────────────────────

describe("akm mv — non-canonical source spellings are rejected (exit 2, nothing moved)", () => {
  test("a knowledge-subdir alias is rejected naming the canonical ref; canonical citers stay intact", async () => {
    // `knowledge:alias-guide` resolves for LINT via the knowledge-subdir
    // fallback, but the canonical ref is knowledge:guides/alias-guide. A move
    // keyed to the alias would rewrite only alias-spelling citers, strand the
    // index row (its entry_key derives from the canonical spelling), and
    // dangle every canonical citer — so mv must refuse it.
    const guidePath = seedAsset(stashDir, "knowledge/guides/alias-guide.md", "# Aliased guide\n");
    const citer = seedAsset(
      stashDir,
      "memories/canonical-citer.md",
      "Cites knowledge:guides/alias-guide canonically.\n",
    );
    const citerRaw = fs.readFileSync(citer, "utf8");

    const { code, stderr } = await runCliCapture(["mv", "knowledge:alias-guide", "guides/alias-renamed"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as ErrorEnvelope;
    expect(json.ok).toBe(false);
    // The error steers to the canonical spelling.
    expect(json.error).toContain("knowledge:guides/alias-guide");
    expect(typeof json.code).toBe("string");
    // Nothing moved, nothing rewritten.
    expect(fs.existsSync(guidePath)).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "knowledge/guides/alias-renamed.md"))).toBe(false);
    expect(fs.readFileSync(citer, "utf8")).toBe(citerRaw);
  });

  test("a direct-path fallback (file outside the type root) is rejected instead of relocated", async () => {
    // `knowledge:prompts/stray` resolves for LINT via the direct-path
    // fallback to <stash>/prompts/stray.md — a file NOT under knowledge/.
    // A move would RELOCATE it into knowledge/, so mv must refuse.
    const strayPath = seedAsset(stashDir, "prompts/stray.md", "Lives outside the knowledge/ type root.\n");

    const { code, stderr } = await runCliCapture(["mv", "knowledge:prompts/stray", "prompts/stray-renamed"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(json.error.toLowerCase()).toContain("type root");
    expect(typeof json.code).toBe("string");
    expect(fs.existsSync(strayPath)).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "knowledge/prompts/stray-renamed.md"))).toBe(false);
  });
});

// ── rejections ───────────────────────────────────────────────────────────────

describe("akm mv — rejections (error envelope + exit codes)", () => {
  test("wiki refs are rejected with exit 2 (wiki has its own xref+lint system)", async () => {
    const wikiPath = seedAsset(stashDir, "wikis/main.md", "# Wiki root page\n");

    const { code, stderr } = await runCliCapture(["mv", "wiki:main", "main-renamed"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(json.error.toLowerCase()).toContain("wiki");
    expect(typeof json.code).toBe("string");
    expect(fs.existsSync(wikiPath)).toBe(true);
  });

  test("cross-type targets are rejected with exit 2 and nothing moves", async () => {
    const srcPath = seedAsset(stashDir, "memories/cross-note.md", "A memory that must stay a memory.\n");

    const { code, stderr } = await runCliCapture(["mv", "memory:cross-note", "knowledge:cross-note"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(json.error.toLowerCase()).toContain("type");
    expect(typeof json.code).toBe("string");
    expect(fs.existsSync(srcPath)).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "knowledge/cross-note.md"))).toBe(false);
  });

  test("an existing target is rejected with exit 2; neither file changes and no citer is rewritten", async () => {
    const srcPath = seedAsset(stashDir, "memories/projectA/src-note.md", "Source body.\n");
    const takenPath = seedAsset(stashDir, "memories/projectA/taken.md", "Pre-existing target body.\n");
    const citer = seedAsset(stashDir, "knowledge/exists-citer.md", "Cites memory:projectA/src-note here.\n");
    const citerRaw = fs.readFileSync(citer, "utf8");

    const { code, stderr } = await runCliCapture(["mv", "memory:projectA/src-note", "projectA/taken"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(json.error.toLowerCase()).toContain("exist");
    expect(typeof json.code).toBe("string");

    // Nothing moved, nothing clobbered, nothing rewritten.
    expect(fs.readFileSync(srcPath, "utf8")).toBe("Source body.\n");
    expect(fs.readFileSync(takenPath, "utf8")).toBe("Pre-existing target body.\n");
    expect(fs.readFileSync(citer, "utf8")).toBe(citerRaw);
  });

  test("an unresolvable source ref is rejected with exit 2 naming the ref", async () => {
    const { code, stderr } = await runCliCapture(["mv", "memory:projectA/ghost", "projectA/anything"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(json.error).toContain("memory:projectA/ghost");
    expect(typeof json.code).toBe("string");
    expect(fs.existsSync(path.join(stashDir, "memories/projectA/anything.md"))).toBe(false);
  });

  test("a target escaping the type root (../) is rejected with exit 2 and writes nothing outside it", async () => {
    const srcPath = seedAsset(stashDir, "memories/esc-note.md", "Must stay inside memories/.\n");

    const { code, stderr } = await runCliCapture(["mv", "memory:esc-note", "../../evil"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(typeof json.code).toBe("string");
    expect(fs.readFileSync(srcPath, "utf8")).toBe("Must stay inside memories/.\n");
    expect(fs.existsSync(path.join(stashDir, "evil.md"))).toBe(false);
    expect(fs.existsSync(path.join(storage.root, "evil.md"))).toBe(false);
  });

  test("a missing target argument fails without moving anything (NOTE: passes trivially pre-implementation)", async () => {
    const srcPath = seedAsset(stashDir, "memories/lonely-note.md", "Untouched.\n");

    const { code } = await runCliCapture(["mv", "memory:lonely-note"]);
    expect(code).not.toBe(0);
    expect(fs.readFileSync(srcPath, "utf8")).toBe("Untouched.\n");
  });
});

// ── events ───────────────────────────────────────────────────────────────────

describe("akm mv — events stream", () => {
  test("a successful mv appends exactly one 'mv' event carrying both refs; a failed mv appends none", async () => {
    seedAsset(stashDir, "memories/ev-note.md", "Event-stream probe note.\n");

    const ok = await runCliCapture(["mv", "memory:ev-note", "ev-note-renamed"]);
    expect(ok.code).toBe(0);

    const after = readEvents({ type: "mv" });
    expect(after.events).toHaveLength(1);
    const envelope = JSON.stringify(after.events[0]);
    expect(envelope).toContain("memory:ev-note");
    expect(envelope).toContain("memory:ev-note-renamed");

    // A failed mv (unresolvable source) records no mutation event.
    const bad = await runCliCapture(["mv", "memory:ghost", "ghost-renamed"]);
    expect(bad.code).toBe(2);
    expect(readEvents({ type: "mv" }).events).toHaveLength(1);
  });
});

// ── command registration + help meta ─────────────────────────────────────────

describe("akm mv — command registration and help meta", () => {
  // Dynamic import through a string-typed specifier so the not-yet-existing
  // module fails THESE tests at runtime (clear red) without breaking the whole
  // file's module graph or `tsc --noEmit` for unrelated stages.
  const MV_CLI_MODULE: string = "../../src/commands/mv-cli";

  test("src/commands/mv-cli.ts exports mvCommand with a described meta", async () => {
    const mod = (await import(MV_CLI_MODULE)) as Record<string, unknown>;
    expect(mod.mvCommand).toBeDefined();
    const meta = (mod.mvCommand as { meta?: { name?: string; description?: string } }).meta;
    const resolvedMeta = typeof meta === "function" ? await (meta as () => unknown)() : meta;
    expect((resolvedMeta as { name?: string })?.name).toBe("mv");
    expect(((resolvedMeta as { description?: string })?.description ?? "").length).toBeGreaterThan(0);
  });

  test("mv is registered as a top-level CLI verb", async () => {
    const { main } = await import("../../src/cli");
    const subCommands = (main as { subCommands?: Record<string, unknown> }).subCommands ?? {};
    expect(Object.keys(subCommands)).toContain("mv");
  });
});
