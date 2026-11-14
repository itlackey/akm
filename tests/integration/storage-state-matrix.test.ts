// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Storage state matrix: every read verb x every index.db / state.db state a crash, a power cut, an upgrade or a
 * first build can leave on disk. Each state is a file written directly (no timing). A failing cell is named
 * `<state> x <verb>`.
 *
 * Oracle (the invariants, not one author's intent):
 *  - no CLI verb exits 70 (an unclassified failure);
 *  - no workspace call throws a raw SQLite error (a classified `AkmError` is fine);
 *  - `akm index` recovers every regenerable index.db state: the next search exits 0 with hits;
 *  - `akm health` is not "pass" when search cannot work, and not "fail" for a build in progress;
 *  - a damaged state.db (not regenerable) is one classified error, exit 78, never 70 or an empty success;
 *  - `show` is served from the files, so it exits 0 whatever index.db holds.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { splitMarkdownFragments } from "../../src/core/asset/markdown-fragments";
import { saveConfig } from "../../src/core/config/config";
import { AkmError } from "../../src/core/errors";
import { getDbPath, getIndexRebuildLockPath } from "../../src/core/paths";
import { getStateDbPath } from "../../src/core/state-db";
import { assets, documents } from "../../src/workspace";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withDefaultBundle, withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";

const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "previous-release-corpus");
const GUIDE = "knowledge/guide-1";
const GUIDE_BODY = "# Guide 1\n\nDeploy safely.\n\n## Rollback\n\nRoll back the deploy.\n";

let storage: IsolatedAkmStorage;
let template: string;
let fragmentId = "";
const isolatedEnv: Record<string, string | undefined> = {};
let sleeper: ReturnType<typeof Bun.spawn> | undefined;

// ── state builders ────────────────────────────────────────────────────────────────────────────────────────────

const indexPath = () => getDbPath();
const statePath = () => getStateDbPath();

function removeDb(file: string): void {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
}

/** Deterministic non-SQLite bytes. */
function junk(length: number): Buffer {
  const out = Buffer.alloc(length);
  let x = 123456789;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

function editSqlite(file: string, sql: string): void {
  const db = new Database(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

const editIndex = (sql: string): void => editSqlite(indexPath(), sql);

function replaceFile(file: string, bytes: Buffer): void {
  removeDb(file);
  fs.writeFileSync(file, bytes);
}

function fixtureIndex(name: string): void {
  removeDb(indexPath());
  editIndex(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
  // The fixture is another release's index of THIS library: same stash, older layout.
  editIndex(`INSERT OR REPLACE INTO index_meta(key, value) VALUES ('stashDir', '${storage.stashDir}');`);
}

function holdRebuildLockWithOtherProcess(): void {
  sleeper = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  fs.writeFileSync(
    getIndexRebuildLockPath(),
    JSON.stringify({ pid: sleeper.pid, startedAt: new Date().toISOString() }),
    "utf8",
  );
}

function metaOnly(): void {
  removeDb(indexPath());
  editIndex(
    "PRAGMA journal_mode=WAL; CREATE TABLE index_meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO index_meta VALUES('version','26');",
  );
}

const templateBytes = (name: string): Buffer => fs.readFileSync(path.join(template, name));

interface State {
  name: string;
  build: () => void;
  /** index.db is rebuildable by `akm index`. */
  regenerable?: boolean;
  /** Search cannot serve results (so health must not say pass). */
  searchBroken?: boolean;
  /** A newer layout is refused with a classified error (exit 78) instead of served or rebuilt. */
  refusesIndex?: boolean;
  /** A live other process holds the rebuild lock. */
  locked?: boolean;
  /** state.db is damaged beyond use (not regenerable). */
  stateDamaged?: boolean;
}

const INDEX_STATES: State[] = [
  { name: "healthy", build: () => {}, regenerable: true },
  { name: "index absent", build: () => removeDb(indexPath()), regenerable: true },
  { name: "index 0-byte", build: () => replaceFile(indexPath(), Buffer.alloc(0)), regenerable: true },
  { name: "index meta-only", build: metaOnly, regenerable: true },
  {
    name: "index header random bytes",
    build: () => replaceFile(indexPath(), junk(8192)),
    regenerable: true,
    searchBroken: true,
  },
  {
    name: "index zero-filled",
    build: () => replaceFile(indexPath(), Buffer.alloc(templateBytes("index.db").length)),
    regenerable: true,
    searchBroken: true,
  },
  {
    name: "index interior pages overwritten",
    build: () => {
      const buf = templateBytes("index.db");
      const pages = Math.floor(buf.length / 4096);
      const from = Math.floor(pages / 3) * 4096;
      const to = Math.floor((pages * 2) / 3) * 4096;
      junk(to - from).copy(buf, from);
      replaceFile(indexPath(), buf);
    },
    regenerable: true,
    searchBroken: true,
  },
  {
    name: "index truncated to half",
    build: () => replaceFile(indexPath(), templateBytes("index.db").subarray(0, templateBytes("index.db").length / 2)),
    regenerable: true,
    searchBroken: true,
  },
  { name: "index layout 20 (fixture)", build: () => fixtureIndex("index-v20.sql"), regenerable: true },
  { name: "index layout 22 (fixture)", build: () => fixtureIndex("index-v22.sql"), regenerable: true },
  { name: "index layout 25 (fixture)", build: () => fixtureIndex("index-v25.sql"), regenerable: true },
  {
    name: "index layout 22 (downgraded copy)",
    build: () =>
      editIndex(
        "DROP TABLE entry_fragments; DROP TABLE asset_links; ALTER TABLE entries DROP COLUMN embed_hash;" +
          "ALTER TABLE entries ADD COLUMN search_text TEXT NOT NULL DEFAULT '';" +
          "UPDATE index_meta SET value='22' WHERE key='version';",
      ),
    regenerable: true,
  },
  {
    name: "index newer layout",
    build: () => editIndex("UPDATE index_meta SET value='99' WHERE key='version';"),
    // A downgrade guard: a classified refusal (INDEX_SCHEMA_INCOMPATIBLE, exit 78) is the contract, not a rebuild.
    refusesIndex: true,
  },
  {
    name: "index of another library",
    build: () =>
      editIndex(
        "UPDATE index_meta SET value='/nonexistent' WHERE key='stashDir';" +
          "UPDATE index_meta SET value='[\"/nonexistent\"]' WHERE key='stashDirs';",
      ),
    regenerable: true,
  },
  {
    name: "index without builtAt",
    build: () => editIndex("DELETE FROM index_meta WHERE key='builtAt';"),
    regenerable: true,
  },
  {
    name: "entries without entries_fts",
    build: () => editIndex("DROP TABLE entries_fts;"),
    regenerable: true,
    searchBroken: true,
  },
  {
    name: "first build running (meta-only + live lock)",
    build: () => {
      metaOnly();
      holdRebuildLockWithOtherProcess();
    },
    locked: true,
  },
  { name: "rebuild lock held by live other process", build: holdRebuildLockWithOtherProcess, locked: true },
];

const STATE_STATES: State[] = [
  { name: "state.db absent", build: () => removeDb(statePath()) },
  { name: "state.db garbage", build: () => replaceFile(statePath(), junk(8192)), stateDamaged: true },
  {
    name: "state.db zero-filled",
    build: () => replaceFile(statePath(), Buffer.alloc(templateBytes("state.db").length)),
    stateDamaged: true,
  },
  {
    name: "state.db truncated",
    build: () => replaceFile(statePath(), templateBytes("state.db").subarray(0, templateBytes("state.db").length / 2)),
    stateDamaged: true,
  },
  {
    name: "state.db newer",
    build: () => editSqlite(statePath(), "INSERT INTO schema_migrations(id) VALUES('9999-future');"),
  },
];

const STATES = [...INDEX_STATES, ...STATE_STATES];

// ── verbs ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface CliOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

const cli = (...args: string[]): Promise<CliOutcome> => runCliCapture(args);

function json(out: CliOutcome): Record<string, unknown> | undefined {
  try {
    return JSON.parse(out.stdout) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const hitCount = (out: CliOutcome): number => {
  const hits = json(out)?.results;
  return Array.isArray(hits) ? hits.length : 0;
};

const describeOutcome = (out: CliOutcome): string => `exit ${out.code}: ${(out.stderr || out.stdout).slice(0, 300)}`;

function expectNotInternal(out: CliOutcome): void {
  if (out.code === 70) throw new Error(`exited 70 (unclassified) — ${describeOutcome(out)}`);
}

interface CliVerb {
  name: string;
  args: () => string[];
}

const CLI_VERBS: CliVerb[] = [
  { name: "search", args: () => ["search", "deploy", "--format=json"] },
  { name: "curate", args: () => ["curate", "deploy", "--format=json"] },
  { name: "show", args: () => ["show", GUIDE, "--format=json"] },
  { name: "show .md", args: () => ["show", `${GUIDE}.md`, "--format=json"] },
  { name: "show #slug --lead", args: () => ["show", `${GUIDE}#guide-1`, "--lead", "--format=json"] },
  { name: "show #akm-fragment", args: () => ["show", `${GUIDE}#${fragmentId}`, "--format=json"] },
  { name: "feedback", args: () => ["feedback", GUIDE, "--positive", "--format=json"] },
  { name: "info", args: () => ["info", "--format=json"] },
  { name: "bundle list", args: () => ["bundle", "list", "--format=json"] },
  { name: "log", args: () => ["log", "--format=json"] },
  { name: "index --skip-if-locked", args: () => ["index", "--skip-if-locked", "--format=json"] },
];

/** Verbs that read state.db: a damaged one must say so with exit 78. */
const READS_STATE_DB = new Set(["feedback", "log"]);

async function checkCli(state: State, verb: CliVerb): Promise<void> {
  const out = await cli(...verb.args());
  expectNotInternal(out);
  if (state.stateDamaged && READS_STATE_DB.has(verb.name)) {
    if (out.code !== 78) {
      throw new Error(`damaged state.db must be one classified error (exit 78) — ${describeOutcome(out)}`);
    }
    return;
  }
  // `--lead` asks for indexed-safe context: an index that cannot supply it refuses and points at `akm index`.
  const leadRefusal =
    verb.name === "show #slug --lead" && out.code === 1 && `${out.stdout}${out.stderr}`.includes("akm index");
  if (
    verb.name.startsWith("show") &&
    !state.stateDamaged &&
    !(state.refusesIndex && out.code === 78) &&
    !leadRefusal &&
    out.code !== 0
  ) {
    throw new Error(`show is served from the files and must exit 0 — ${describeOutcome(out)}`);
  }
  if (verb.name === "index --skip-if-locked" && state.locked && out.code !== 0) {
    throw new Error(`a held rebuild lock must skip, exit 0 — ${describeOutcome(out)}`);
  }
}

async function checkHealth(state: State): Promise<void> {
  const out = await cli("health", "--format=json");
  expectNotInternal(out);
  if (state.stateDamaged) {
    // Health stays a report: one failing finding naming state.db, exit 1.
    if (out.code !== 1 || !out.stdout.includes("state.db")) {
      throw new Error(`damaged state.db must be one failing health finding (exit 1) — ${describeOutcome(out)}`);
    }
    return;
  }
  const body = json(out);
  const status = (body?.status ?? body?.overall) as string | undefined;
  if (state.searchBroken) {
    const search = await cli("search", "deploy", "--format=json");
    const searchOk = search.code === 0 && hitCount(search) > 0;
    if (!searchOk && (status === "pass" || out.code === 0)) {
      throw new Error(
        `health says pass while search cannot work (search ${describeOutcome(search)}); health: ${out.stdout.slice(0, 200)}`,
      );
    }
  }
  if (state.locked && (status === "fail" || out.code === 1)) {
    throw new Error(`health fails a build in progress: ${out.stdout.slice(0, 300)}`);
  }
}

async function checkIndexRecovers(): Promise<void> {
  const built = await cli("index", "--format=json");
  expectNotInternal(built);
  if (built.code !== 0) throw new Error(`akm index must recover this state — ${describeOutcome(built)}`);
  const search = await cli("search", "deploy", "--format=json");
  expectNotInternal(search);
  if (search.code !== 0 || hitCount(search) === 0) {
    throw new Error(`search after akm index must exit 0 with hits — ${describeOutcome(search)}`);
  }
}

const WORKSPACE_VERBS: Array<{ name: string; call: () => Promise<unknown> }> = [
  { name: "workspace assets.show", call: () => assets.show({ ref: GUIDE }) },
  { name: "workspace assets.related", call: () => assets.related({ ref: GUIDE }) },
  { name: "workspace assets.search", call: () => assets.search({ q: "deploy" }) },
  { name: "workspace documents.readSource", call: () => documents.readSource({ ref: GUIDE }) },
];

async function checkWorkspace(call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (err) {
    if (err instanceof AkmError) return;
    throw new Error(`raw ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`);
  }
}

// ── harness ───────────────────────────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const before = { ...process.env };
  storage = withIsolatedAkmStorage();
  for (const key of Object.keys(process.env)) if (process.env[key] !== before[key]) isolatedEnv[key] = process.env[key];
  saveConfig(withDefaultBundle({ semanticSearchMode: "off" }, storage.stashDir));
  fs.writeFileSync(
    path.join(storage.stashDir, `${GUIDE}.md`),
    `---\ndescription: Deployment guide\n---\n\n${GUIDE_BODY}`,
  );
  for (let i = 0; i < 300; i++) {
    const dir = path.join(storage.stashDir, "knowledge", `area-${i % 20}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `note-${i}.md`),
      `---\ndescription: Deploy note ${i}\n---\n\n# Note ${i}\n\nDeploy step ${i}: ${"check the rollout and the rollback plan. ".repeat(20)}\n`,
    );
  }
  fragmentId = splitMarkdownFragments(GUIDE_BODY)[0]?.fragmentId ?? "";
  const built = await cli("index", "--format=json");
  if (built.code !== 0) throw new Error(`baseline index failed: ${describeOutcome(built)}`);
  const fb = await cli("feedback", GUIDE, "--positive", "--format=json");
  if (fb.code !== 0) throw new Error(`baseline feedback failed: ${describeOutcome(fb)}`);
  editIndex("PRAGMA wal_checkpoint(TRUNCATE);");
  editSqlite(statePath(), "PRAGMA wal_checkpoint(TRUNCATE);");
  template = path.join(storage.root, "template");
  fs.mkdirSync(template);
  fs.copyFileSync(indexPath(), path.join(template, "index.db"));
  fs.copyFileSync(statePath(), path.join(template, "state.db"));
  // Hand the env back: the harness tripwire flags a leak between tests, so each test re-applies it (`inSandbox`).
  for (const key of Object.keys(isolatedEnv)) {
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  }
});

afterAll(() => withEnv(isolatedEnv, async () => storage.cleanup()));

/** A pristine pair of databases under the isolated env, then the test body. */
function inSandbox(body: () => Promise<void>): () => Promise<void> {
  return () =>
    withEnv(isolatedEnv, async () => {
      removeDb(indexPath());
      removeDb(statePath());
      fs.rmSync(getIndexRebuildLockPath(), { force: true });
      fs.copyFileSync(path.join(template, "index.db"), indexPath());
      fs.copyFileSync(path.join(template, "state.db"), statePath());
      try {
        await body();
      } finally {
        sleeper?.kill();
        sleeper = undefined;
      }
    });
}

for (const state of STATES) {
  describe(state.name, () => {
    for (const verb of CLI_VERBS) {
      test(
        `${state.name} x ${verb.name}`,
        inSandbox(async () => {
          state.build();
          await checkCli(state, verb);
        }),
        60_000,
      );
    }
    test(
      `${state.name} x health`,
      inSandbox(async () => {
        state.build();
        await checkHealth(state);
      }),
      60_000,
    );
    for (const verb of WORKSPACE_VERBS) {
      test(
        `${state.name} x ${verb.name}`,
        inSandbox(async () => {
          state.build();
          await checkWorkspace(verb.call);
        }),
        60_000,
      );
    }
    if (state.regenerable) {
      test(
        `${state.name} x index recovers`,
        inSandbox(async () => {
          state.build();
          await checkIndexRecovers();
        }),
        60_000,
      );
    }
  });
}
