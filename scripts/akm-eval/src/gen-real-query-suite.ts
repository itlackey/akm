#!/usr/bin/env bun
/**
 * gen-real-query-suite — mine `state.db` usage_events into an akm-eval
 * retrieval suite that reflects what users ACTUALLY search for.
 *
 * For each distinct meaningful search/curate query, the generator derives
 * `mustIncludeRefs` = the refs the user subsequently ENGAGED with for that
 * query (show / curate / positive-feedback within a short window),
 * preserving exact current-grammar bundle identity. The emitted files are ordinary
 * `type: "retrieval"` EvalCase JSON consumed by the existing runner.
 *
 * This is the CORPUS-QUALITY BENCHMARK: it measures whether retrieval finds
 * the things real users went on to use. Re-running it over time, and
 * comparing the same suite across eval runs, is the "did the stash get
 * better or worse" signal that the proactive-verdict runner consumes as
 * metric (a).
 *
 * READ-ONLY against state.db telemetry and the index.db entries catalog.
 *
 * Usage:
 *   bun run scripts/akm-eval/src/gen-real-query-suite.ts \
 *     [--state-db <path>]              (default: <dataDir>/state.db)
 *     [--index-db <path>]              (default: <dataDir>/index.db; entries only)
 *     [--out-suite <name>]             (default: real-query)
 *     [--cases-root <path>]            (default: scripts/akm-eval/cases)
 *     [--max-cases <n>]                (default: 150)
 *     [--window-min <minutes>]         engagement window after a query (default: 30)
 *     [--min-query-len <chars>]        drop shorter queries (default: 3)
 *     [--min-engaged <n>]              require >= n derived refs (default: 1)
 *     [--top-k <n>]                    topK per emitted retrieval case (default: 10)
 *     [--format json|md]               manifest format on stdout (default: md)
 */

import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./sources/paths";
import { normalizeRef } from "./lib/ref-normalize";

interface CliOptions {
  stateDb: string;
  indexDb: string;
  outSuite: string;
  casesRoot: string;
  maxCases: number;
  windowMin: number;
  minQueryLen: number;
  minEngaged: number;
  topK: number;
  format: "json" | "md";
}

interface UsageRow {
  id: number;
  eventType: string;
  query: string | null;
  entryRef: string | null;
  signal: string | null;
  metadata: string | null;
  source: string | null;
  createdAt: string;
}

interface QueryCandidate {
  query: string;
  /** How many times the query was searched/curated. */
  queryCount: number;
  /** normalised ref -> engagement weight */
  engaged: Map<string, number>;
  firstSeen: string;
  lastSeen: string;
}

interface DropRecord {
  query: string;
  reason: string;
  queryCount: number;
  engagedCount: number;
}

interface RealQueryManifest {
  schemaVersion: 1;
  generatedAt: string;
  stateDb: string;
  indexDb: string;
  suite: string;
  suiteDir: string;
  params: {
    maxCases: number;
    windowMin: number;
    minQueryLen: number;
    minEngaged: number;
    topK: number;
  };
  emittedCases: number;
  droppedTotal: number;
  dropByReason: Record<string, number>;
  sampleDrops: DropRecord[];
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    stateDb: path.join(resolveDataDir(), "state.db"),
    indexDb: path.join(resolveDataDir(), "index.db"),
    outSuite: "real-query",
    casesRoot: path.resolve(path.join(import.meta.dir, "..", "cases")),
    maxCases: 150,
    windowMin: 30,
    minQueryLen: 3,
    minEngaged: 1,
    topK: 10,
    format: "md",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--state-db": opts.stateDb = path.resolve(next()); break;
      case "--index-db": opts.indexDb = path.resolve(next()); break;
      case "--out-suite": opts.outSuite = next(); break;
      case "--cases-root": opts.casesRoot = path.resolve(next()); break;
      case "--max-cases": opts.maxCases = Number(next()); break;
      case "--window-min": opts.windowMin = Number(next()); break;
      case "--min-query-len": opts.minQueryLen = Number(next()); break;
      case "--min-engaged": opts.minEngaged = Number(next()); break;
      case "--top-k": opts.topK = Number(next()); break;
      case "--format": {
        const v = next();
        if (v !== "json" && v !== "md") throw new Error("--format must be json|md");
        opts.format = v;
        break;
      }
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write(`gen-real-query-suite — mine usage_events into a retrieval suite

Usage:
  bun run scripts/akm-eval/src/gen-real-query-suite.ts [options]

Options:
  --state-db <path>     state.db path containing usage_events (default: <dataDir>/state.db).
  --index-db <path>     index.db entries catalog (default: <dataDir>/index.db).
  --out-suite <name>    Suite directory name (default: real-query).
  --cases-root <path>   Cases root (default: scripts/akm-eval/cases).
  --max-cases <n>       Cap emitted cases (default: 150).
  --window-min <min>    Engagement window after each query (default: 30).
  --min-query-len <n>   Drop shorter queries (default: 3).
  --min-engaged <n>     Require >= n derived refs (default: 1).
  --top-k <n>           topK per emitted case (default: 10).
  --format json|md      Manifest format on stdout (default: md).
`);
}

/**
 * Engagement event types that signal "the user used this ref". `curate` pulls
 * a batch into context; `show` is an explicit read; positive `feedback` is an endorsement.
 * Weights bias the ranking but every type above zero counts as engagement.
 */
const ENGAGEMENT_WEIGHTS: Record<string, number> = {
  curate: 2,
  feedback: 3, // positive only — negative is filtered out below
  show: 1,
};

/** Queries that are noise rather than genuine retrieval intent. */
function isNoiseQuery(q: string, minLen: number): string | null {
  const t = q.trim();
  if (t.length < minLen) return "too-short";
  if (/^[.\-_/\s]+$/.test(t)) return "punctuation-only";
  if (/^z{3,}|nonexistent/i.test(t)) return "synthetic-probe";
  // Extremely long free-text prompts are tasks, not retrieval queries.
  if (t.length > 160) return "free-text-prompt";
  return null;
}

function extractCurateRefs(metadata: string | null): string[] {
  if (!metadata) return [];
  try {
    const m = JSON.parse(metadata) as { itemRefs?: unknown };
    if (Array.isArray(m.itemRefs)) {
      return m.itemRefs.filter((r): r is string => typeof r === "string");
    }
  } catch {
    // ignore malformed metadata
  }
  return [];
}

function mineCandidates(db: Database, currentRefs: Set<string>, opts: CliOptions): {
  candidates: QueryCandidate[];
  drops: DropRecord[];
} {
  // Pull the full event stream ordered by time so we can window each query's
  // subsequent engagement events. Bounded by the table size (read-only).
  const rows = db
    .query(
      `SELECT id, event_type, query, entry_ref, signal, metadata, source, created_at
       FROM usage_events
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as Array<{
      id: number;
      event_type: string;
      query: string | null;
      entry_ref: string | null;
      signal: string | null;
      metadata: string | null;
      source: string | null;
      created_at: string;
    }>;

  const events: UsageRow[] = rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    query: r.query,
    entryRef: r.entry_ref,
    signal: r.signal,
    metadata: r.metadata,
    source: r.source,
    createdAt: r.created_at,
  }));

  const windowMs = opts.windowMin * 60_000;

  // For each query string, collect every engaged ref that occurred within the
  // window AFTER any occurrence of that query. We treat the query string as
  // the join key (the index does not thread a session id through
  // usage_events), windowing on time to keep the association tight.
  const byQuery = new Map<string, QueryCandidate>();

  // Pre-index engagement events by epoch for windowed lookup.
  const engagementEvents = events.filter((e) => {
    if (e.source !== "user") return false;
    if (e.eventType === "feedback") return e.signal === "positive";
    return ENGAGEMENT_WEIGHTS[e.eventType] !== undefined;
  });

  const toEpoch = (s: string): number => {
    // created_at is "YYYY-MM-DD HH:MM:SS" (UTC, no tz). Normalise to ISO.
    const iso = s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
  };

  // Sort engagement events by epoch once for binary-search-free linear scan
  // per query occurrence (n is modest: few thousand events).
  const engSorted = engagementEvents
    .map((e) => ({ e, t: toEpoch(e.createdAt) }))
    .sort((a, b) => a.t - b.t);

  for (const ev of events) {
    if (ev.eventType !== "search" && ev.eventType !== "curate") continue;
    if (ev.source !== "user" || ev.entryRef !== null) continue;
    const q = ev.query?.trim();
    if (!q) continue;
    const tQuery = toEpoch(ev.createdAt);

    let cand = byQuery.get(q);
    if (!cand) {
      cand = {
        query: q,
        queryCount: 0,
        engaged: new Map(),
        firstSeen: ev.createdAt,
        lastSeen: ev.createdAt,
      };
      byQuery.set(q, cand);
    }
    cand.queryCount += 1;
    if (ev.createdAt < cand.firstSeen) cand.firstSeen = ev.createdAt;
    if (ev.createdAt > cand.lastSeen) cand.lastSeen = ev.createdAt;

    // A curate event carries its picked refs inline in metadata — those are
    // the strongest possible engagement signal for that exact query.
    if (ev.eventType === "curate") {
      for (const raw of extractCurateRefs(ev.metadata)) {
        const norm = normalizeRef(raw);
        if (!norm || !currentRefs.has(norm)) continue;
        cand.engaged.set(norm, (cand.engaged.get(norm) ?? 0) + ENGAGEMENT_WEIGHTS.curate);
      }
    }

    // Windowed downstream engagement: any show/curate/positive-feedback
    // strictly after the query and within its window.
    for (const { e, t } of engSorted) {
      if (t < tQuery) continue;
      if (t > tQuery + windowMs) break;
      if (t === tQuery && e.id <= ev.id) continue;
      const refs: string[] = [];
      if (e.entryRef) refs.push(e.entryRef);
      if (e.eventType === "curate") refs.push(...extractCurateRefs(e.metadata));
      for (const raw of refs) {
        const norm = normalizeRef(raw);
        if (!norm || !currentRefs.has(norm)) continue;
        const w = ENGAGEMENT_WEIGHTS[e.eventType] ?? 0;
        cand.engaged.set(norm, (cand.engaged.get(norm) ?? 0) + w);
      }
    }
  }

  const drops: DropRecord[] = [];
  const kept: QueryCandidate[] = [];
  for (const cand of byQuery.values()) {
    const noise = isNoiseQuery(cand.query, opts.minQueryLen);
    if (noise) {
      drops.push({ query: cand.query, reason: noise, queryCount: cand.queryCount, engagedCount: cand.engaged.size });
      continue;
    }
    if (cand.engaged.size < opts.minEngaged) {
      drops.push({
        query: cand.query,
        reason: "no-engaged-refs",
        queryCount: cand.queryCount,
        engagedCount: cand.engaged.size,
      });
      continue;
    }
    kept.push(cand);
  }

  // Rank by a signal score: query frequency × engagement breadth/weight. We
  // want high-traffic queries that have clear engagement targets.
  const score = (c: QueryCandidate): number => {
    let engWeight = 0;
    for (const w of c.engaged.values()) engWeight += w;
    return c.queryCount * Math.log2(1 + engWeight);
  };
  kept.sort((a, b) => score(b) - score(a));

  if (kept.length > opts.maxCases) {
    for (const c of kept.slice(opts.maxCases)) {
      drops.push({
        query: c.query,
        reason: "below-max-cases-cutoff",
        queryCount: c.queryCount,
        engagedCount: c.engaged.size,
      });
    }
  }

  return { candidates: kept.slice(0, opts.maxCases), drops };
}

function slugify(q: string, idx: number): string {
  const base = q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `rq-${String(idx).padStart(3, "0")}-${base || "query"}`;
}

function buildCase(cand: QueryCandidate, idx: number, topK: number, suite: string) {
  // Take the top engaged refs by weight as mustIncludeRefs. We cap at 5 so a
  // single noisy query can't demand the entire result set. Emit the exact
  // current-grammar form. Bundle identity must not collapse when two
  // installed bundles expose the same conceptId.
  const ranked = [...cand.engaged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const mustIncludeRefs = ranked.map(([ref]) => ref);

  return {
    schemaVersion: 1 as const,
    id: slugify(cand.query, idx),
    suite,
    type: "retrieval" as const,
    description: `Real user query (${cand.queryCount}× searched; ${cand.engaged.size} engaged refs). Retrieval should surface what users went on to use.`,
    input: {
      query: cand.query,
      topK,
    },
    expected: {
      // Soft expectation: at least the strongest engaged ref should surface.
      mustIncludeRefs,
      minHits: 1,
    },
    scoring: {
      deterministic: true,
      // Weight ref-recall heavily — this suite is about whether retrieval
      // finds the *right* assets, not just any hit. minHits guards against
      // empty result sets.
      weights: {
        mustIncludeRefs: 0.8,
        minHits: 0.2,
      },
      // Pass threshold is deliberately low (0.2): a single engaged ref
      // surfacing among many is a win, and we care about the *aggregate*
      // score trend across runs more than per-case pass/fail.
      passThreshold: 0.2,
    },
    requires: { minAkmVersion: "0.8.0" },
    tags: ["retrieval", "real-query", "corpus-quality"],
    // Provenance for audit — not consumed by the runner.
    _provenance: {
      queryCount: cand.queryCount,
      engagedRefCount: cand.engaged.size,
      firstSeen: cand.firstSeen,
      lastSeen: cand.lastSeen,
      topEngagedRefs: ranked.map(([ref, w]) => ({ ref, weight: w })),
    },
  };
}

function readGenerationManifest(manifestPath: string): RealQueryManifest {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RealQueryManifest;
  if (manifest.schemaVersion !== 1 || typeof manifest.suite !== "string" || !Number.isSafeInteger(manifest.emittedCases)) {
    throw new Error(`invalid real-query generation manifest: ${manifestPath}`);
  }
  return manifest;
}

function recoverInterruptedPublication(
  publicationDir: string,
  suiteDir: string,
  manifestPath: string,
): RealQueryManifest | undefined {
  if (!fs.existsSync(publicationDir)) return undefined;
  const stagingSuite = path.join(publicationDir, "suite");
  const stagingManifest = path.join(publicationDir, "manifest.json");
  const suitePublished = fs.existsSync(suiteDir);
  const manifestPublished = fs.existsSync(manifestPath);
  const suiteStaged = fs.existsSync(stagingSuite);
  const manifestStaged = fs.existsSync(stagingManifest);

  if (manifestPublished && !suitePublished) {
    throw new Error(`conflicting real-query publication state at ${publicationDir}`);
  }
  if (!manifestStaged && !manifestPublished) {
    if (suitePublished) throw new Error(`incomplete real-query publication at ${publicationDir}`);
    fs.rmSync(publicationDir, { recursive: true, force: true });
    return undefined;
  }
  if ((suitePublished && suiteStaged) || (manifestPublished && manifestStaged)) {
    throw new Error(`conflicting real-query publication state at ${publicationDir}`);
  }
  const manifest = readGenerationManifest(manifestPublished ? manifestPath : stagingManifest);
  if (manifest.suiteDir !== suiteDir) {
    throw new Error(`real-query publication manifest does not match ${suiteDir}`);
  }
  if (!suitePublished) {
    if (!suiteStaged) throw new Error(`incomplete real-query suite publication at ${publicationDir}`);
    fs.renameSync(stagingSuite, suiteDir);
  }
  if (!manifestPublished) {
    if (!manifestStaged) throw new Error(`incomplete real-query manifest publication at ${publicationDir}`);
    fs.renameSync(stagingManifest, manifestPath);
  }
  fs.rmSync(publicationDir, { recursive: true, force: true });
  return manifest;
}

function printManifest(manifest: RealQueryManifest, format: "json" | "md"): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  const lines: string[] = [];
  lines.push(`# gen-real-query-suite — \`${manifest.suite}\``);
  lines.push("");
  lines.push(`- state.db: \`${manifest.stateDb}\``);
  lines.push(`- index.db entries: \`${manifest.indexDb}\``);
  lines.push(`- suite dir: \`${manifest.suiteDir}\``);
  lines.push(`- emitted cases: **${manifest.emittedCases}** (cap ${manifest.params.maxCases})`);
  lines.push(`- dropped: **${manifest.droppedTotal}**`);
  lines.push("");
  lines.push("## Dropped, by reason");
  lines.push("");
  lines.push("| Reason | Count |");
  lines.push("| --- | ---: |");
  for (const [reason, count] of Object.entries(manifest.dropByReason).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${reason} | ${count} |`);
  }
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function main(): number {
  const opts = parseArgs(process.argv.slice(2));
  const suiteDir = path.join(opts.casesRoot, opts.outSuite);
  const manifestPath = path.join(opts.casesRoot, `${opts.outSuite}.manifest.json`);
  const publicationDir = path.join(opts.casesRoot, `.${path.basename(opts.outSuite)}.publishing`);
  const recovered = recoverInterruptedPublication(publicationDir, suiteDir, manifestPath);
  if (recovered) {
    printManifest(recovered, opts.format);
    process.stderr.write(`[gen-real-query-suite] recovered publication for ${suiteDir} (manifest: ${manifestPath})\n`);
    return 0;
  }
  if (!fs.existsSync(opts.stateDb)) {
    process.stderr.write(`[gen-real-query-suite] state.db not found: ${opts.stateDb}\n`);
    return 2;
  }
  if (!fs.existsSync(opts.indexDb)) {
    process.stderr.write(`[gen-real-query-suite] index.db not found: ${opts.indexDb}\n`);
    return 2;
  }

  const indexDb = new Database(opts.indexDb, { readonly: true });
  const currentRefs = new Set(
    (indexDb.query("SELECT item_ref FROM entries WHERE item_ref IS NOT NULL").all() as Array<{ item_ref: string }>).map(
      (row) => row.item_ref,
    ),
  );
  indexDb.close();

  const db = new Database(opts.stateDb, { readonly: true });
  let candidates: QueryCandidate[];
  let drops: DropRecord[];
  try {
    ({ candidates, drops } = mineCandidates(db, currentRefs, opts));
  } finally {
    db.close();
  }

  if (fs.existsSync(suiteDir) || fs.existsSync(manifestPath)) {
    throw new Error(
      `generated suite already exists: ${fs.existsSync(suiteDir) ? suiteDir : manifestPath}; choose a new --out-suite generation name`,
    );
  }
  fs.mkdirSync(opts.casesRoot, { recursive: true });
  fs.mkdirSync(publicationDir);
  const stagingDir = path.join(publicationDir, "suite");
  const stagingManifest = path.join(publicationDir, "manifest.json");
  fs.mkdirSync(stagingDir);

  let emitted = 0;
  try {
    for (const cand of candidates) {
      const c = buildCase(cand, emitted + 1, opts.topK, opts.outSuite);
      fs.writeFileSync(path.join(stagingDir, `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`);
      emitted += 1;
    }
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  // Drop-reason rollup for the log.
  const dropByReason: Record<string, number> = {};
  for (const d of drops) dropByReason[d.reason] = (dropByReason[d.reason] ?? 0) + 1;

  const manifest: RealQueryManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    stateDb: opts.stateDb,
    indexDb: opts.indexDb,
    suite: opts.outSuite,
    suiteDir,
    params: {
      maxCases: opts.maxCases,
      windowMin: opts.windowMin,
      minQueryLen: opts.minQueryLen,
      minEngaged: opts.minEngaged,
      topK: opts.topK,
    },
    emittedCases: emitted,
    droppedTotal: drops.length,
    dropByReason,
    sampleDrops: drops.slice(0, 20),
  };
  // Write the manifest OUTSIDE the suite dir: the orchestrator's loadCases()
  // greedily parses every *.json under the suite dir as an EvalCase, so a
  // `_manifest.json` sibling would blow up the run. Park it one level up.
  try {
    fs.writeFileSync(stagingManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(stagingDir, suiteDir);
    if (process.env.AKM_TEST_REAL_QUERY_CRASH_AFTER_SUITE_PUBLISH === "1") process.kill(process.pid, "SIGKILL");
    fs.renameSync(stagingManifest, manifestPath);
    fs.rmSync(publicationDir, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(suiteDir)) fs.rmSync(publicationDir, { recursive: true, force: true });
    throw error;
  }

  printManifest(manifest, opts.format);

  process.stderr.write(`[gen-real-query-suite] wrote ${emitted} cases to ${suiteDir} (manifest: ${manifestPath})\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`[gen-real-query-suite] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
