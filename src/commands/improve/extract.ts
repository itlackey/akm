// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm extract` — read native session logs (claude, opencode) through the
 * session-log harnesses, pre-filter the noise, and ask the model for
 * memory/lesson/knowledge candidates the agent did not already save. Each
 * candidate is queued as a proposal (`source: "extract"`), never written.
 *
 * A session is skipped with zero LLM calls when its content hash is unchanged
 * since the last extraction, when it is nearly empty, or when the optional
 * heuristic triage scores it below threshold.
 */

import fs from "node:fs";
import path from "node:path";
import { assembleAsset } from "../../core/asset/asset-serialize";
import { resolveStashDir, timestampForFilename } from "../../core/common";
import type { AkmConfig, ImproveProcessConfig, ImproveProfileConfig, LlmProfileConfig } from "../../core/config/config";
import { getImproveProcessConfig, loadConfig } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { appendEvent, type EventsContext } from "../../core/events";
import {
  createLockPayload,
  type LockOwnership,
  probeLock,
  reclaimStaleLock,
  releaseLock,
  tryAcquireLockSync,
} from "../../core/file-lock";
import type { AkmExtractResult, ExtractedSessionResult } from "../../core/improve-types";
import { EXTRACT_INFRASTRUCTURE_SKIP_REASONS } from "../../core/improve-types";
import { redactErrorBody } from "../../core/redaction";
import { resolveStashStandards } from "../../core/standards/resolve-stash-standards";
import { resolveTypeConventions, typeConventionRef } from "../../core/standards/resolve-type-conventions";
import { getStateDbPath, openStateDatabase } from "../../core/state-db";
import { runStructured } from "../../core/structured";
import { repairTruncatedDescription } from "../../core/text-truncation";
import { DURATION_UNITS, parseDuration } from "../../core/time";
import { warn, warnVerbose } from "../../core/warn";
import type { LoweringNotice } from "../../execution/resolved-request";
import { indexWrittenAssets } from "../../indexer/index-written-assets";
import { assertRunnerCredentials } from "../../integrations/agent/runner-dispatch";
import { getAvailableHarnesses } from "../../integrations/session-logs";
import { preFilterSession } from "../../integrations/session-logs/pre-filter";
import type { SessionData, SessionLogHarness, SessionRef, SessionSummary } from "../../integrations/session-logs/types";
import { type ChatMessage, isJsonSchemaKnownUnsupported } from "../../llm/client";
import type { Database } from "../../storage/database";
import {
  type ExtractedSessionRow,
  getExtractedSessionsMap,
  getLastExtractRunAt,
  shouldSkipAlreadyExtractedSession,
  upsertExtractedSession,
} from "../../storage/repositories/extract-sessions-repository";
import { openSqliteReadSnapshot } from "../../storage/sqlite-read-snapshot";
import type { ProposalsContext } from "../proposal/repository";
import { contentHash } from "./content-hash";
import { resolveImproveLlmExecution } from "./execution";
import {
  buildExtractPrompt,
  EXTRACT_JSON_SCHEMA,
  type ExtractCandidate,
  type ExtractPayload,
  parseExtractPayload,
} from "./extract-prompt";
import { cloneAndFreeze, resolveImproveStrategy, resolveProcessEnabled } from "./improve-strategies";
import { isLedgerBlocked, ledgerKey, loadLedgerSnapshot } from "./ledger";
import {
  buildSessionSummaryPrompt,
  parseSessionSummary,
  SESSION_SUMMARY_JSON_SCHEMA,
  type SessionSummaryGenerator,
  sessionMeetsDurationGate,
  writeSessionAsset,
} from "./session-asset";
import { callStage, type LlmRunner, mintProposal, noticeSet } from "./stage";

export type { AkmExtractResult, ExtractedSessionResult } from "../../core/improve-types";

/** Minimum session duration (minutes) for writing a session asset. */
const DEFAULT_MIN_SESSION_DURATION_MINUTES = 5;
/** Raw session size (chars) below which the LLM call is skipped; only truly empty sessions are safe to skip. */
const DEFAULT_MIN_CONTENT_CHARS = 10;
/** New sessions LLM-processed per run (`processes.extract.maxSessionsPerRun`, 0 disables); the rest wait for later runs. */
const DEFAULT_MAX_SESSIONS_PER_RUN = 25;
/**
 * Without an explicit window, discovery looks back to the last extract run for
 * the harness (a host that was off still finds sessions that ended meanwhile),
 * but never less than 48h. The content-hash ledger makes the overlap free.
 */
const DEFAULT_SINCE_FLOOR_MS = 48 * 60 * 60 * 1000;
/** A per-session lock older than this belongs to a crashed holder. */
const EXTRACT_SESSION_LOCK_STALE_MS = 5 * 60 * 1000;

function resolveDefaultSinceMs(
  harnessName: string,
  now: number,
  opts: { stateDb?: Database; stateDbPath?: string; skipTracking?: boolean },
): number {
  const floor = now - DEFAULT_SINCE_FLOOR_MS;
  if (opts.skipTracking) return floor;
  let snapshot: Database | undefined;
  try {
    let db = opts.stateDb;
    if (!db) {
      snapshot = openSqliteReadSnapshot(opts.stateDbPath ?? getStateDbPath());
      db = snapshot;
    }
    if (!db) return floor;
    const lastRun = getLastExtractRunAt(db, harnessName);
    return lastRun != null ? Math.min(lastRun, floor) : floor;
  } catch {
    return floor;
  } finally {
    snapshot?.close();
  }
}

function extractSessionLockPath(harness: string, sessionId: string, stateDbPath: string): string {
  const safe = `${harness}-${sessionId}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(path.dirname(stateDbPath), "extract-locks", `extract-${safe}.lock`);
}

function extractSessionLockIsUnavailable(harness: string, sessionId: string, stateDbPath: string): boolean {
  const probe = probeLock(extractSessionLockPath(harness, sessionId, stateDbPath), {
    staleAfterMs: EXTRACT_SESSION_LOCK_STALE_MS,
  });
  return probe.state === "held" || probe.state === "inaccessible";
}

/**
 * Claim a session so a concurrent extract (a session-end hook racing the
 * hourly improve run) cannot process it twice. A stale lock is reclaimed; a
 * filesystem error proceeds, so locking never blocks extraction outright.
 */
function acquireExtractSessionLock(lockPath: string): { proceed: boolean; ownership?: LockOwnership } {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let ownership = tryAcquireLockSync(lockPath, createLockPayload());
    if (ownership) return { proceed: true, ownership };
    const probe = probeLock(lockPath, { staleAfterMs: EXTRACT_SESSION_LOCK_STALE_MS });
    if (probe.state === "held") return { proceed: false };
    if (probe.state === "stale" && !reclaimStaleLock(lockPath, probe)) return { proceed: false };
    ownership = tryAcquireLockSync(lockPath, createLockPayload());
    return ownership ? { proceed: true, ownership } : { proceed: false };
  } catch {
    return { proceed: true };
  }
}

export interface AkmExtractOptions {
  /** Harness name (e.g. "claude", "opencode"). */
  type: string;
  /** Override the harness's session-discovery location. */
  location?: string;
  /** Process exactly this session. */
  sessionId?: string;
  /** Discovery cutoff: an ISO timestamp or a duration (`24h`, `7d`, `30m`). */
  since?: string;
  dryRun?: boolean;
  stashDir?: string;
  config?: AkmConfig;
  /** Runner to use when no complete standalone plan is supplied. */
  llmRunner?: ExtractLlmRunner;
  /** Complete standalone plan, resolved once at the CLI boundary. */
  resolvedPlan?: ResolvedExtractPlan;
  /** Test seam: harness registry. */
  harnesses?: SessionLogHarness[];
  /** Test seam: transport override. */
  chat?: (
    config: LlmProfileConfig,
    messages: ChatMessage[],
    options?: { timeoutMs?: number | null; responseSchema?: Record<string, unknown>; signal?: AbortSignal },
  ) => Promise<string>;
  /** Test seam: proposal clock / id. */
  ctx?: ProposalsContext;
  /** The improve run's events context. */
  eventsCtx?: EventsContext;
  sourceRun?: string;
  /** The active improve profile (its extract toggle gates extract as an improve stage only). */
  improveProfile?: ImproveProfileConfig;
  /** Per-call LLM timeout (ms); null disables it. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
  /** Re-process sessions state.db says were already extracted. */
  force?: boolean;
  /** Test seam: no state.db tracking at all. */
  skipTracking?: boolean;
  /** Test seam: state.db connection. */
  stateDb?: Database;
  /** Explicit state.db path (improve pins its boundary-resolved path). */
  stateDbPath?: string;
  /** Test seam: session-summary generator. */
  generateSessionSummary?: SessionSummaryGenerator;
}

export interface ResolvedExtractPlan {
  strategy: string;
  engine: string;
  enabled: boolean;
  process: Readonly<ImproveProcessConfig>;
  runner: Readonly<ExtractLlmRunner> | null;
  timeoutMs: number | null;
  embeddingConfig: Readonly<AkmConfig["embedding"]>;
  notices?: readonly Readonly<LoweringNotice>[];
}

type ExtractLlmRunner = LlmRunner;

/** Resolve standalone extract selection once, before discovery, auto iteration or watch startup. */
export function resolveStandaloneExtractPlan(
  config: AkmConfig,
  selection: { engine?: string; strategy?: string; timeoutMs?: number | null },
): ResolvedExtractPlan {
  if (selection.engine && selection.strategy) {
    throw new UsageError("--engine and --strategy are mutually exclusive. Pick one.", "INVALID_FLAG_VALUE");
  }
  const selected = resolveImproveStrategy(selection.strategy, config);
  const process = cloneAndFreeze(getImproveProcessConfig("extract", selected.config) ?? {});
  const resolved = resolveImproveLlmExecution({
    config,
    profile: selected.config,
    process,
    current: {
      ...(selection.engine ? { engine: selection.engine } : {}),
      ...(Object.hasOwn(selection, "timeoutMs") ? { timeoutMs: selection.timeoutMs ?? null } : {}),
    },
    processName: "extract",
  });
  if (!resolved) {
    throw new ConfigError(
      "No LLM engine configured for extract. Set defaults.llmEngine, pass --engine, or select an improve strategy with processes.extract.engine.",
      "LLM_NOT_CONFIGURED",
    );
  }
  const runner = resolved.runner;
  return Object.freeze({
    strategy: selected.name,
    engine: runner.engine as string,
    // An explicit `akm extract` runs regardless of the strategy's improve-stage toggle.
    enabled: true,
    process,
    runner: cloneAndFreeze(runner),
    timeoutMs: Object.hasOwn(runner, "timeoutMs") ? (runner.timeoutMs ?? null) : 600_000,
    embeddingConfig: cloneAndFreeze(config.embedding),
    ...(resolved.notices.length > 0 ? { notices: cloneAndFreeze(resolved.notices) } : {}),
  });
}

/** A session result before the run's engine is stamped on it. */
type ExtractSessionOutcome = Omit<ExtractedSessionResult, "engine">;
type PreFilterStats = ExtractedSessionResult["preFilter"];

const NO_PREFILTER: PreFilterStats = { inputCount: 0, outputCount: 0, truncatedCount: 0 };

function sessionOutcome(
  sessionId: string,
  harness: string,
  fields: Partial<ExtractSessionOutcome>,
): ExtractSessionOutcome {
  return { sessionId, harness, candidateCount: 0, proposalIds: [], preFilter: NO_PREFILTER, warnings: [], ...fields };
}

function preFilterStats(filtered: ReturnType<typeof preFilterSession>): PreFilterStats {
  const { inputCount, outputCount, truncatedCount } = filtered.stats;
  return { inputCount, outputCount, truncatedCount };
}

/** An extract envelope for a run that processed no sessions. */
function emptyExtractResult(args: {
  ok: boolean;
  dryRun: boolean;
  type: string;
  warning: string;
  startMs: number;
  llmRunner?: ExtractLlmRunner;
}): AkmExtractResult {
  return {
    schemaVersion: 1,
    ok: args.ok,
    shape: "extract-result",
    dryRun: args.dryRun,
    type: args.type,
    sessionsProcessed: 0,
    sessionsSkipped: 0,
    candidatesCreated: 0,
    proposals: [],
    sessions: [],
    warnings: [args.warning],
    durationMs: Date.now() - args.startMs,
    ...(args.llmRunner ? { engine: args.llmRunner.engine, engineKind: args.llmRunner.kind } : {}),
  };
}

/**
 * A since-string as an epoch-ms cutoff: an ISO timestamp or `<n>m|h|d`
 * (case-insensitive here — `5M` is five minutes). Default 24h; anything else
 * is a usage error.
 */
export function parseSinceArg(value: string | undefined, now: number = Date.now()): number {
  if (!value || value.trim() === "") return now - 24 * 60 * 60 * 1000;
  const trimmed = value.trim();
  const relMatch = trimmed.match(/^(\d+)\s*([mhd])$/i);
  if (relMatch) {
    const ms = parseDuration(`${relMatch[1] ?? "0"}${(relMatch[2] ?? "h").toLowerCase()}`, DURATION_UNITS);
    if (ms !== null) return now - ms;
  }
  const iso = Date.parse(trimmed);
  if (!Number.isNaN(iso)) return iso;
  throw new UsageError(
    `--since value "${value}" could not be parsed (expected ISO timestamp or duration like 24h / 7d / 30m)`,
    "INVALID_FLAG_VALUE",
  );
}

/**
 * A candidate's ref and content. `description` (and a lesson's `when_to_use`)
 * go into the body's frontmatter so accept-time validation sees them.
 */
function buildCandidateProposal(
  candidate: ExtractCandidate,
  sourceRef: SessionSummary,
  sessionAssetRef?: string,
): { ref: string; content: string; description: string } {
  const ref = deriveExtractCandidateRef(candidate, sourceRef);
  // Complete a description the model cut mid-sentence (no-op for valid ones).
  const description = repairTruncatedDescription(candidate.description, candidate.body);
  const fm: Record<string, unknown> = { description, ...(sessionAssetRef ? { xrefs: [sessionAssetRef] } : {}) };
  if (candidate.type === "lesson" && candidate.when_to_use) fm.when_to_use = candidate.when_to_use;
  return { ref, content: assembleAsset(fm, candidate.body), description };
}

function canonicalSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function deriveExtractCandidateRef(candidate: ExtractCandidate, sourceRef: SessionSummary): string {
  const leaf = candidate.name.split("/").map(canonicalSegment).filter(Boolean).at(-1) ?? "extracted-insight";
  if (candidate.type === "memory" || candidate.type === "lesson") {
    const projectName = sourceRef.projectHint?.split(/[\\/]/).filter(Boolean).at(-1);
    const scope = projectName ? canonicalSegment(projectName) : "";
    return `${candidate.type === "memory" ? "memories" : "lessons"}/${scope ? `${scope}/` : ""}${leaf}`;
  }
  return `knowledge/${leaf}`;
}

function resolveExtractStandards(stashDir: string): string {
  const sections: string[] = [];
  const general = resolveStashStandards(stashDir);
  if (general) sections.push(general);
  for (const type of ["memory", "lesson", "knowledge"]) {
    const body = resolveTypeConventions(stashDir, type);
    if (body)
      sections.push(`# ${typeConventionRef(type)} (soft per-type conventions — guidance, not enforced)\n${body}`);
  }
  return sections.join("\n\n");
}

/**
 * The skip authority for "already extracted": a hash of the raw event stream
 * (`role\ntext` per event, NUL-separated so boundaries cannot be forged). It
 * excludes titles, timestamps and inline refs, and ignores pre-filter config.
 */
export function hashSessionContent(data: SessionData): string {
  return contentHash(data.events.map((e) => `${e.role ?? "unknown"}\n${e.text}`).join("\n\0\n"));
}

// ── Session triage (heuristic, zero LLM cost, default off) ───────────────────

const DEFAULT_TRIAGE_MIN_SCORE = 2;
const TRIAGE_MARKER_RE =
  /\b(error|failed|fix(?:ed)?|root cause|turns out|because|decided|instead|gotcha|workaround|regress(?:ed)?|broke|TIL)\b/i;
const TRIAGE_EDIT_COMMIT_RE = /\b(Edit|Write|MultiEdit|git commit|diff)\b/i;

/**
 * Score a session for extraction worth: learning markers (capped 2), tool
 * density, edits/commits, and the substantive assistant/tool share.
 */
function sessionTriagePasses(data: SessionData, minScore: number): boolean {
  const events = data.events;
  const count = (predicate: (e: SessionData["events"][number]) => boolean) => events.filter(predicate).length;
  const markers = Math.min(
    count((e) => TRIAGE_MARKER_RE.test(e.text)),
    2,
  );
  const toolDensity = Math.min(count((e) => e.role === "tool") * 0.25, 1.5);
  const editCommit = Math.min(count((e) => Boolean(e.filePath) || TRIAGE_EDIT_COMMIT_RE.test(e.text)) * 0.25, 1.5);
  const substantive = count((e) => (e.role === "assistant" || e.role === "tool") && e.text.length >= 40);
  const substantiveRatio = Math.min(events.length > 0 ? substantive / events.length : 0, 1);
  return markers + toolDensity + editCommit + substantiveRatio >= minScore;
}

type Triage = { enabled: boolean; minScore: number };

// ── Planning ─────────────────────────────────────────────────────────────────

interface SessionGateOptions {
  maxTotalChars: number | undefined;
  minContentChars: number;
  triage: Triage;
}

/**
 * The zero-LLM gates for one session: read, the content-hash skip (only
 * `--force` overrides it, even for `--session-id`), the raw-size floor and the
 * triage score. Returns a skip, or what the prompt needs.
 */
function runPreLlmSessionGates(
  harness: SessionLogHarness,
  sessionRef: SessionRef,
  prior: ExtractedSessionRow | undefined,
  force: boolean,
  gates: SessionGateOptions,
):
  | { skip: ExtractSessionOutcome }
  | { data: SessionData; filtered: ReturnType<typeof preFilterSession>; contentHash: string } {
  const { sessionId } = sessionRef;
  let data: SessionData;
  try {
    data = harness.readSession(sessionRef);
  } catch (err) {
    return {
      skip: sessionOutcome(sessionId, harness.name, {
        warnings: [`readSession failed: ${err instanceof Error ? err.message : String(err)}`],
        skipped: true,
        skipReason: "read_failed",
      }),
    };
  }
  const hash = hashSessionContent(data);
  if (!force && shouldSkipAlreadyExtractedSession(prior, hash)) {
    return {
      skip: sessionOutcome(sessionId, harness.name, {
        warnings: [`already extracted (content unchanged) at ${prior?.processed_at}; pass --force to re-process`],
        skipped: true,
        skipReason: "already_extracted",
        contentHash: hash,
      }),
    };
  }
  // The prompt sees only parent-origin events; subagent work still reaches
  // the hash above and the inline-ref harvest.
  const filtered = preFilterSession(
    { ...data, events: data.events.filter((e) => e.filePath === data.ref.filePath) },
    typeof gates.maxTotalChars === "number" ? { maxTotalChars: gates.maxTotalChars } : {},
  );
  // Measured on the full raw stream: pre-filtered size says little about value.
  const rawChars = data.events.reduce((sum, event) => sum + event.text.length, 0);
  const skipReason =
    gates.minContentChars > 0 && rawChars < gates.minContentChars
      ? "too_short"
      : gates.triage.enabled && !sessionTriagePasses(data, gates.triage.minScore)
        ? "triaged_out"
        : undefined;
  if (skipReason) {
    return {
      skip: sessionOutcome(sessionId, harness.name, {
        preFilter: preFilterStats(filtered),
        skipped: true,
        skipReason,
        contentHash: hash,
      }),
    };
  }
  return { data, filtered, contentHash: hash };
}

type ExtractEligibleGate = Exclude<ReturnType<typeof runPreLlmSessionGates>, { skip: ExtractSessionOutcome }>;

type ExtractSessionPlan =
  | { kind: "skip"; summary: SessionSummary; result: ExtractSessionOutcome }
  | { kind: "model"; summary: SessionSummary; gate: ExtractEligibleGate };

function lockedConcurrentResult(harness: string, summary: SessionSummary): ExtractSessionOutcome {
  return sessionOutcome(summary.sessionId, harness, {
    warnings: ["concurrent extract holds this session's lock — skipped (handled by the other run)"],
    skipped: true,
    skipReason: "locked_concurrent",
  });
}

/**
 * Classify candidates read-only, up to `maxSessionsPerRun` model sessions
 * (explicit `--session-id` and `--force` are uncapped); the rest are deferred.
 */
function planExtractSessions(args: {
  candidates: SessionSummary[];
  options: AkmExtractOptions;
  harness: SessionLogHarness;
  seenMap: Map<string, ExtractedSessionRow>;
  gates: SessionGateOptions;
  maxSessionsPerRun: number;
  locking: boolean;
}): { plans: ExtractSessionPlan[]; deferredCandidates: SessionSummary[] } {
  const { candidates, options, harness, maxSessionsPerRun, locking } = args;
  const lockUnavailable = (summary: SessionSummary) =>
    locking &&
    extractSessionLockIsUnavailable(harness.name, summary.sessionId, options.stateDbPath ?? getStateDbPath());
  const plans: ExtractSessionPlan[] = [];
  let modelCount = 0;
  for (let index = 0; index < candidates.length; index++) {
    const capped = !options.sessionId && !options.force && maxSessionsPerRun > 0 && modelCount >= maxSessionsPerRun;
    if (options.signal?.aborted || capped) return { plans, deferredCandidates: candidates.slice(index) };
    const summary = candidates[index];
    if (!summary) continue;
    if (lockUnavailable(summary)) {
      plans.push({ kind: "skip", summary, result: lockedConcurrentResult(harness.name, summary) });
      continue;
    }
    const prior = args.seenMap.get(summary.sessionId);
    const gate = runPreLlmSessionGates(harness, summary, prior, options.force === true, args.gates);
    if ("skip" in gate) {
      plans.push({ kind: "skip", summary, result: gate.skip });
      continue;
    }
    // Classifying can take long enough for a session-end hook to claim the lock.
    if (lockUnavailable(summary)) {
      plans.push({ kind: "skip", summary, result: lockedConcurrentResult(harness.name, summary) });
      continue;
    }
    plans.push({ kind: "model", summary, gate });
    modelCount += 1;
  }
  return { plans, deferredCandidates: [] };
}

// ── Extraction ───────────────────────────────────────────────────────────────

interface ExtractRun {
  options: AkmExtractOptions;
  harness: SessionLogHarness;
  stashDir: string;
  config: AkmConfig;
  llmRunner: ExtractLlmRunner;
  notices: ReturnType<typeof noticeSet>;
  sourceRun: string;
  dryRun: boolean;
  timeoutMs: number | null;
  gates: SessionGateOptions;
  maxSessionsPerRun: number;
  effectiveSince: string | undefined;
  sessionIndexing: { enabled: boolean; minDurationMinutes: number; generate: SessionSummaryGenerator };
  /** Stash authoring standards, resolved once per run. */
  standardsContext: string;
}

type SessionExtraction =
  | { kind: "success"; payload: ExtractPayload; attempts: number }
  | { kind: "unavailable" }
  | { kind: "malformed"; raw: string; attempts: number; failure: NonNullable<ExtractPayload["parseFailure"]> };

const EXTRACT_LLM_UNAVAILABLE = Symbol("extract-llm-unavailable");

/**
 * One session's extraction call. A connection without structured output gets
 * one corrective retry; configuration errors escape before any state is written.
 */
async function extractFromSession(run: ExtractRun, prompt: string): Promise<SessionExtraction> {
  const { llmRunner } = run;
  try {
    const result = await runStructured<ExtractPayload>({
      dispatch: async (feedback) => {
        const outcome = await callStage({
          feature: "session_extraction",
          runner: llmRunner,
          prompt: feedback ? `${prompt}\n\n## Corrective output instruction\n\n${feedback}` : prompt,
          gate: { config: run.config },
          request: {
            timeoutMs: run.timeoutMs,
            responseSchema: EXTRACT_JSON_SCHEMA,
            ...(run.options.signal ? { signal: run.options.signal } : {}),
            ...(run.options.chat ? { chat: run.options.chat } : {}),
          },
          onNotices: run.notices.add,
        });
        if (!outcome.ok) throw EXTRACT_LLM_UNAVAILABLE;
        return outcome.raw;
      },
      parse: (raw) => {
        const payload = parseExtractPayload(raw);
        return payload.parseFailure ? undefined : payload;
      },
      validate: (payload) => ({ ok: true, value: payload as ExtractPayload }),
      maxAttempts:
        llmRunner.connection.supportsJsonSchema !== false && !isJsonSchemaKnownUnsupported(llmRunner.connection)
          ? 1
          : 2,
      buildFeedback: () =>
        "Your previous response did not contain a valid extraction payload. Respond with ONLY a JSON object matching the requested schema, with a candidates array and no prose or code fences.",
    });
    if (result.ok) return { kind: "success", payload: result.value, attempts: result.attempts };
    return {
      kind: "malformed",
      raw: result.raw,
      attempts: result.attempts,
      failure: parseExtractPayload(result.raw).parseFailure ?? {
        code: "invalid_payload",
        message: result.errors.join("; "),
      },
    };
  } catch (err) {
    if (err === EXTRACT_LLM_UNAVAILABLE) return { kind: "unavailable" };
    throw err;
  }
}

/**
 * Write the session's searchable asset (`sessions/<harness>/<id>.md`). Fails
 * open: a failure is only a warning and never changes the extract outcome.
 */
async function maybeWriteSessionAsset(
  run: ExtractRun,
  data: SessionData,
): Promise<{ sessionAssetRef?: string; sessionLogPath?: string; warning?: string }> {
  const { sessionIndexing } = run;
  if (!sessionIndexing.enabled || run.dryRun) return {};
  if (!sessionMeetsDurationGate(data, sessionIndexing.minDurationMinutes)) return {};
  try {
    const result = await writeSessionAsset(data, run.stashDir, (summaryData) => sessionIndexing.generate(summaryData));
    if (!result.written) return {};
    // A standalone extract has no post-loop reindex to pick the file up.
    if (result.filePath) await indexWrittenAssets(run.stashDir, [result.filePath]);
    return {
      ...(result.ref ? { sessionAssetRef: result.ref } : {}),
      ...(result.logPath ? { sessionLogPath: result.logPath } : {}),
    };
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    return { warning: `session asset write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function processSession(
  run: ExtractRun,
  sessionRef: SessionRef,
  gate: ExtractEligibleGate,
): Promise<ExtractSessionOutcome> {
  const { harness, stashDir, sourceRun, dryRun, options } = run;
  const { data, filtered, contentHash: hash } = gate;
  const base = { preFilter: preFilterStats(filtered), contentHash: hash };
  const extraction = await extractFromSession(
    run,
    buildExtractPrompt({
      data,
      events: filtered.events,
      inlineRefs: data.inlineRefs,
      ...(run.standardsContext.trim() ? { standardsContext: run.standardsContext } : {}),
    }),
  );
  if (extraction.kind === "unavailable") {
    return sessionOutcome(sessionRef.sessionId, harness.name, {
      ...base,
      warnings: ["session_extraction feature returned empty (disabled / timeout / error)"],
      skipped: true,
      skipReason: "llm_unavailable",
      ...run.notices.fields(),
    });
  }
  if (extraction.kind === "malformed") {
    warnVerbose(
      `[extract] malformed model output for session ${sessionRef.sessionId}: ${redactErrorBody(extraction.raw)}`,
    );
    return sessionOutcome(sessionRef.sessionId, harness.name, {
      ...base,
      warnings: [
        `malformed_model_output: ${extraction.failure.message}; attempts=${extraction.attempts}; responseLength=${extraction.raw.length}; responseSha256=${contentHash(extraction.raw)}`,
      ],
      skipped: true,
      skipReason: "malformed_model_output",
      ...run.notices.fields(),
    });
  }

  const { payload } = extraction;
  const warnings: string[] = [];
  // Provenance xrefs are added only after the cited session asset exists.
  const { warning, ...sessionAsset } = await maybeWriteSessionAsset(run, data);
  if (warning) warnings.push(warning);
  const proposalIds: string[] = [];
  if (payload.candidates.length > 0) {
    // A candidate the ledger holds a live window for (pending, or recently rejected) is not queued again.
    const ledger = loadLedgerSnapshot(
      { proposalsCtx: options.ctx, eventsCtx: options.eventsCtx, ...(dryRun ? { readOnly: true } : {}) },
      stashDir,
      ["extract"],
    );
    const nowIso = new Date().toISOString();
    for (const candidate of payload.candidates) {
      const built = buildCandidateProposal(candidate, data.ref, sessionAsset.sessionAssetRef);
      const ledgerRow = ledger.get(ledgerKey("extract", built.ref));
      if (isLedgerBlocked(ledgerRow, nowIso)) {
        warnings.push(
          `candidate ${candidate.type}:${candidate.name} skipped: ${ledgerRow?.outcome} until ${ledgerRow?.nextEligibleAt}`,
        );
        continue;
      }
      if (dryRun) {
        proposalIds.push(`dry-run:${built.ref}`);
        continue;
      }
      try {
        const proposal = mintProposal(stashDir, options.ctx, {
          ref: built.ref,
          source: "extract",
          sourceRun,
          attemptedRefs: [built.ref],
          payload: {
            content: built.content,
            frontmatter: {
              description: built.description,
              ...(candidate.when_to_use ? { when_to_use: candidate.when_to_use } : {}),
              confidence: candidate.confidence,
              ...(sessionAsset.sessionAssetRef ? { xrefs: [sessionAsset.sessionAssetRef] } : {}),
              evidence: candidate.evidence,
            },
          },
        });
        proposalIds.push(proposal.id);
      } catch (err) {
        warnings.push(
          `candidate ${candidate.type}:${candidate.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  const empty = payload.candidates.length === 0;
  appendEvent(
    {
      eventType: "extract_invoked",
      ...(sessionAsset.sessionAssetRef ? { ref: sessionAsset.sessionAssetRef } : {}),
      metadata: {
        outcome: empty ? ("no_candidates" as const) : ("candidates_queued" as const),
        sessionId: sessionRef.sessionId,
        harness: harness.name,
        sourceRun,
        ...(empty
          ? { rationale: payload.rationale_if_empty }
          : { candidateCount: payload.candidates.length, proposalCount: proposalIds.length }),
        preFilterInput: filtered.stats.inputCount,
        preFilterOutput: filtered.stats.outputCount,
        repairAttempts: extraction.attempts - 1,
      },
    },
    options.eventsCtx,
  );
  return sessionOutcome(sessionRef.sessionId, harness.name, {
    ...base,
    candidateCount: payload.candidates.length,
    proposalIds,
    ...(empty && payload.rationale_if_empty ? { rationaleIfEmpty: payload.rationale_if_empty } : {}),
    warnings,
    ...sessionAsset,
    ...run.notices.fields(),
  });
}

interface ExtractLoopTally {
  sessions: ExtractedSessionResult[];
  processedCount: number;
  skippedCount: number;
  triageEvaluated: number;
  triagePassed: number;
  triagedOut: number;
  allProposalIds: string[];
  deferred: number;
}

/**
 * Work the plans: claim each model session's lock, re-read and re-gate it
 * under the lock (the log may have changed since planning), extract, and
 * record the outcome in the seen-session table. A skipped or locked session
 * refills its model slot from the deferred candidates.
 */
async function runExtractSessionLoop(
  run: ExtractRun,
  planned: { plans: ExtractSessionPlan[]; deferredCandidates: SessionSummary[] },
  seenMap: Map<string, ExtractedSessionRow>,
  stateDb: Database | undefined,
  tracking: boolean,
  topLevelWarnings: string[],
): Promise<ExtractLoopTally> {
  const { options, harness, gates, dryRun } = run;
  const locking = tracking && !dryRun && !options.stateDb;
  const tally: ExtractLoopTally = {
    sessions: [],
    processedCount: 0,
    skippedCount: 0,
    triageEvaluated: 0,
    triagePassed: 0,
    triagedOut: 0,
    allProposalIds: [],
    deferred: 0,
  };
  const account = (result: ExtractSessionOutcome): ExtractedSessionResult => {
    const stamped: ExtractedSessionResult = { ...result, engine: run.llmRunner.engine };
    tally.sessions.push(stamped);
    const preempted = ["read_failed", "too_short", "already_extracted", "locked_concurrent"].includes(
      result.skipReason ?? "",
    );
    if (gates.triage.enabled && !preempted) {
      tally.triageEvaluated += 1;
      if (result.skipReason === "triaged_out") tally.triagedOut += 1;
      else tally.triagePassed += 1;
    }
    if (result.skipped) tally.skippedCount += 1;
    else tally.processedCount += 1;
    tally.allProposalIds.push(...result.proposalIds);
    return stamped;
  };
  const accountAndRecord = (summary: SessionSummary, result: ExtractSessionOutcome): void => {
    recordSessionOutcome(stateDb, tracking && !dryRun, harness.name, summary, account(result), run.sourceRun);
  };

  const workPlans = [...planned.plans];
  let remaining = planned.deferredCandidates;
  const refillModelSlot = (): void => {
    if (remaining.length === 0 || options.signal?.aborted) return;
    const refill = planExtractSessions({
      candidates: remaining,
      options,
      harness,
      seenMap,
      gates,
      maxSessionsPerRun: 1,
      locking,
    });
    workPlans.push(...refill.plans);
    remaining = refill.deferredCandidates;
  };

  for (const plan of workPlans) {
    if (options.signal?.aborted) break;
    const { summary } = plan;
    if (plan.kind === "skip") {
      accountAndRecord(summary, plan.result);
      continue;
    }
    let lockOwnership: LockOwnership | undefined;
    if (locking) {
      const lock = acquireExtractSessionLock(
        extractSessionLockPath(harness.name, summary.sessionId, options.stateDbPath ?? getStateDbPath()),
      );
      if (!lock.proceed) {
        account(lockedConcurrentResult(harness.name, summary));
        refillModelSlot();
        continue;
      }
      lockOwnership = lock.ownership;
    }
    try {
      const prior = stateDb
        ? getExtractedSessionsMap(stateDb, harness.name, [summary.sessionId]).get(summary.sessionId)
        : seenMap.get(summary.sessionId);
      const gate = runPreLlmSessionGates(harness, summary, prior, options.force === true, gates);
      if ("skip" in gate) {
        accountAndRecord(summary, gate.skip);
        refillModelSlot();
        continue;
      }
      const result = await processSession(run, summary, gate);
      if (result.skipReason === "malformed_model_output") {
        for (const warning of result.warnings) topLevelWarnings.push(`session ${summary.sessionId}: ${warning}`);
      }
      accountAndRecord(summary, result);
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      warn(`[extract] session ${summary.sessionId} threw: ${msg}`);
      topLevelWarnings.push(`session ${summary.sessionId} threw: ${msg}`);
      account(
        sessionOutcome(summary.sessionId, harness.name, {
          warnings: [msg],
          skipped: true,
          skipReason: "exception",
          ...run.notices.fields(),
        }),
      );
    } finally {
      if (lockOwnership) releaseLock(lockOwnership);
    }
  }
  tally.deferred = remaining.length;
  return tally;
}

/**
 * Persist a session's outcome in the seen-session table. A session skipped as
 * already extracted or locked is not rewritten; one that failed for a
 * transient reason keeps a null hash so it is retried.
 */
function recordSessionOutcome(
  stateDb: Database | undefined,
  enabled: boolean,
  harness: string,
  summary: SessionSummary,
  result: ExtractedSessionResult,
  sourceRun: string,
): void {
  if (!enabled || !stateDb) return;
  if (result.skipReason === "already_extracted" || result.skipReason === "locked_concurrent") return;
  const reason = result.skipReason ?? "";
  try {
    upsertExtractedSession(stateDb, {
      harness,
      sessionId: summary.sessionId,
      processedAt: new Date().toISOString(),
      sessionEndedAt: summary.endedAt ?? null,
      outcome: result.skipped
        ? ["read_failed", "exception", "malformed_model_output"].includes(reason)
          ? "failed"
          : "skipped"
        : result.candidateCount === 0
          ? "no_candidates"
          : "candidates_queued",
      candidateCount: result.candidateCount,
      proposalCount: result.proposalIds.length,
      rationale: result.rationaleIfEmpty ?? null,
      sourceRun,
      contentHash: ["llm_unavailable", "triaged_out", "malformed_model_output"].includes(reason)
        ? null
        : (result.contentHash ?? null),
      metadata: {
        preFilterInputCount: result.preFilter.inputCount,
        preFilterOutputCount: result.preFilter.outputCount,
        preFilterTruncatedCount: result.preFilter.truncatedCount,
        engine: result.engine,
        ...(result.skipReason ? { skipReason: result.skipReason } : {}),
        ...(result.sessionLogPath ? { logPath: result.sessionLogPath } : {}),
        ...(result.sessionAssetRef ? { sessionAssetRef: result.sessionAssetRef } : {}),
      },
    });
  } catch (err) {
    warn(
      `[extract] failed to record session ${summary.sessionId} in state.db: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The run's runner, budgets, gates and session-indexing settings (throws without an engine). */
function resolveExtractRun(
  options: AkmExtractOptions,
  config: AkmConfig,
  process: Readonly<ImproveProcessConfig> | undefined,
  activeProfile: ImproveProfileConfig | undefined,
): Omit<ExtractRun, "options" | "harness" | "stashDir" | "config" | "sourceRun" | "dryRun" | "standardsContext"> {
  const notices = noticeSet();
  let llmRunner: ExtractLlmRunner | null | undefined;
  if (options.resolvedPlan) {
    llmRunner = options.resolvedPlan.runner;
    notices.add(options.resolvedPlan.notices ?? []);
  } else if (options.llmRunner) {
    llmRunner = options.llmRunner;
  } else {
    const resolved = resolveImproveLlmExecution({ config, profile: activeProfile, process, processName: "extract" });
    llmRunner = resolved?.runner;
    if (resolved) notices.add(resolved.notices);
  }
  if (!llmRunner) {
    throw new ConfigError(
      "No LLM engine configured for extract. Set defaults.llmEngine or improve.strategies.<name>.processes.extract.engine.",
      "LLM_NOT_CONFIGURED",
    );
  }
  const runner = llmRunner;
  const timeoutMs = options.resolvedPlan
    ? options.resolvedPlan.timeoutMs
    : Object.hasOwn(options, "timeoutMs")
      ? (options.timeoutMs ?? null)
      : Object.hasOwn(runner, "timeoutMs")
        ? (runner.timeoutMs ?? null)
        : 600_000;
  const triage = (process as { triage?: { enabled?: boolean; minScore?: number } } | undefined)?.triage;
  // The default summary generator fails open: no summary, no session asset.
  const generate: SessionSummaryGenerator = async (data) => {
    const outcome = await callStage({
      feature: "session_extraction",
      runner,
      prompt: buildSessionSummaryPrompt(data),
      gate: { config },
      request: {
        timeoutMs,
        responseSchema: SESSION_SUMMARY_JSON_SCHEMA,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.chat ? { chat: options.chat } : {}),
      },
      onNotices: notices.add,
    });
    return parseSessionSummary(outcome.ok ? outcome.raw : "");
  };
  return {
    llmRunner: runner,
    notices,
    timeoutMs,
    gates: {
      maxTotalChars: typeof process?.maxTotalChars === "number" ? process.maxTotalChars : undefined,
      minContentChars:
        typeof process?.minContentChars === "number" ? process.minContentChars : DEFAULT_MIN_CONTENT_CHARS,
      triage: {
        enabled: triage?.enabled === true,
        minScore: typeof triage?.minScore === "number" ? triage.minScore : DEFAULT_TRIAGE_MIN_SCORE,
      },
    },
    maxSessionsPerRun: options.since
      ? 0
      : typeof process?.maxSessionsPerRun === "number"
        ? process.maxSessionsPerRun
        : DEFAULT_MAX_SESSIONS_PER_RUN,
    effectiveSince: options.since ?? process?.defaultSince,
    sessionIndexing: {
      enabled: process?.indexSessions ?? true,
      minDurationMinutes:
        typeof process?.minSessionDuration === "number"
          ? process.minSessionDuration
          : DEFAULT_MIN_SESSION_DURATION_MINUTES,
      generate: options.generateSessionSummary ?? generate,
    },
  };
}

/** The sessions to process: the `--session-id` target (or a not-found envelope) or the discovery window. */
function discoverExtractCandidates(
  options: AkmExtractOptions,
  harness: SessionLogHarness,
  effectiveSince: string | undefined,
  startMs: number,
  dryRun: boolean,
  llmRunner: ExtractLlmRunner,
): { candidates: SessionSummary[] } | { notFound: AkmExtractResult } {
  const location = options.location ? { location: options.location } : {};
  if (options.sessionId) {
    const target = harness.listSessions(location).find((s) => s.sessionId === options.sessionId);
    if (target) return { candidates: [target] };
    return {
      notFound: emptyExtractResult({
        ok: false,
        dryRun,
        type: options.type,
        warning: `session ${options.sessionId} not found for harness ${options.type}`,
        startMs,
        llmRunner,
      }),
    };
  }
  const sinceMs = effectiveSince
    ? parseSinceArg(effectiveSince)
    : resolveDefaultSinceMs(harness.name, startMs, {
        ...(options.stateDb ? { stateDb: options.stateDb } : {}),
        ...(options.stateDbPath ? { stateDbPath: options.stateDbPath } : {}),
        ...(options.skipTracking ? { skipTracking: options.skipTracking } : {}),
      });
  return { candidates: harness.listSessions({ sinceMs, ...location }) };
}

function loadSeenMapReadOnly(
  options: AkmExtractOptions,
  harness: string,
  candidates: SessionSummary[],
  warnings: string[],
): Map<string, ExtractedSessionRow> {
  if (options.skipTracking === true || candidates.length === 0) return new Map();
  let snapshot: Database | undefined;
  try {
    if (!options.stateDb) snapshot = openSqliteReadSnapshot(options.stateDbPath ?? getStateDbPath());
    const db = options.stateDb ?? snapshot;
    return db
      ? getExtractedSessionsMap(
          db,
          harness,
          candidates.map((candidate) => candidate.sessionId),
        )
      : new Map();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`[extract] state.db snapshot unavailable, planning without skip-tracking: ${msg}`);
    warnings.push(`state.db snapshot unavailable: ${msg}`);
    return new Map();
  } finally {
    snapshot?.close();
  }
}

export async function akmExtract(options: AkmExtractOptions): Promise<AkmExtractResult> {
  const startMs = Date.now();
  if (!options.type || options.type.trim() === "") {
    throw new UsageError("--type is required. Pass a harness name (e.g. --type claude).", "MISSING_REQUIRED_ARGUMENT");
  }
  const config = options.config ?? loadConfig();
  const stashDir = options.stashDir ?? resolveStashDir();
  const dryRun = options.dryRun ?? false;
  const sourceRun = options.sourceRun ?? `extract-${timestampForFilename()}`;
  // Behavior comes from the frozen standalone plan or the active improve strategy.
  const activeProfile =
    options.improveProfile ?? (options.resolvedPlan ? undefined : resolveImproveStrategy(undefined, config).config);
  const process = options.resolvedPlan?.process ?? getImproveProcessConfig("extract", activeProfile);
  // The extract toggle gates extract as an improve STAGE; an explicit `akm extract` always runs.
  const enabled =
    options.resolvedPlan?.enabled ??
    (options.improveProfile ? resolveProcessEnabled("extract", options.improveProfile) : true);
  if (!enabled) {
    return emptyExtractResult({
      ok: true,
      dryRun,
      type: options.type,
      warning: "extract is disabled by the selected improve strategy",
      startMs,
    });
  }
  const resolved = resolveExtractRun(options, config, process, activeProfile);
  const { llmRunner, notices } = resolved;
  const harness = (options.harnesses ?? getAvailableHarnesses()).find((h) => h.name === options.type);
  const unavailable = !harness
    ? `no available harness matches type "${options.type}" (check that the platform is installed)`
    : !harness.isAvailable()
      ? `harness ${options.type} is registered but reports not-available (no session data on this machine)`
      : undefined;
  if (!harness || unavailable) {
    return emptyExtractResult({
      ok: false,
      dryRun,
      type: options.type,
      warning: unavailable ?? "",
      startMs,
      llmRunner,
    });
  }
  const discovery = discoverExtractCandidates(options, harness, resolved.effectiveSince, startMs, dryRun, llmRunner);
  if ("notFound" in discovery) return discovery.notFound;

  const topLevelWarnings: string[] = [];
  const tracking = options.skipTracking !== true;
  const seenMap = loadSeenMapReadOnly(options, harness.name, discovery.candidates, topLevelWarnings);
  const planned = planExtractSessions({
    candidates: discovery.candidates,
    options,
    harness,
    seenMap,
    gates: resolved.gates,
    maxSessionsPerRun: resolved.maxSessionsPerRun,
    locking: tracking && !dryRun && !options.stateDb,
  });
  const modelPlanCount = planned.plans.filter((plan) => plan.kind === "model").length;
  // Credentials are materialized once, after every read-only gate and before live state or a lock.
  if (modelPlanCount > 0) assertRunnerCredentials(llmRunner);

  let stateDb: Database | undefined;
  let tally: ExtractLoopTally;
  try {
    if (tracking) {
      if (options.stateDb) {
        stateDb = options.stateDb;
      } else if (modelPlanCount > 0 && !dryRun) {
        try {
          stateDb = openStateDatabase(options.stateDbPath);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warn(`[extract] state.db unavailable, processing without skip-tracking: ${msg}`);
          topLevelWarnings.push(`state.db unavailable: ${msg}`);
        }
      }
    }
    const run: ExtractRun = {
      ...resolved,
      options,
      harness,
      stashDir,
      config,
      sourceRun,
      dryRun,
      standardsContext: modelPlanCount > 0 ? resolveExtractStandards(stashDir) : "",
    };
    tally = await runExtractSessionLoop(run, planned, seenMap, stateDb, tracking, topLevelWarnings);
  } finally {
    if (stateDb && !options.stateDb) {
      try {
        stateDb.close();
      } catch {
        // best-effort
      }
    }
  }
  if (tally.deferred > 0) {
    topLevelWarnings.push(
      `Reached maxSessionsPerRun=${resolved.maxSessionsPerRun}; ${tally.deferred} session(s) deferred to a later run.`,
    );
  }
  // Every skip reason is counted; infrastructure failures also get a warning line.
  const counts: NonNullable<AkmExtractResult["skipReasons"]> = {};
  for (const session of tally.sessions) {
    if (session.skipReason) counts[session.skipReason] = (counts[session.skipReason] ?? 0) + 1;
  }
  for (const reason of EXTRACT_INFRASTRUCTURE_SKIP_REASONS) {
    const n = counts[reason];
    if (n)
      topLevelWarnings.push(
        `${n} of ${tally.sessions.length} sessions skipped: ${reason} (engine "${llmRunner.engine}")`,
      );
  }
  if (modelPlanCount > 0 && resolved.gates.triage.enabled && tally.triageEvaluated > 0) {
    appendEvent(
      {
        eventType: "extract_triaged",
        metadata: {
          evaluated: tally.triageEvaluated,
          passed: tally.triagePassed,
          triagedOut: tally.triagedOut,
          sourceRun,
        },
      },
      options.eventsCtx,
    );
  }
  return {
    schemaVersion: 1,
    ok: true,
    shape: "extract-result",
    dryRun,
    type: options.type,
    sessionsProcessed: tally.processedCount,
    sessionsSkipped: tally.skippedCount,
    candidatesCreated: tally.allProposalIds.length,
    proposals: tally.allProposalIds,
    sessions: tally.sessions,
    warnings: topLevelWarnings,
    durationMs: Date.now() - startMs,
    ...notices.fields(),
    ...(Object.keys(counts).length > 0 ? { skipReasons: counts } : {}),
    engine: llmRunner.engine,
    engineKind: llmRunner.kind,
  };
}

export interface CountNewExtractCandidatesOptions {
  /** Discovery cutoff (ISO timestamp or duration); defaults to the harness/process default. */
  since?: string;
  harnesses?: SessionLogHarness[];
  stateDb?: Database;
  /** Explicit state.db path (used only without `stateDb`). */
  stateDbPath?: string;
  /** Active improve profile, so the discovery window honors `--profile`. */
  improveProfile?: ImproveProfileConfig;
  /** Planning only: never creates state.db; without a borrowed handle every session counts as new. */
  readOnly?: boolean;
}

/**
 * Count new in-window sessions across the available harnesses, with no LLM
 * call, for improve's `minNewSessions` gate. It does not read session bodies,
 * so a session counts as new when it has no seen row or a row without a
 * content hash; the exact hash check happens at extraction.
 */
export function countNewExtractCandidates(_config: AkmConfig, options: CountNewExtractCandidatesOptions = {}): number {
  const effectiveSince = options.since ?? getImproveProcessConfig("extract", options.improveProfile)?.defaultSince;
  const explicitSinceMs = effectiveSince ? parseSinceArg(effectiveSince) : undefined;
  const harnesses = (options.harnesses ?? getAvailableHarnesses()).filter((h) => h.isAvailable());
  let stateDb: Database | undefined = options.stateDb;
  let openedStateDb = false;
  let total = 0;
  try {
    for (const harness of harnesses) {
      const sinceMs =
        explicitSinceMs ??
        resolveDefaultSinceMs(harness.name, Date.now(), {
          ...(options.stateDb ? { stateDb: options.stateDb } : {}),
          ...(options.stateDbPath ? { stateDbPath: options.stateDbPath } : {}),
          ...(options.readOnly && !options.stateDb ? { skipTracking: true } : {}),
        });
      const candidates = harness.listSessions({ sinceMs, ...(options.readOnly ? { isolatedSnapshot: true } : {}) });
      if (candidates.length === 0) continue;
      // A dry planner without state.db has no seen-session ledger by definition.
      if (options.readOnly && !stateDb) {
        total += candidates.length;
        continue;
      }
      let seenMap: Map<string, ExtractedSessionRow>;
      try {
        if (!stateDb) {
          stateDb = openStateDatabase(options.stateDbPath);
          openedStateDb = true;
        }
        seenMap = getExtractedSessionsMap(
          stateDb,
          harness.name,
          candidates.map((c) => c.sessionId),
        );
      } catch (err) {
        // Fail open: a transient sqlite error must not skip a pass that should run.
        const msg = err instanceof Error ? err.message : String(err);
        warn(`[extract] state.db unavailable while counting candidates, treating all as new: ${msg}`);
        total += candidates.length;
        continue;
      }
      for (const summary of candidates) {
        const prior = seenMap.get(summary.sessionId);
        if (!(prior && prior.content_hash != null)) total += 1;
      }
    }
  } finally {
    if (stateDb && openedStateDb) {
      try {
        stateDb.close();
      } catch {
        // best-effort
      }
    }
  }
  return total;
}
