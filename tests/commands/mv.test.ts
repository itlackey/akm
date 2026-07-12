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
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import {
  applyFeedbackToUtilityScore,
  closeDatabase,
  getUtilityScore,
  openExistingDatabase,
} from "../../src/indexer/db/db";
import { ensureUsageEventsSchema, insertUsageEvent } from "../../src/indexer/usage/usage-events";
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
  /** Additive: present only when a re-key could not be completed. */
  warnings?: string[];
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
    // The command must not claim it preserved history it never re-keyed, and
    // the report carries the reason.
    expect(json.utilityPreserved).toBe(false);
    expect(json.warnings?.some((w) => w.includes("re-key"))).toBe(true);

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
    // ...but the command must NOT claim it verified a re-key it could not run,
    // and the REPORT (not just --verbose stderr) must say why history resets.
    expect(json.utilityPreserved).toBe(false);
    expect(json.warnings?.some((w) => w.includes("re-key"))).toBe(true);
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

// ── usage-event history (finding #2) ─────────────────────────────────────────

describe("akm mv — usage_events.entry_ref is re-pointed so history survives a full reindex", () => {
  test("bare and origin-qualified event refs are rewritten; events relink after `akm index --full`", async () => {
    seedAsset(stashDir, "memories/hist-note.md", "A memory with usage history.\n");
    await buildIndex();

    let db = openExistingDatabase(getDbPath());
    let entryId: number;
    try {
      const row = entryByKeySuffix(db, ":memory:hist-note");
      expect(row).toBeDefined();
      entryId = (row as { id: number }).id;
      ensureUsageEventsSchema(db);
      // Both spellings writers persist: bare and origin-qualified.
      insertUsageEvent(db, { event_type: "show", entry_id: entryId, entry_ref: "memory:hist-note" });
      insertUsageEvent(db, {
        event_type: "feedback",
        signal: "positive",
        entry_id: entryId,
        entry_ref: "memory:hist-note",
      });
      insertUsageEvent(db, { event_type: "search", entry_id: entryId, entry_ref: "local//memory:hist-note" });
    } finally {
      closeDatabase(db);
    }

    const mv = await runCliCapture(["mv", "memory:hist-note", "hist-note-renamed"]);
    expect(mv.code).toBe(0);
    expect((JSON.parse(mv.stdout) as MvOutput).utilityPreserved).toBe(true);

    // The events carry the NEW ref immediately (origin spelling preserved).
    db = openExistingDatabase(getDbPath());
    try {
      const refs = (
        db.prepare("SELECT entry_ref FROM usage_events WHERE entry_ref LIKE '%hist-note%' ORDER BY id").all() as Array<{
          entry_ref: string;
        }>
      ).map((r) => r.entry_ref);
      expect(refs).toEqual(["memory:hist-note-renamed", "memory:hist-note-renamed", "local//memory:hist-note-renamed"]);
    } finally {
      closeDatabase(db);
    }

    // The load-bearing path: a FULL rebuild re-mints entry ids, detaches every
    // event, and relinks by entry_ref. With the old ref left behind, relink
    // finds nothing and utility resets — the exact loss mv exists to prevent.
    const reindex = await runCliCapture(["index", "--full"]);
    expect(reindex.code).toBe(0);
    db = openExistingDatabase(getDbPath());
    try {
      const entry = entryByKeySuffix(db, ":memory:hist-note-renamed");
      expect(entry).toBeDefined();
      const linked = db
        .prepare("SELECT COUNT(*) AS cnt FROM usage_events WHERE entry_id = ? AND entry_ref LIKE '%hist-note-renamed%'")
        .get((entry as { id: number }).id) as { cnt: number };
      expect(linked.cnt).toBe(3);
      // Utility recomputed FROM the relinked events (show + positive feedback)
      // — the history stayed attached across the rebuild.
      expect(getUtilityScore(db, (entry as { id: number }).id)).toBeDefined();
    } finally {
      closeDatabase(db);
    }
  });
});

// ── displaced-row eviction (finding #4) ──────────────────────────────────────

describe("akm mv — displaced stale index row with FK children", () => {
  test("a stale row at the target key WITH an embeddings child is evicted cleanly and the re-key succeeds", async () => {
    seedAsset(stashDir, "memories/keeper.md", "The memory being renamed.\n");
    const vacatedPath = seedAsset(stashDir, "memories/vacated.md", "Deleted on disk later; index row lingers.\n");
    await buildIndex();

    let db = openExistingDatabase(getDbPath());
    let keeperId: number;
    let staleId: number;
    let utilityBefore: number;
    try {
      keeperId = (entryByKeySuffix(db, ":memory:keeper") as { id: number }).id;
      staleId = (entryByKeySuffix(db, ":memory:vacated") as { id: number }).id;
      applyFeedbackToUtilityScore(db, keeperId, 1, 0);
      utilityBefore = (getUtilityScore(db, keeperId) as { utility: number }).utility;
      // A NON-CASCADE FK child on the stale row: with foreign_keys = ON, a
      // bare `DELETE FROM entries` throws and rolls back the whole re-key.
      db.prepare("INSERT OR REPLACE INTO embeddings (id, embedding) VALUES (?, ?)").run(
        staleId,
        new Uint8Array([1, 2, 3, 4]),
      );
    } finally {
      closeDatabase(db);
    }
    // The target's FILE is gone (mv's target check passes) but its row lingers.
    fs.rmSync(vacatedPath);

    const { code, stdout } = await runCliCapture(["mv", "memory:keeper", "vacated"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;
    expect(json.ok).toBe(true);
    expect(json.utilityPreserved).toBe(true);
    expect(json.warnings).toBeUndefined();

    db = openExistingDatabase(getDbPath());
    try {
      // The moved row kept its id under the new key; history intact.
      expect(entryById(db, keeperId)?.entry_key).toBe(`${stashDir}:memory:vacated`);
      expect(getUtilityScore(db, keeperId)?.utility).toBeCloseTo(utilityBefore, 10);
      // The displaced row AND its child rows are gone (no orphans).
      expect(entryById(db, staleId)).toBeFalsy();
      expect(db.prepare("SELECT id FROM embeddings WHERE id = ?").get(staleId)).toBeFalsy();
      expect(db.prepare("SELECT entry_id FROM utility_scores WHERE entry_id = ?").get(staleId)).toBeFalsy();
    } finally {
      closeDatabase(db);
    }
  });
});

// ── state.db salience / outcome re-key (finding #5) ──────────────────────────

describe("akm mv — state.db asset_salience / asset_outcome re-key", () => {
  test("salience and outcome rows move to the new asset_ref; an orphan row at the new ref loses to the live row", async () => {
    seedAsset(stashDir, "memories/salient-note.md", "Salience-carrying note.\n");
    const now = Date.now();
    const stateDb = openStateDatabase();
    try {
      stateDb
        .prepare(
          `INSERT INTO asset_salience
             (asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score, consecutive_no_ops, updated_at, encoding_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("memory:salient-note", 0.9, 0.1, 0.2, 0.8, 0, now, "content");
      // An orphan row already squatting on the target ref (its asset was
      // deleted — mv verified no file exists at the target). The LIVE
      // asset's history must win.
      stateDb
        .prepare(
          `INSERT INTO asset_salience
             (asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score, consecutive_no_ops, updated_at, encoding_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("memory:salient-renamed", 0.5, 0, 0, 0.1, 0, now - 1000, "type-stub");
      stateDb
        .prepare(
          `INSERT INTO asset_outcome
             (asset_ref, last_retrieved_at, retrieval_count, expected_retrieval_rate, negative_feedback_count, accepted_change_count, review_pressure, outcome_score, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("memory:salient-note", now, 7, 1.5, 2, 1, 3, 0.4, now);
    } finally {
      stateDb.close();
    }

    const { code, stdout } = await runCliCapture(["mv", "memory:salient-note", "salient-renamed"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;
    expect(json.ok).toBe(true);
    expect(json.warnings).toBeUndefined();

    const after = openStateDatabase();
    try {
      // Exactly ONE salience row remains for this asset, at the new ref,
      // carrying the moved (content-derived) values — not the orphan's stub.
      const sal = after
        .prepare(
          "SELECT asset_ref, encoding_salience, rank_score, encoding_source FROM asset_salience WHERE asset_ref LIKE '%salient%'",
        )
        .all() as Array<{ asset_ref: string; encoding_salience: number; rank_score: number; encoding_source: string }>;
      expect(sal).toEqual([
        { asset_ref: "memory:salient-renamed", encoding_salience: 0.9, rank_score: 0.8, encoding_source: "content" },
      ]);
      const outcome = after
        .prepare(
          "SELECT asset_ref, retrieval_count, review_pressure FROM asset_outcome WHERE asset_ref LIKE '%salient%'",
        )
        .all() as Array<{ asset_ref: string; retrieval_count: number; review_pressure: number }>;
      expect(outcome).toEqual([{ asset_ref: "memory:salient-renamed", retrieval_count: 7, review_pressure: 3 }]);
    } finally {
      after.close();
    }
  });

  test("no state.db: mv succeeds and does not create one", async () => {
    seedAsset(stashDir, "memories/no-state.md", "No improve loop ever ran.\n");
    expect(fs.existsSync(getStateDbPath())).toBe(false);

    const { code, stdout } = await runCliCapture(["mv", "memory:no-state", "no-state-renamed"]);
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as MvOutput).ok).toBe(true);
    // The salience re-key must not have minted a state.db on its own — but a
    // successful mv appends an `mv` event, which legitimately creates it. So
    // assert the move landed and no salience rows were invented.
    if (fs.existsSync(getStateDbPath())) {
      const stateDb = openStateDatabase();
      try {
        const rows = stateDb.prepare("SELECT asset_ref FROM asset_salience").all();
        expect(rows).toEqual([]);
      } finally {
        stateDb.close();
      }
    }
  });
});

// ── workflow refs (finding #3) ───────────────────────────────────────────────

describe("akm mv — workflow refs are rejected (v1 scope)", () => {
  test("a YAML workflow cannot be moved (exit 2, file byte-identical, error names the manual procedure)", async () => {
    const wfBody = "steps:\n  - run: echo hi\n";
    const wfPath = seedAsset(stashDir, "workflows/deploy.yaml", wfBody);

    const { code, stderr } = await runCliCapture(["mv", "workflow:deploy", "release"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(json.error.toLowerCase()).toContain("workflow");
    expect(json.error).toContain("akm lint");
    expect(typeof json.code).toBe("string");
    // Nothing moved, nothing corrupted: no YAML-bodied workflows/release.md.
    expect(fs.readFileSync(wfPath, "utf8")).toBe(wfBody);
    expect(fs.existsSync(path.join(stashDir, "workflows/release.md"))).toBe(false);
    expect(fs.existsSync(path.join(stashDir, "workflows/release.yaml"))).toBe(false);
  });
});

// ── orphaned target twin (finding #8) ────────────────────────────────────────

describe("akm mv — orphaned .derived.md at the target name", () => {
  test("renaming a TWIN-LESS memory onto a name with an orphaned .derived.md is rejected (no silent adoption)", async () => {
    const srcPath = seedAsset(stashDir, "memories/twinless.md", "No twin here.\n");
    const orphanBody = "---\nderived_from: memory:occupied\n---\n\nStale distillation of a deleted memory.\n";
    const orphanPath = seedAsset(stashDir, "memories/occupied.derived.md", orphanBody);

    const { code, stderr } = await runCliCapture(["mv", "memory:twinless", "occupied"]);
    expect(code).toBe(2);

    const json = JSON.parse(stderr) as ErrorEnvelope;
    expect(json.ok).toBe(false);
    expect(json.error).toContain(".derived");
    expect(json.code).toBe("RESOURCE_ALREADY_EXISTS");
    // Nothing moved; the orphan was not adopted.
    expect(fs.readFileSync(srcPath, "utf8")).toBe("No twin here.\n");
    expect(fs.existsSync(path.join(stashDir, "memories/occupied.md"))).toBe(false);
    expect(fs.readFileSync(orphanPath, "utf8")).toBe(orphanBody);
  });
});

// ── task .yml citers (finding #9) ────────────────────────────────────────────

describe("akm mv — task YAML citers", () => {
  test("refs in tasks/*.yml and tasks/*.yaml are rewritten and reported; yml outside tasks/ is not scanned", async () => {
    seedAsset(stashDir, "memories/task-target.md", "Cited from scheduled tasks.\n");
    const ymlPath = seedAsset(stashDir, "tasks/nightly.yml", 'schedule: "0 9 * * *"\nprompt: memory:task-target\n');
    const yamlPath = seedAsset(stashDir, "tasks/weekly.yaml", 'schedule: "0 9 * * 1"\nprompt: memory:task-target\n');
    const otherYml = seedAsset(stashDir, "knowledge/data.yml", "ref: memory:task-target\n");

    const { code, stdout } = await runCliCapture(["mv", "memory:task-target", "task-target-v2"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;

    expect(fs.readFileSync(ymlPath, "utf8")).toBe('schedule: "0 9 * * *"\nprompt: memory:task-target-v2\n');
    expect(fs.readFileSync(yamlPath, "utf8")).toBe('schedule: "0 9 * * 1"\nprompt: memory:task-target-v2\n');
    expect(json.rewrote.find((r) => r.file.endsWith("tasks/nightly.yml"))?.count).toBe(1);
    expect(json.rewrote.find((r) => r.file.endsWith("tasks/weekly.yaml"))?.count).toBe(1);
    // Outside tasks/: not scanned (lint's missing-ref pass doesn't scan it
    // either) — untouched and unreported.
    expect(fs.readFileSync(otherYml, "utf8")).toBe("ref: memory:task-target\n");
    expect(json.rewrote.some((r) => r.file.endsWith("knowledge/data.yml"))).toBe(false);
  });
});

// ── flow-style lists and bracketed refs (finding #10) ────────────────────────

describe("akm mv — flow-style YAML lists and bracketed body refs", () => {
  test("[-preceded refs are rewritten: single-element flow list, bracketed body ref, first element of a multi-element list", async () => {
    seedAsset(stashDir, "memories/projectA/flow-note.md", "The note being renamed.\n");
    seedAsset(stashDir, "memories/projectA/flow-sibling.md", "A neighbor that must stay untouched.\n");
    const flowCiter = seedAsset(
      stashDir,
      "knowledge/flow-citer.md",
      "---\ndescription: Flow-style citer\nxrefs: [memory:projectA/flow-note]\n---\n\nsee [memory:projectA/flow-note] for details.\n",
    );
    const multiCiter = seedAsset(
      stashDir,
      "knowledge/multi-flow-citer.md",
      "---\ndescription: Multi-element flow list\nxrefs: [memory:projectA/flow-note, memory:projectA/flow-sibling]\n---\n\nBody.\n",
    );

    const { code, stdout } = await runCliCapture(["mv", "memory:projectA/flow-note", "projectA/flow-note-v2"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;

    // Single-element flow list AND bracketed body ref: both rewritten.
    const flowAfter = fs.readFileSync(flowCiter, "utf8");
    expect(flowAfter).toContain("xrefs: [memory:projectA/flow-note-v2]");
    expect(flowAfter).toContain("see [memory:projectA/flow-note-v2] for details.");
    expect(json.rewrote.find((r) => r.file.endsWith("knowledge/flow-citer.md"))?.count).toBe(2);

    // Multi-element flow list: the `[`-preceded FIRST element is rewritten
    // (the legacy grammar skipped it), the space-preceded neighbor keeps its
    // own ref untouched.
    const multiAfter = fs.readFileSync(multiCiter, "utf8");
    expect(multiAfter).toContain("xrefs: [memory:projectA/flow-note-v2, memory:projectA/flow-sibling]");
    expect(json.rewrote.find((r) => r.file.endsWith("knowledge/multi-flow-citer.md"))?.count).toBe(1);

    // The rename dangles nothing lint can see.
    const lint = akmLint({ dir: stashDir });
    expect(lint.flagged.filter((i) => i.issue === "missing-ref")).toEqual([]);
  });
});

// ── alias-spelling citers (finding #11) ──────────────────────────────────────

describe("akm mv — alias-spelling citers are rewritten to the new canonical ref", () => {
  test(".md-suffixed, local//-prefixed, and knowledge-subdir basename aliases", async () => {
    seedAsset(stashDir, "knowledge/guides/old-guide.md", "# Guide\n");
    const mdCiter = seedAsset(stashDir, "memories/md-citer.md", "See knowledge:guides/old-guide.md for details.\n");
    const localCiter = seedAsset(stashDir, "memories/local-citer.md", "See local//knowledge:guides/old-guide too.\n");
    // The knowledge-subdir alias: `knowledge:old-guide` resolves (via lint's
    // shared resolver fallback) to knowledge/guides/old-guide.md.
    const subdirCiter = seedAsset(stashDir, "memories/subdir-citer.md", "See knowledge:old-guide (basename alias).\n");

    const { code, stdout } = await runCliCapture(["mv", "knowledge:guides/old-guide", "guides/renamed-guide"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;

    // Every alias spelling is rewritten to the new CANONICAL ref.
    expect(fs.readFileSync(mdCiter, "utf8")).toBe("See knowledge:guides/renamed-guide for details.\n");
    expect(fs.readFileSync(localCiter, "utf8")).toBe("See knowledge:guides/renamed-guide too.\n");
    expect(fs.readFileSync(subdirCiter, "utf8")).toBe("See knowledge:guides/renamed-guide (basename alias).\n");
    for (const rel of ["memories/md-citer.md", "memories/local-citer.md", "memories/subdir-citer.md"]) {
      expect(json.rewrote.find((r) => r.file.endsWith(rel))?.count).toBe(1);
    }
    const lint = akmLint({ dir: stashDir });
    expect(lint.flagged.filter((i) => i.issue === "missing-ref")).toEqual([]);
  });

  test("alias citers in a READ-ONLY source are detected and reported, never written", async () => {
    const roDir = makeDir("akm-mv-alias-readonly");
    const roCiter = seedAsset(roDir, "knowledge/shared.md", "Team doc cites knowledge:guides/alias-note.md here.\n");
    const roRaw = fs.readFileSync(roCiter, "utf8");
    writeSandboxConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", name: "shared", path: roDir, writable: false }],
    });
    seedAsset(stashDir, "knowledge/guides/alias-note.md", "# Aliased note\n");

    const { code, stdout } = await runCliCapture(["mv", "knowledge:guides/alias-note", "guides/alias-note-v2"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;
    expect(json.readOnlyCiters).toEqual([{ file: roCiter, count: 1 }]);
    expect(fs.readFileSync(roCiter, "utf8")).toBe(roRaw);
  });
});

// ── .md alias spellings of source and target ─────────────────────────────────

describe("akm mv — .md alias spellings are accepted but canonicalized throughout", () => {
  test(".md-suffixed SOURCE: canonical citers rewritten, canonical index row re-keyed with utility intact, salience moved", async () => {
    seedAsset(stashDir, "memories/alias-src.md", "Moved via its .md alias spelling.\n");
    const citer = seedAsset(stashDir, "knowledge/alias-src-citer.md", "Cites memory:alias-src canonically.\n");
    await buildIndex();

    let db = openExistingDatabase(getDbPath());
    let entryId: number;
    let utilityBefore: number;
    try {
      const row = entryByKeySuffix(db, ":memory:alias-src");
      expect(row).toBeDefined();
      entryId = (row as { id: number }).id;
      applyFeedbackToUtilityScore(db, entryId, 1, 0);
      utilityBefore = (getUtilityScore(db, entryId) as { utility: number }).utility;
    } finally {
      closeDatabase(db);
    }
    // Salience history is keyed by the CANONICAL bare ref — a fromRef keyed
    // to the alias spelling would silently miss it.
    const stateDb = openStateDatabase();
    try {
      stateDb
        .prepare(
          `INSERT INTO asset_salience
             (asset_ref, encoding_salience, outcome_salience, retrieval_salience, rank_score, consecutive_no_ops, updated_at, encoding_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("memory:alias-src", 0.9, 0.1, 0.2, 0.8, 0, Date.now(), "content");
    } finally {
      stateDb.close();
    }

    const { code, stdout } = await runCliCapture(["mv", "memory:alias-src.md", "alias-src-v2"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;
    expect(json.ok).toBe(true);
    // The alias spelling is accepted as INPUT but never leaks into the
    // report, the citer rewrites, or any re-keyed row.
    expect(json.from).toBe("memory:alias-src");
    expect(json.to).toBe("memory:alias-src-v2");
    expect(json.utilityPreserved).toBe(true);
    expect(json.warnings).toBeUndefined();

    expect(fs.readFileSync(citer, "utf8")).toBe("Cites memory:alias-src-v2 canonically.\n");

    db = openExistingDatabase(getDbPath());
    try {
      // The CANONICAL row was re-keyed in place (same id, history attached) —
      // not skipped in favor of a nonexistent `alias-src.md`-keyed row.
      const after = entryById(db, entryId);
      expect(after?.entry_key).toBe(`${stashDir}:memory:alias-src-v2`);
      expect(getUtilityScore(db, entryId)?.utility).toBeCloseTo(utilityBefore, 10);
      expect(entryByKeySuffix(db, ":memory:alias-src")).toBeUndefined();
    } finally {
      closeDatabase(db);
    }

    const stateAfter = openStateDatabase();
    try {
      const rows = stateAfter
        .prepare("SELECT asset_ref FROM asset_salience WHERE asset_ref LIKE '%alias-src%'")
        .all() as Array<{ asset_ref: string }>;
      expect(rows).toEqual([{ asset_ref: "memory:alias-src-v2" }]);
    } finally {
      stateAfter.close();
    }
  });

  test(".md-suffixed TARGET: file written once as <name>.md, citers get the canonical ref, ONE index row at the canonical key", async () => {
    seedAsset(stashDir, "memories/target-alias.md", "Moved onto a .md-spelled target.\n");
    const citer = seedAsset(stashDir, "knowledge/target-alias-citer.md", "Cites memory:target-alias here.\n");
    await buildIndex();

    let db = openExistingDatabase(getDbPath());
    let entryId: number;
    try {
      const row = entryByKeySuffix(db, ":memory:target-alias");
      expect(row).toBeDefined();
      entryId = (row as { id: number }).id;
      applyFeedbackToUtilityScore(db, entryId, 1, 0);
    } finally {
      closeDatabase(db);
    }

    const { code, stdout } = await runCliCapture(["mv", "memory:target-alias", "target-alias-v2.md"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;
    expect(json.to).toBe("memory:target-alias-v2");
    expect(json.utilityPreserved).toBe(true);

    // The file carries the extension ONCE; citers carry the canonical ref,
    // never `memory:target-alias-v2.md`.
    expect(fs.existsSync(path.join(stashDir, "memories/target-alias-v2.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories/target-alias-v2.md.md"))).toBe(false);
    expect(fs.readFileSync(citer, "utf8")).toBe("Cites memory:target-alias-v2 here.\n");

    db = openExistingDatabase(getDbPath());
    try {
      // Exactly ONE row for the moved asset, at the canonical key, still under
      // the original id — a `…:memory:target-alias-v2.md` re-key would leave
      // the history stranded behind a row the write-path index pass (which
      // derives the canonical name from the file) immediately duplicates.
      const rows = db
        .prepare("SELECT id, entry_key FROM entries WHERE entry_key LIKE '%:memory:target-alias%'")
        .all() as Array<{ id: number; entry_key: string }>;
      expect(rows).toEqual([{ id: entryId, entry_key: `${stashDir}:memory:target-alias-v2` }]);
      expect(getUtilityScore(db, entryId)).toBeDefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("a twin's .md alias spelling (memory:x.derived.md) is still rejected as a twin ref (exit 2)", async () => {
    seedAsset(stashDir, "memories/md-coupled.md", "Base memory body.\n");
    seedAsset(stashDir, "memories/md-coupled.derived.md", "Distilled twin body.\n");

    const { code, stderr } = await runCliCapture(["mv", "memory:md-coupled.derived.md", "free-twin"]);
    expect(code).toBe(2);
    const json = JSON.parse(stderr) as ErrorEnvelope;
    expect(json.ok).toBe(false);
    // The error steers to the base ref, exactly like the extensionless twin spelling.
    expect(json.error).toContain("memory:md-coupled");
    expect(fs.existsSync(path.join(stashDir, "memories/md-coupled.derived.md"))).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories/free-twin.md"))).toBe(false);
  });
});

// ── target-parent validation ordering ────────────────────────────────────────

describe("akm mv — target parent is created before any citer edit", () => {
  test("a target parent blocked by an existing FILE fails the command with every citer byte-identical", async () => {
    seedAsset(stashDir, "memories/parent-src.md", "Source body.\n");
    const citer = seedAsset(stashDir, "knowledge/parent-citer.md", "Cites memory:parent-src today.\n");
    const citerRaw = fs.readFileSync(citer, "utf8");
    // memories/blocked exists as a FILE, so the target's parent directory
    // (memories/blocked/) can never be created.
    fs.writeFileSync(path.join(stashDir, "memories/blocked"), "a file squatting on the dir name", "utf8");

    const { code } = await runCliCapture(["mv", "memory:parent-src", "blocked/new-src"]);
    expect(code).not.toBe(0);

    // Validate-before-write held: no citer was modified (they would otherwise
    // point at a ref whose file never arrived), nothing moved.
    expect(fs.readFileSync(citer, "utf8")).toBe(citerRaw);
    expect(fs.readFileSync(path.join(stashDir, "memories/parent-src.md"), "utf8")).toBe("Source body.\n");
  });
});

// ── state.db re-key failure honesty ──────────────────────────────────────────

describe("akm mv — state.db re-key failures are surfaced, missing tables stay silent", () => {
  test("a NON-missing-table failure (incompatible schema) lands in warnings; the move itself still succeeds", async () => {
    seedAsset(stashDir, "memories/state-broken.md", "Salience fate unknown.\n");
    const stateDb = openStateDatabase();
    try {
      stateDb.exec("DROP TABLE asset_salience");
      stateDb.exec("CREATE TABLE asset_salience (nope TEXT)");
    } finally {
      stateDb.close();
    }

    const { code, stdout } = await runCliCapture(["mv", "memory:state-broken", "state-broken-renamed"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;
    expect(json.ok).toBe(true);
    expect(fs.existsSync(path.join(stashDir, "memories/state-broken-renamed.md"))).toBe(true);
    // The failure names the table in the REPORT — not swallowed as if it were
    // the known legacy missing-table case.
    expect(json.warnings?.some((w) => w.includes("state.db") && w.includes("asset_salience"))).toBe(true);
  });

  test("a genuinely MISSING table (legacy state.db) is skipped silently — no warning", async () => {
    seedAsset(stashDir, "memories/state-legacy.md", "Legacy state.db without salience tables.\n");
    const stateDb = openStateDatabase();
    try {
      stateDb.exec("DROP TABLE asset_salience");
      stateDb.exec("DROP TABLE asset_outcome");
    } finally {
      stateDb.close();
    }

    const { code, stdout } = await runCliCapture(["mv", "memory:state-legacy", "state-legacy-renamed"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;
    expect(json.ok).toBe(true);
    expect(json.warnings).toBeUndefined();
  });
});

// ── sentence-terminal punctuation (resolver retry) ───────────────────────────

describe("akm mv — refs followed by sentence punctuation are rewritten, punctuation preserved", () => {
  test('"See memory:old." forms are rewritten; a genuinely dotted name that resolves is never mangled', async () => {
    seedAsset(stashDir, "memories/punct-note.md", "The moved note.\n");
    seedAsset(stashDir, "memories/v1.2-notes.md", "A genuinely dotted neighbor.\n");
    const citer = seedAsset(
      stashDir,
      "knowledge/punct-citer.md",
      "See memory:punct-note. Read memory:punct-note; also (memory:punct-note!) twice.\n" +
        "Suffix form memory:punct-note.md.\n" +
        "Dotted neighbor stays: memory:v1.2-notes. And plain memory:v1.2-notes too.\n",
    );

    const { code, stdout } = await runCliCapture(["mv", "memory:punct-note", "punct-note-v2"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;

    const after = fs.readFileSync(citer, "utf8");
    // Every punctuation-terminated spelling rewritten, punctuation preserved.
    expect(after).toContain("See memory:punct-note-v2. Read memory:punct-note-v2; also (memory:punct-note-v2!) twice.");
    expect(after).toContain("Suffix form memory:punct-note-v2.\n");
    // The dotted neighbor resolves as its own asset — untouched in both the
    // sentence-terminal and plain spellings.
    expect(after).toContain("Dotted neighbor stays: memory:v1.2-notes. And plain memory:v1.2-notes too.");
    expect(json.rewrote.find((r) => r.file.endsWith("knowledge/punct-citer.md"))?.count).toBe(4);
  });
});

// ── workflow YAML citers ─────────────────────────────────────────────────────

describe("akm mv — workflow YAML citers", () => {
  test("refs in workflows/*.yaml and workflows/*.yml are rewritten and reported", async () => {
    seedAsset(stashDir, "memories/wf-cited.md", "Cited from workflow programs.\n");
    const yamlPath = seedAsset(
      stashDir,
      "workflows/deploy.yaml",
      "steps:\n  - instructions: Use memory:wf-cited before deploying\n",
    );
    const ymlPath = seedAsset(
      stashDir,
      "workflows/release.yml",
      "steps:\n  - instructions: Read memory:wf-cited notes\n",
    );

    const { code, stdout } = await runCliCapture(["mv", "memory:wf-cited", "wf-cited-v2"]);
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as MvOutput;

    expect(fs.readFileSync(yamlPath, "utf8")).toBe(
      "steps:\n  - instructions: Use memory:wf-cited-v2 before deploying\n",
    );
    expect(fs.readFileSync(ymlPath, "utf8")).toBe("steps:\n  - instructions: Read memory:wf-cited-v2 notes\n");
    expect(json.rewrote.find((r) => r.file.endsWith("workflows/deploy.yaml"))?.count).toBe(1);
    expect(json.rewrote.find((r) => r.file.endsWith("workflows/release.yml"))?.count).toBe(1);
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
