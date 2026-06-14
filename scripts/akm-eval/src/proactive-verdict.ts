#!/usr/bin/env bun
/**
 * proactive-verdict — kill-criterion runner for the `akm improve` PROACTIVE
 * lane.
 *
 * Answers one question: is the proactive improvement lane making the stash
 * better, or burning GPU cycles? It compares a TREATMENT cohort (assets the
 * proactive selector touched) against a CONTROL cohort (assets that were
 * "due" for improvement but the proactive lane never picked — a natural
 * control, because the selector rotates a top-N slice per run so treatment
 * and control coexist at any instant). It then emits PASS / FAIL /
 * INCONCLUSIVE with the offending metrics.
 *
 * READ-ONLY: reads index.db (usage_events), state.db (events + proposals),
 * the stored retrieval baseline eval-run, and the pilot treatment files.
 * Writes only its own report under <stash>/.akm/measurement/verdicts/.
 *
 * Metrics:
 *   (a) retrieval-quality delta — rerun (or load latest) of the real-query
 *       suite vs the stored T0 baseline (no regression required).
 *   (b) accept-rate-by-source — proactive vs reactive (reflect signal-delta /
 *       high-retrieval) from the proposals table.
 *   (c) proactive reversion / reject rate.
 *   (d) downstream lift — post-touch positive-feedback rate + retrieval count
 *       on treatment vs control since each was touched.
 *
 * Verdict thresholds are named constants below; each is overridable by flag.
 *
 * Usage:
 *   bun run scripts/akm-eval/src/proactive-verdict.ts \
 *     [--stash <path>] [--index-db <path>] [--state-db <path>] \
 *     [--baseline-run <eval-run-id|latest>]   (retrieval baseline; default: latest real-query run)
 *     [--current-run <eval-run-id|latest>]    (retrieval current; default: same as baseline if only one exists)
 *     [--treatment-file <path>] [--control-file <path>] \
 *     [--min-decided <n>]                      (INCONCLUSIVE below this; default 30)
 *     [--accept-ratio <r>]                     (proactive >= r × reactive; default 0.9)
 *     [--max-reversion <r>]                    (proactive reversion <= r; default 0.15)
 *     [--min-retrieval-delta <d>]              (retrieval delta >= d; default 0.0)
 *     [--format json|md]                       (default md)
 *     [--out <path>]
 */

import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, resolveEvalsRoot, resolveStashDir } from "./sources/paths";
import { loadEvalRunResult, resolveRunDir } from "./sources/eval-runs";
import { normalizeRef } from "./lib/ref-normalize";

// ---------------------------------------------------------------------------
// Verdict thresholds. RATIONALE:
//
//  ACCEPT_RATIO (0.9): the proactive lane is allowed to be slightly worse
//    than the reactive lane (reactive reflect is triggered by a concrete
//    signal-delta / high-retrieval event, so it has a structural quality
//    edge). But if proactive proposals are accepted at < 90% of the reactive
//    rate, the lane is mostly producing noise the curator rejects — that is
//    the "burning cycles" failure mode and should fail.
//
//  MAX_REVERSION (0.15): a promotion that gets reverted is strictly negative —
//    it churned the stash and was then undone. Reactive reversion historically
//    sits well under 15%; allowing proactive up to 15% tolerates early-rollout
//    noise without rewarding a lane that keeps shipping regressions.
//
//  MIN_RETRIEVAL_DELTA (0.0): the corpus-quality benchmark (real-query suite)
//    must not REGRESS. We don't demand a positive delta (improvement may show
//    up in feedback before retrieval), but a negative delta means the proactive
//    edits made it HARDER to find what users use — an immediate kill signal.
//
//  MIN_DECIDED (30): below ~30 decided proposals the accept-rate estimate is
//    too noisy to act on (a single rejection swings it by >3 points). On thin
//    data we return INCONCLUSIVE rather than pass/fail — the pilot has only
//    ~13 proactive promotions, so today's verdict is expected to be
//    INCONCLUSIVE by design.
// ---------------------------------------------------------------------------
const DEFAULT_ACCEPT_RATIO = 0.9;
const DEFAULT_MAX_REVERSION = 0.15;
const DEFAULT_MIN_RETRIEVAL_DELTA = 0.0;
const DEFAULT_MIN_DECIDED = 30;

/** Reactive reflect eligibility sources (the comparison cohort for (b)). */
const REACTIVE_SOURCES = new Set(["signal-delta", "high-retrieval"]);

interface CliOptions {
  stash: string;
  indexDb: string;
  stateDb: string;
  baselineRun?: string;
  currentRun?: string;
  treatmentFile?: string;
  controlFile?: string;
  minDecided: number;
  acceptRatio: number;
  maxReversion: number;
  minRetrievalDelta: number;
  format: "json" | "md";
  out?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const stash = resolveStashDir();
  const opts: CliOptions = {
    stash,
    indexDb: path.join(resolveDataDir(), "index.db"),
    stateDb: path.join(resolveDataDir(), "state.db"),
    minDecided: DEFAULT_MIN_DECIDED,
    acceptRatio: DEFAULT_ACCEPT_RATIO,
    maxReversion: DEFAULT_MAX_REVERSION,
    minRetrievalDelta: DEFAULT_MIN_RETRIEVAL_DELTA,
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
      case "--stash": opts.stash = resolveStashDir(next()); break;
      case "--index-db": opts.indexDb = path.resolve(next()); break;
      case "--state-db": opts.stateDb = path.resolve(next()); break;
      case "--baseline-run": opts.baselineRun = next(); break;
      case "--current-run": opts.currentRun = next(); break;
      case "--treatment-file": opts.treatmentFile = path.resolve(next()); break;
      case "--control-file": opts.controlFile = path.resolve(next()); break;
      case "--min-decided": opts.minDecided = Number(next()); break;
      case "--accept-ratio": opts.acceptRatio = Number(next()); break;
      case "--max-reversion": opts.maxReversion = Number(next()); break;
      case "--min-retrieval-delta": opts.minRetrievalDelta = Number(next()); break;
      case "--format": {
        const v = next();
        if (v !== "json" && v !== "md") throw new Error("--format must be json|md");
        opts.format = v;
        break;
      }
      case "--out": opts.out = path.resolve(next()); break;
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
  process.stdout.write(`akm-eval-proactive-verdict — kill-criterion for the proactive improve lane

Usage:
  bun run scripts/akm-eval/src/proactive-verdict.ts [options]

Options:
  --stash <path>               Stash root (default: \$AKM_STASH_DIR or ~/akm).
  --index-db <path>            index.db (default: <dataDir>/index.db).
  --state-db <path>            state.db (default: <dataDir>/state.db).
  --baseline-run <id|latest>   Retrieval T0 baseline eval-run (default: oldest real-query run).
  --current-run <id|latest>    Retrieval current eval-run (default: latest real-query run).
  --treatment-file <path>      Override proactive-treatment ref list.
  --control-file <path>        Override control ref list.
  --min-decided <n>            INCONCLUSIVE below this many decided proposals (default ${DEFAULT_MIN_DECIDED}).
  --accept-ratio <r>           proactive accept >= r × reactive (default ${DEFAULT_ACCEPT_RATIO}).
  --max-reversion <r>          proactive reversion <= r (default ${DEFAULT_MAX_REVERSION}).
  --min-retrieval-delta <d>    retrieval delta >= d (default ${DEFAULT_MIN_RETRIEVAL_DELTA}).
  --format json|md             Output format (default md).
  --out <path>                 Report output path.
`);
}

type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

interface VerdictReport {
  schemaVersion: 1;
  tool: string;
  generatedAt: string;
  verdict: Verdict;
  breaches: string[];
  recommendation: string;
  thresholds: { acceptRatio: number; maxReversion: number; minRetrievalDelta: number; minDecided: number };
  cohorts: { treatmentRefs: number; controlRefs: number; treatmentSource: string; treatmentFile: string };
  metrics: {
    acceptByCohort: { proactive: AcceptStats; reactive: AcceptStats };
    retrievalQuality: { baselineRunId: string | null; currentRunId: string | null; delta: number | null; note?: string };
    downstreamLift: { treatment: DownstreamLift; control: DownstreamLift };
  };
  dataSources: { indexDb: string; stateDb: string };
}

interface EventRow {
  eventType: string;
  ts: string;
  ref: string | null;
  metadata: Record<string, unknown>;
}

function readEvents(db: Database, types: string[]): EventRow[] {
  const placeholders = types.map(() => "?").join(",");
  const rows = db
    .query(
      `SELECT event_type, ts, ref, metadata_json FROM events
       WHERE event_type IN (${placeholders}) ORDER BY id ASC`,
    )
    .all(...types) as Array<{ event_type: string; ts: string; ref: string | null; metadata_json: string | null }>;
  return rows.map((r) => ({
    eventType: r.event_type,
    ts: r.ts,
    ref: r.ref,
    metadata: safeJson(r.metadata_json),
  }));
}

function safeJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function eligibilityOf(meta: Record<string, unknown>): string | undefined {
  const v = meta.eligibilitySource;
  return typeof v === "string" ? v : undefined;
}

function loadRefFile(p: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const n = normalizeRef(t);
    if (n) out.add(n);
  }
  return out;
}

interface AcceptStats {
  accepted: number;
  rejected: number;
  reverted: number;
  pending: number;
  decided: number;
  acceptRate: number | null;
  reversionRate: number | null;
}

function blankAccept(): AcceptStats {
  return { accepted: 0, rejected: 0, reverted: 0, pending: 0, decided: 0, acceptRate: null, reversionRate: null };
}

function finalizeAccept(s: AcceptStats): AcceptStats {
  s.decided = s.accepted + s.rejected;
  s.acceptRate = s.decided === 0 ? null : s.accepted / s.decided;
  // Reversion is measured against everything that landed (accepted + reverted),
  // since a revert is the undoing of a prior accept.
  const landed = s.accepted + s.reverted;
  s.reversionRate = landed === 0 ? null : s.reverted / landed;
  return s;
}

interface ProposalRow {
  ref: string;
  status: string;
  source: string;
  metadata: Record<string, unknown>;
}

/**
 * Classify proposals into proactive vs reactive cohorts. Prefers the
 * eligibilitySource field on the proposal metadata (the field the sibling
 * agent is adding); falls back to the proactive-treatment ref file when the
 * field is absent (older proposals).
 */
function classifyProposals(
  proposals: ProposalRow[],
  treatmentRefs: Set<string>,
): { proactive: AcceptStats; reactive: AcceptStats; usedFallback: boolean } {
  const proactive = blankAccept();
  const reactive = blankAccept();
  let usedFallback = false;

  const bump = (s: AcceptStats, status: string) => {
    if (status === "accepted") s.accepted += 1;
    else if (status === "rejected") s.rejected += 1;
    else if (status === "reverted") s.reverted += 1;
    else if (status === "pending") s.pending += 1;
  };

  for (const p of proposals) {
    const elig = eligibilityOf(p.metadata);
    let cohort: "proactive" | "reactive" | null = null;
    if (elig === "proactive") cohort = "proactive";
    else if (elig && REACTIVE_SOURCES.has(elig)) cohort = "reactive";
    else {
      // Fallback: match the proposal ref against the pilot treatment file.
      usedFallback = true;
      const norm = normalizeRef(p.ref);
      if (norm && treatmentRefs.has(norm)) cohort = "proactive";
      else if (p.source === "reflect") cohort = "reactive";
    }
    if (cohort === "proactive") bump(proactive, p.status);
    else if (cohort === "reactive") bump(reactive, p.status);
  }

  return { proactive: finalizeAccept(proactive), reactive: finalizeAccept(reactive), usedFallback };
}

/**
 * Build the CONTROL cohort: "due" assets (reflect_invoked never OR last
 * reflect > 30d ago) that the proactive lane did NOT touch. We approximate
 * "due" from state.db reflect_invoked history and exclude any ref in the
 * treatment set.
 */
function buildControlCohort(
  reflectEvents: EventRow[],
  treatmentRefs: Set<string>,
  allKnownRefs: Set<string>,
  now: Date,
): Set<string> {
  const lastReflect = new Map<string, number>();
  for (const e of reflectEvents) {
    if (!e.ref) continue;
    const norm = normalizeRef(e.ref);
    if (!norm) continue;
    const t = Date.parse(e.ts.includes("T") ? e.ts : `${e.ts.replace(" ", "T")}Z`);
    if (Number.isNaN(t)) continue;
    const prev = lastReflect.get(norm) ?? 0;
    if (t > prev) lastReflect.set(norm, t);
  }
  const thirtyDaysAgo = now.getTime() - 30 * 86_400_000;
  const control = new Set<string>();
  for (const ref of allKnownRefs) {
    if (treatmentRefs.has(ref)) continue;
    const last = lastReflect.get(ref);
    if (last === undefined || last < thirtyDaysAgo) control.add(ref);
  }
  return control;
}

interface DownstreamLift {
  cohort: string;
  refCount: number;
  positiveFeedback: number;
  negativeFeedback: number;
  positiveRate: number | null;
  retrievalCount: number;
  retrievalPerRef: number | null;
}

/**
 * Downstream lift since each ref was touched. We use a single anchor time
 * (the earliest treatment-touch timestamp, or 30d ago as a floor) and count
 * post-anchor positive feedback + retrieval engagement on each cohort,
 * normalised per-ref so cohorts of different sizes are comparable.
 */
function downstreamLift(
  usageEvents: Array<{ eventType: string; entryRef: string | null; signal: string | null; metadata: string | null; ts: number }>,
  cohort: Set<string>,
  cohortName: string,
  sinceMs: number,
): DownstreamLift {
  let pos = 0;
  let neg = 0;
  let retrieval = 0;
  for (const e of usageEvents) {
    if (e.ts < sinceMs) continue;
    const refs: string[] = [];
    if (e.entryRef) refs.push(e.entryRef);
    if (e.eventType === "curate" && e.metadata) {
      try {
        const m = JSON.parse(e.metadata) as { itemRefs?: unknown };
        if (Array.isArray(m.itemRefs)) for (const r of m.itemRefs) if (typeof r === "string") refs.push(r);
      } catch { /* ignore */ }
    }
    let inCohort = false;
    for (const raw of refs) {
      const n = normalizeRef(raw);
      if (n && cohort.has(n)) { inCohort = true; break; }
    }
    if (!inCohort) continue;
    if (e.eventType === "feedback") {
      if (e.signal === "positive") pos += 1;
      else if (e.signal === "negative") neg += 1;
    } else if (e.eventType === "search" || e.eventType === "show" || e.eventType === "select" || e.eventType === "curate") {
      retrieval += 1;
    }
  }
  const decided = pos + neg;
  return {
    cohort: cohortName,
    refCount: cohort.size,
    positiveFeedback: pos,
    negativeFeedback: neg,
    positiveRate: decided === 0 ? null : pos / decided,
    retrievalCount: retrieval,
    retrievalPerRef: cohort.size === 0 ? null : retrieval / cohort.size,
  };
}

function fmt(n: number | null): string {
  return n === null ? "n/a" : n.toFixed(3);
}

function main(): number {
  const opts = parseArgs(process.argv.slice(2));
  const now = new Date();

  // ---- Treatment / control ref sets -------------------------------------
  const measurementDir = path.join(opts.stash, ".akm", "measurement");
  const treatmentFile = opts.treatmentFile ?? path.join(measurementDir, "treatment-pilot-2026-06-14.txt");
  const controlOverride = opts.controlFile ? loadRefFile(opts.controlFile) : null;
  const treatmentRefs = loadRefFile(treatmentFile);

  // ---- state.db: proposals + reflect history ----------------------------
  let proposals: ProposalRow[] = [];
  let reflectEvents: EventRow[] = [];
  const stateAvailable = fs.existsSync(opts.stateDb);
  if (stateAvailable) {
    const sdb = new Database(opts.stateDb, { readonly: true });
    try {
      proposals = (
        sdb
          .query(`SELECT ref, status, source, metadata_json FROM proposals`)
          .all() as Array<{ ref: string; status: string; source: string; metadata_json: string | null }>
      ).map((r) => ({ ref: r.ref, status: r.status, source: r.source, metadata: safeJson(r.metadata_json) }));
      reflectEvents = readEvents(sdb, ["reflect_invoked", "distill_invoked", "promoted"]);
    } finally {
      sdb.close();
    }
  }

  const { proactive, reactive, usedFallback } = classifyProposals(proposals, treatmentRefs);

  // ---- index.db: usage events + known refs ------------------------------
  const usageEvents: Array<{ eventType: string; entryRef: string | null; signal: string | null; metadata: string | null; ts: number }> = [];
  const allKnownRefs = new Set<string>();
  const indexAvailable = fs.existsSync(opts.indexDb);
  if (indexAvailable) {
    const idb = new Database(opts.indexDb, { readonly: true });
    try {
      const rows = idb
        .query(`SELECT event_type, entry_ref, signal, metadata, created_at FROM usage_events`)
        .all() as Array<{ event_type: string; entry_ref: string | null; signal: string | null; metadata: string | null; created_at: string }>;
      for (const r of rows) {
        const iso = r.created_at.includes("T") ? r.created_at : `${r.created_at.replace(" ", "T")}Z`;
        const t = Date.parse(iso);
        usageEvents.push({ eventType: r.event_type, entryRef: r.entry_ref, signal: r.signal, metadata: r.metadata, ts: Number.isNaN(t) ? 0 : t });
        if (r.entry_ref) {
          const n = normalizeRef(r.entry_ref);
          if (n) allKnownRefs.add(n);
        }
      }
      // entries catalog gives the full asset universe for control selection.
      const entryRows = idb.query(`SELECT entry_type, entry_key FROM entries`).all() as Array<{ entry_type: string; entry_key: string }>;
      for (const er of entryRows) {
        // entry_key is "<stash_dir>:<type>:<name>" — take the type:name tail.
        const idx = er.entry_key.indexOf(`:${er.entry_type}:`);
        const tail = idx >= 0 ? er.entry_key.slice(idx + 1) : er.entry_key;
        const n = normalizeRef(tail);
        if (n) allKnownRefs.add(n);
      }
    } finally {
      idb.close();
    }
  }

  const controlRefs = controlOverride ?? buildControlCohort(reflectEvents, treatmentRefs, allKnownRefs, now);

  // Downstream lift anchor: 30 days ago (the proactive lane's measurement
  // window). Treatment was touched on/after the baseline tag date.
  const sinceMs = now.getTime() - 30 * 86_400_000;
  const liftTreatment = downstreamLift(usageEvents, treatmentRefs, "treatment", sinceMs);
  const liftControl = downstreamLift(usageEvents, controlRefs, "control", sinceMs);

  // ---- retrieval-quality delta ------------------------------------------
  let retrievalDelta: number | null = null;
  let retrievalBaselineId: string | undefined;
  let retrievalCurrentId: string | undefined;
  let retrievalNote = "";
  const runsRoot = path.join(resolveEvalsRoot(opts.stash), "runs");
  try {
    const realQueryRuns = listRealQueryRuns(runsRoot);
    if (realQueryRuns.length === 0) {
      retrievalNote = "no real-query eval runs found; run gen-real-query-suite + akm-eval-run first";
    } else {
      const baseId = opts.baselineRun ?? realQueryRuns[0];
      const curId = opts.currentRun ?? realQueryRuns[realQueryRuns.length - 1];
      const base = loadEvalRunResult(resolveRunDir(runsRoot, baseId).dir);
      const cur = loadEvalRunResult(resolveRunDir(runsRoot, curId).dir);
      retrievalBaselineId = base.evalRunId;
      retrievalCurrentId = cur.evalRunId;
      retrievalDelta = cur.scores.overall - base.scores.overall;
      if (baseId === curId) {
        retrievalNote = "baseline == current (only one real-query run exists); delta is 0 by construction. Re-run the suite after the proactive period to get a real delta.";
      }
    }
  } catch (err) {
    retrievalNote = `retrieval delta unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }

  // ---- VERDICT ----------------------------------------------------------
  const breaches: string[] = [];
  let verdict: Verdict;

  if (proactive.decided < opts.minDecided) {
    verdict = "INCONCLUSIVE";
  } else {
    const acceptOk =
      proactive.acceptRate !== null &&
      reactive.acceptRate !== null &&
      proactive.acceptRate >= opts.acceptRatio * reactive.acceptRate;
    if (!acceptOk) {
      breaches.push(
        `proactive accept-rate ${fmt(proactive.acceptRate)} < ${opts.acceptRatio} × reactive ${fmt(reactive.acceptRate)} (= ${reactive.acceptRate === null ? "n/a" : (opts.acceptRatio * reactive.acceptRate).toFixed(3)})`,
      );
    }
    const reversionOk = proactive.reversionRate === null || proactive.reversionRate <= opts.maxReversion;
    if (!reversionOk) {
      breaches.push(`proactive reversion-rate ${fmt(proactive.reversionRate)} > ${opts.maxReversion}`);
    }
    const retrievalOk = retrievalDelta === null || retrievalDelta >= opts.minRetrievalDelta;
    if (!retrievalOk) {
      breaches.push(`retrieval-quality delta ${fmt(retrievalDelta)} < ${opts.minRetrievalDelta} (corpus regressed)`);
    }
    verdict = breaches.length === 0 ? "PASS" : "FAIL";
  }

  const report: VerdictReport = {
    schemaVersion: 1,
    tool: "akm-eval-proactive-verdict",
    generatedAt: now.toISOString(),
    verdict,
    breaches,
    recommendation:
      verdict === "FAIL"
        ? "RECOMMEND DISABLE akm-improve-proactive-weekly"
        : verdict === "INCONCLUSIVE"
          ? `INCONCLUSIVE: only ${proactive.decided} decided proactive proposals (need >= ${opts.minDecided}). Keep the lane running and re-evaluate after more proactive promotions accumulate.`
          : "KEEP akm-improve-proactive-weekly enabled",
    thresholds: {
      acceptRatio: opts.acceptRatio,
      maxReversion: opts.maxReversion,
      minRetrievalDelta: opts.minRetrievalDelta,
      minDecided: opts.minDecided,
    },
    cohorts: {
      treatmentRefs: treatmentRefs.size,
      controlRefs: controlRefs.size,
      treatmentSource: usedFallback ? "pilot-file-fallback (eligibilitySource absent on some/all proposals)" : "eligibilitySource",
      treatmentFile,
    },
    metrics: {
      acceptByCohort: { proactive, reactive },
      retrievalQuality: {
        baselineRunId: retrievalBaselineId ?? null,
        currentRunId: retrievalCurrentId ?? null,
        delta: retrievalDelta,
        note: retrievalNote || undefined,
      },
      downstreamLift: { treatment: liftTreatment, control: liftControl },
    },
    dataSources: {
      indexDb: indexAvailable ? opts.indexDb : `MISSING: ${opts.indexDb}`,
      stateDb: stateAvailable ? opts.stateDb : `MISSING: ${opts.stateDb}`,
    },
  };

  const outDir = path.join(measurementDir, "verdicts");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const jsonPath = opts.out ?? path.join(outDir, `verdict-${stamp}.json`);
  const mdPath = jsonPath.replace(/\.json$/, ".md");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, renderMarkdown(report));

  if (opts.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderMarkdown(report));
  }
  process.stderr.write(`[akm-eval-proactive-verdict] wrote ${jsonPath} and ${mdPath}\n`);

  // Exit code mirrors the verdict so CI/cron can gate: 0 PASS, 1 FAIL,
  // 3 INCONCLUSIVE (distinct from the toolkit's 2 = error).
  return verdict === "PASS" ? 0 : verdict === "FAIL" ? 1 : 3;
}

function listRealQueryRuns(runsRoot: string): string[] {
  if (!fs.existsSync(runsRoot)) return [];
  const ids: string[] = [];
  for (const e of fs.readdirSync(runsRoot, { withFileTypes: true })) {
    if (e.name === "latest" || !e.isDirectory()) continue;
    const resultPath = path.join(runsRoot, e.name, "eval-result.json");
    if (!fs.existsSync(resultPath)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { suite?: string };
      if (r.suite === "real-query") ids.push(e.name);
    } catch { /* ignore */ }
  }
  ids.sort();
  return ids;
}

function renderMarkdown(r: VerdictReport): string {
  const m = r.metrics;
  const pa = m.acceptByCohort.proactive;
  const re = m.acceptByCohort.reactive;
  const lt = m.downstreamLift.treatment;
  const lc = m.downstreamLift.control;
  const lines: string[] = [];
  lines.push(`# akm-eval-proactive-verdict — ${r.verdict}`);
  lines.push("");
  lines.push(`**Generated:** ${r.generatedAt}`);
  lines.push("");
  lines.push(`> ${r.recommendation}`);
  lines.push("");
  if (r.breaches.length > 0) {
    lines.push("## Breaches");
    lines.push("");
    for (const b of r.breaches) lines.push(`- ${b}`);
    lines.push("");
  }
  lines.push("## Cohorts");
  lines.push("");
  lines.push(`- treatment refs: **${r.cohorts.treatmentRefs}** (source: ${r.cohorts.treatmentSource})`);
  lines.push(`- control refs: **${r.cohorts.controlRefs}** (due, never/>30d reflected, not proactively touched)`);
  lines.push("");
  lines.push("## (b) Accept-rate by source");
  lines.push("");
  lines.push("| Cohort | accepted | rejected | reverted | pending | decided | accept-rate | reversion-rate |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  lines.push(`| proactive | ${pa.accepted} | ${pa.rejected} | ${pa.reverted} | ${pa.pending} | ${pa.decided} | ${fmt(pa.acceptRate)} | ${fmt(pa.reversionRate)} |`);
  lines.push(`| reactive | ${re.accepted} | ${re.rejected} | ${re.reverted} | ${re.pending} | ${re.decided} | ${fmt(re.acceptRate)} | ${fmt(re.reversionRate)} |`);
  lines.push("");
  lines.push("## (a) Retrieval-quality delta (real-query suite)");
  lines.push("");
  lines.push(`- baseline run: \`${m.retrievalQuality.baselineRunId ?? "—"}\``);
  lines.push(`- current run: \`${m.retrievalQuality.currentRunId ?? "—"}\``);
  lines.push(`- delta: **${fmt(m.retrievalQuality.delta)}**`);
  if (m.retrievalQuality.note) lines.push(`- note: ${m.retrievalQuality.note}`);
  lines.push("");
  lines.push("## (d) Downstream lift (since 30d)");
  lines.push("");
  lines.push("| Cohort | refs | +fb | -fb | +rate | retrievals | retr/ref |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  lines.push(`| treatment | ${lt.refCount} | ${lt.positiveFeedback} | ${lt.negativeFeedback} | ${fmt(lt.positiveRate)} | ${lt.retrievalCount} | ${fmt(lt.retrievalPerRef)} |`);
  lines.push(`| control | ${lc.refCount} | ${lc.positiveFeedback} | ${lc.negativeFeedback} | ${fmt(lc.positiveRate)} | ${lc.retrievalCount} | ${fmt(lc.retrievalPerRef)} |`);
  lines.push("");
  lines.push("## Thresholds");
  lines.push("");
  lines.push(`- accept-ratio: proactive >= ${r.thresholds.acceptRatio} × reactive`);
  lines.push(`- max reversion: ${r.thresholds.maxReversion}`);
  lines.push(`- min retrieval delta: ${r.thresholds.minRetrievalDelta}`);
  lines.push(`- min decided (INCONCLUSIVE floor): ${r.thresholds.minDecided}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`[akm-eval-proactive-verdict] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
