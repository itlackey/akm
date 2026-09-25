// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm extract` — session-insight extractor.
 *
 * Replaces the akm-plugin session-checkpoint hook with an on-demand extractor
 * that reads native session files (claude JSONL, opencode storage tree)
 * through the {@link SessionLogHarness} registry, pre-filters noise, and asks
 * a bounded in-tree LLM to produce candidate memory/lesson/knowledge proposals
 * for content the agent did NOT preserve via inline `akm remember`/`akm feedback`.
 *
 * Architectural notes:
 *   - Stateless. All file/LLM access goes through injectable seams so tests
 *     never touch a real platform.
 *   - Bounded LLM call routed through `callStructured`. Improve-stage
 *     enablement comes from the active strategy; explicit `akm extract` always
 *     runs regardless of that stage toggle.
 *   - Proposals routed via `createProposal({ source: "extract", ... })` — the
 *     same review queue as reflect / distill / consolidate. Never direct-write.
 *   - Per-candidate body assembly merges description (+ when_to_use for lessons)
 *     into the body's YAML frontmatter so the accept-time
 *     descriptionQualityValidator passes — same pattern as the
 *     consolidate-writer fix.
 */

import fs from "node:fs";
import path from "node:path";
import { assembleAsset } from "../../core/asset/asset-serialize";
import { timestampForFilename } from "../../core/common";
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
import type { RunnerSpec } from "../../integrations/agent/runner";
import { assertRunnerCredentials } from "../../integrations/agent/runner-dispatch";
import { getAvailableHarnesses } from "../../integrations/session-logs";
import { preFilterSession } from "../../integrations/session-logs/pre-filter";
import type { SessionData, SessionLogHarness, SessionRef, SessionSummary } from "../../integrations/session-logs/types";
import { type ChatMessage, isJsonSchemaKnownUnsupported } from "../../llm/client";
import { callStructured } from "../../llm/structured-call";
import { sha256Hex } from "../../runtime";
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
import { resolveImproveLlmExecution } from "./execution";
import {
  buildExtractPrompt,
  EXTRACT_JSON_SCHEMA,
  type ExtractCandidate,
  type ExtractPayload,
  parseExtractPayload,
} from "./extract-prompt";
import { resolveImproveStrategy, resolveProcessEnabled } from "./improve-strategies";
import { isLedgerBlocked, ledgerKey, loadLedgerSnapshot } from "./ledger";
import { emitProposal } from "./proposal-envelope";
import { createRunContext, type RunContext, resolveRunStashDir } from "./run-context";
import {
  buildSessionSummaryPrompt,
  parseSessionSummary,
  SESSION_SUMMARY_JSON_SCHEMA,
  type SessionSummaryGenerator,
  sessionMeetsDurationGate,
  writeSessionAsset,
} from "./session-asset";
import { resolveTriageConfig, scoreSessionTriage } from "./triage";

/** Default minimum session duration (minutes) for session indexing (#561). */
const DEFAULT_MIN_SESSION_DURATION_MINUTES = 5;

/**
 * Default minimum raw session size (chars) below which the extract LLM call is
 * skipped (#595/#596). Deliberately tiny: analysis of 218 candidate-producing
 * sessions showed sessions of 22–368 raw chars regularly yield 1–5 candidates,
 * so size is not a reliable proxy for value — only truly empty sessions
 * (0 chars, journal files) are safe to skip.
 */
const DEFAULT_MIN_CONTENT_CHARS = 10;

/**
 * Default cap on NEW sessions the extract pass will LLM-process in a single run
 * (`processes.extract.maxSessionsPerRun` overrides; `0` disables). Bounds per-run
 * wall time + token spend so a backlog of accumulated sessions can't run a single
 * pass past its scheduled-task timeout. Overflow sessions stay unseen and are
 * processed by subsequent runs, so coverage is preserved — just spread out.
 */
const DEFAULT_MAX_SESSIONS_PER_RUN = 25;

/**
 * Floor for the default discovery window (48h). When no explicit `--since` /
 * `defaultSince` is configured, discovery looks back to the LAST recorded
 * extract run for the harness (so an intermittently-online host that was off for
 * days still rediscovers sessions that ended during the gap), but never LESS
 * than this — looking back less than the prior window could drop a session that
 * a previous run deferred via `maxSessionsPerRun`. Widening is free of redundant
 * LLM cost: the content-hash ledger skips unchanged sessions with zero LLM calls.
 */
const DEFAULT_SINCE_FLOOR_MS = 48 * 60 * 60 * 1000;

/**
 * Staleness window for the per-session extract lock. A single session's
 * processing is bounded by the per-session LLM timeout (default 60s) plus the
 * session-summary call, so a lock older than this must belong to a crashed
 * holder and is safe to reclaim.
 */
const EXTRACT_SESSION_LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * Resolve the discovery `sinceMs` cutoff when no explicit `since`/`defaultSince`
 * is set: the later of (last recorded extract run for this harness) and
 * (now − 48h). See {@link DEFAULT_SINCE_FLOOR_MS}. Best-effort — any state.db
 * error falls back to the 48h floor.
 */
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

/** Filesystem-safe per-session lock path, co-located with the state.db. */
function getExtractSessionLockPath(harness: string, sessionId: string, stateDbPath: string): string {
  const safe = `${harness}-${sessionId}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(path.dirname(stateDbPath), "extract-locks", `extract-${safe}.lock`);
}

function extractSessionLockIsUnavailable(harness: string, sessionId: string, stateDbPath: string): boolean {
  const lockPath = getExtractSessionLockPath(harness, sessionId, stateDbPath);
  const probe = probeLock(lockPath, { staleAfterMs: EXTRACT_SESSION_LOCK_STALE_MS });
  return probe.state === "held" || probe.state === "inaccessible";
}

/**
 * Try to claim the per-session extract lock so a concurrent extract (e.g. a
 * session-end hook firing `--session-id` while the hourly improve pass runs
 * discovery) cannot double-process the SAME session — duplicate LLM spend and
 * near-duplicate proposals. Reclaims a stale lock (dead holder PID or age past
 * {@link EXTRACT_SESSION_LOCK_STALE_MS}). Returns false when another LIVE run
 * holds it — the caller then skips the session without any LLM call. Best-effort:
 * any filesystem error resolves to `true` (proceed) so locking never blocks
 * extraction outright.
 */
function acquireExtractSessionLock(lockPath: string): { proceed: boolean; ownership?: LockOwnership } {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let ownership = tryAcquireLockSync(lockPath, createLockPayload());
    if (ownership) return { proceed: true, ownership };
    const probe = probeLock(lockPath, { staleAfterMs: EXTRACT_SESSION_LOCK_STALE_MS });
    if (probe.state === "held") return { proceed: false };
    // Absent (released between attempt + probe) or successfully reclaimed stale lock → retry once.
    if (probe.state === "stale" && !reclaimStaleLock(lockPath, probe)) return { proceed: false };
    ownership = tryAcquireLockSync(lockPath, createLockPayload());
    return ownership ? { proceed: true, ownership } : { proceed: false };
  } catch {
    return { proceed: true };
  }
}

// ── Options + Result envelopes ──────────────────────────────────────────────

export interface AkmExtractOptions {
  /** Harness name (e.g. "claude", "opencode"). Required. */
  type: string;
  /** Override the harness's default session-discovery location. */
  location?: string;
  /** Process exactly this session by ID. When absent, discover via {@link since}. */
  sessionId?: string;
  /**
   * Discovery cutoff. Sessions with `endedAt` older than this are skipped.
   * Accepts ISO timestamps (`2026-05-26T00:00:00Z`) or duration strings
   * (`24h`, `7d`, `30m`). Defaults to `24h`.
   */
  since?: string;
  /** Skip all writes; just report what would be created. */
  dryRun?: boolean;
  /** Override stash root (test seam). */
  stashDir?: string;
  /** Override config (test seam). */
  config?: AkmConfig;
  /** Current symbolic runner when no complete standalone plan is supplied. */
  llmRunner?: ExtractLlmRunner;
  /** Complete standalone invocation plan, resolved once at the CLI boundary. */
  resolvedPlan?: ResolvedExtractPlan;
  /** Override the harness registry (test seam). */
  harnesses?: SessionLogHarness[];
  /**
   * Override the LLM chat function (test seam). When absent, `callStructured`
   * dispatches through the shared lowered-execution transport.
   */
  chat?: (
    config: LlmProfileConfig,
    messages: ChatMessage[],
    options?: { timeoutMs?: number | null; responseSchema?: Record<string, unknown>; signal?: AbortSignal },
  ) => Promise<string>;
  /** Override proposal clock/id (test seam). */
  ctx?: ProposalsContext;
  /**
   * Events context carrying the improve run's long-lived state.db handle (or
   * the C2 boundary-pinned path) so extract's event emits take appendEvent's
   * fast path (R25). Proposal WRITES keep their own per-call open via
   * withProposalsDb — no db handle is threaded into ProposalsContext (D14).
   */
  eventsCtx?: EventsContext;
  /** sourceRun for PROV-DM traceability. Generated when absent. */
  sourceRun?: string;
  /**
   * The resolved ACTIVE improve profile, threaded by `akmImprove` so the
   * feature gate and per-process extract config are read from the profile that
   * is actually running. Standalone `akm extract` runs explicitly and does not
   * inherit an improve strategy's enablement gate.
   */
  improveProfile?: ImproveProfileConfig;
  /** Hard timeout for each LLM call (ms); null disables it. */
  timeoutMs?: number | null;
  /** Optional caller-driven cancellation signal. */
  signal?: AbortSignal;
  /**
   * Re-process sessions even if state.db says they were already extracted
   * (and no new events have arrived since). Default `false` — the discovery
   * pass skips already-seen sessions to avoid duplicate LLM calls.
   */
  force?: boolean;
  /**
   * Disable state.db tracking entirely for this run. Test seam — production
   * paths always track. Also useful for one-shot debugging when you want a
   * fresh LLM call without touching the seen-table.
   */
  skipTracking?: boolean;
  /**
   * Override the state.db connection (test seam). When absent the production
   * code opens the real state.db via {@link openStateDatabase}.
   */
  stateDb?: Database;
  /**
   * C2 (#554): explicit state.db path. When set (and `stateDb` is absent), the
   * skip-tracking open uses this path instead of the live `XDG_DATA_HOME`-derived
   * default. `akmImprove` threads its boundary-resolved path here so a parallel
   * test file mutating `XDG_DATA_HOME` mid-run cannot redirect this open.
   */
  stateDbPath?: string;
  /**
   * #561 — override the session-summary generator (test seam). When absent the
   * production code builds one that routes through the in-tree LLM via
   * `callStructured` (fail-open). Tests inject a fake to avoid any real
   * LLM/network call. When session indexing is disabled this is never invoked.
   */
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

type ExtractLlmRunner = Extract<RunnerSpec, { kind: "llm" }>;

function cloneAndFreeze<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(clone);
  return clone;
}

/** Resolve standalone extract selection once before discovery, auto iteration, or watch startup. */
export function resolveStandaloneExtractPlan(
  config: AkmConfig,
  selection: { engine?: string; strategy?: string; timeoutMs?: number | null },
): ResolvedExtractPlan {
  if (selection.engine && selection.strategy) {
    throw new UsageError("--engine and --strategy are mutually exclusive. Pick one.", "INVALID_FLAG_VALUE");
  }
  const selected = resolveImproveStrategy(selection.strategy, config);
  const process = cloneAndFreeze(getImproveProcessConfig("extract", selected.config) ?? {});
  const invocation = {
    ...(selection.engine ? { engine: selection.engine } : {}),
    ...(Object.hasOwn(selection, "timeoutMs") ? { timeoutMs: selection.timeoutMs ?? null } : {}),
  };
  const resolved = resolveImproveLlmExecution({
    config,
    profile: selected.config,
    process,
    current: invocation,
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
    // `akm extract` is an explicit operation. The strategy supplies behavior,
    // but its improve-stage enablement gate does not disable this command.
    enabled: true,
    process,
    runner: cloneAndFreeze(runner),
    timeoutMs: Object.hasOwn(runner, "timeoutMs") ? (runner.timeoutMs ?? null) : 600_000,
    embeddingConfig: cloneAndFreeze(config.embedding),
    ...(resolved.notices.length > 0 ? { notices: cloneAndFreeze(resolved.notices) } : {}),
  });
}

// ExtractedSessionResult / AkmExtractResult moved DOWN to core/improve-types.ts
// (WI-9.8 KILL 2 — the §10.7 layering inversion: core/improve-types.ts
// imported AkmExtractResult UP from this module). Re-exported here verbatim
// so existing import sites (`from "./extract"`) are unchanged.
export type { AkmExtractResult, ExtractedSessionResult } from "../../core/improve-types";

/** A session result before the run's engine is stamped on it (see {@link accountExtractSessionResult}). */
type ExtractSessionOutcome = Omit<ExtractedSessionResult, "engine">;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** An extract envelope for a run that processed no sessions; `engine`/`engineKind` only once a runner is resolved. */
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
 * Parse a since-string into an absolute ms-epoch cutoff. Accepts:
 *   - ISO timestamps (parsed via Date.parse)
 *   - Relative durations: `<n>m`, `<n>h`, `<n>d` (minutes / hours / days)
 *
 * Throws UsageError on unparseable input so the CLI surfaces a clear error
 * rather than silently defaulting.
 *
 * The recognizer is deliberately CASE-INSENSITIVE and whitespace-tolerant —
 * `5M` means 5 MINUTES here, diverging from the core grammar's case-sensitive
 * `M`=months (pinned by tests/commands/goldens-duration-flags.test.ts); only
 * the unit arithmetic is delegated to the canonical {@link DURATION_UNITS}
 * table via {@link parseDuration}.
 */
export function parseSinceArg(value: string | undefined, now: number = Date.now()): number {
  if (!value || value.trim() === "") {
    return now - 24 * 60 * 60 * 1000; // default: 24h
  }
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
 * Resolve a harness instance for the given type, either from the explicit
 * `harnesses` seam or the {@link getAvailableHarnesses} registry. Returns
 * `undefined` when no harness matches (the caller surfaces that as a warning).
 */
function resolveHarness(type: string, harnesses?: SessionLogHarness[]): SessionLogHarness | undefined {
  const pool = harnesses ?? getAvailableHarnesses();
  return pool.find((h) => h.name === type);
}

/**
 * Build the ref + content for a candidate. The body must contain a
 * frontmatter block carrying `description` (and `when_to_use` for lessons)
 * so the accept-time descriptionQualityValidator passes — same pattern as
 * the consolidate-writer fix at consolidate.ts.
 */
function buildCandidateProposal(
  candidate: ExtractCandidate,
  sourceRef: SessionSummary,
  sessionAssetRef?: string,
): { ref: string; content: string; description: string } {
  const ref = deriveExtractCandidateRef(candidate, sourceRef);
  // Post-generation repair pass (#556): deterministically complete a
  // description the LLM sliced mid-sentence before it reaches the
  // auto-accept validators. No-op (byte-identical) for valid descriptions.
  const description = repairTruncatedDescription(candidate.description, candidate.body);
  const fm: Record<string, unknown> = {
    description,
    ...(sessionAssetRef ? { xrefs: [sessionAssetRef] } : {}),
  };
  if (candidate.type === "lesson" && candidate.when_to_use) {
    fm.when_to_use = candidate.when_to_use;
  }
  const content = assembleAsset(fm, candidate.body);
  return { ref, content, description };
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
  const candidateParts = candidate.name.split("/").map(canonicalSegment).filter(Boolean);
  const leaf = candidateParts.at(-1) ?? "extracted-insight";
  if (candidate.type === "memory" || candidate.type === "lesson") {
    const projectName = sourceRef.projectHint?.split(/[\\/]/).filter(Boolean).at(-1);
    const scope = projectName ? canonicalSegment(projectName) : "";
    const subdir = candidate.type === "memory" ? "memories" : "lessons";
    return `${subdir}/${scope ? `${scope}/` : ""}${leaf}`;
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
 * Canonicalize a session's content into a single deterministic string for
 * hashing (#602). Each event is rendered `<role>\n<text>` and events are joined
 * with a NUL-delimited separator (`\n\0\n`) so event boundaries cannot be forged
 * by text that itself contains newlines.
 *
 * The input is the RAW `data.events` stream — NOT the pre-filtered / truncated
 * set — so the hash is stable across `maxTotalChars` (and any other pre-filter)
 * config changes: changing config must NEVER change the hash (idempotency AC).
 * `inlineRefs` and ref metadata (title, startedAt/endedAt timestamps) are
 * deliberately EXCLUDED so clock/title churn (and an agent adding an inline
 * `akm remember` mid-session) does not change the hash.
 */
function canonicalizeSessionContent(data: SessionData): string {
  return data.events.map((e) => `${e.role ?? "unknown"}\n${e.text}`).join("\n\0\n");
}

/**
 * sha256 (hex) of the normalized session content (#602). This is the byte-exact,
 * clock-independent skip authority that replaced the old `session_ended_at`
 * timestamp comparison. See {@link canonicalizeSessionContent} for exactly what
 * is (and is not) hashed.
 */
export function hashSessionContent(data: SessionData): string {
  return sha256Hex(canonicalizeSessionContent(data));
}

/**
 * Process one session through the full pipeline: read → pre-filter → LLM →
 * parse → createProposal-per-candidate. Returns the per-session result.
 *
 * On any non-fatal failure (LLM error, unparseable response, individual
 * proposal validation failure) the session result records a warning and
 * keeps going — one session's bad luck never aborts a multi-session run.
 */
/**
 * The zero-LLM pre-flight gates for one session: read, the #602 content-hash
 * already-extracted skip, the #595/#596 minContentChars floor, and the #626
 * heuristic triage gate. Returns a terminal skip result, or the read `data` +
 * pre-filtered events + content hash to carry into the extraction prompt.
 * Extracted verbatim from `processSession` — every skip shape/reason is
 * byte-identical.
 */
function runPreLlmSessionGates(args: {
  harness: SessionLogHarness;
  sessionRef: SessionRef;
  prior: ExtractedSessionRow | undefined;
  force: boolean;
  maxTotalChars: number | undefined;
  minContentChars: number;
  triage: { enabled: boolean; minScore: number };
}):
  | { skip: ExtractSessionOutcome }
  | {
      data: ReturnType<SessionLogHarness["readSession"]>;
      filtered: ReturnType<typeof preFilterSession>;
      contentHash: string;
    } {
  const { harness, sessionRef, prior, force, maxTotalChars, minContentChars, triage } = args;
  let data: ReturnType<SessionLogHarness["readSession"]>;
  try {
    data = harness.readSession(sessionRef);
  } catch (err) {
    return {
      skip: {
        sessionId: sessionRef.sessionId,
        harness: harness.name,
        candidateCount: 0,
        proposalIds: [],
        preFilter: { inputCount: 0, outputCount: 0, truncatedCount: 0 },
        warnings: [`readSession failed: ${err instanceof Error ? err.message : String(err)}`],
        skipped: true,
        skipReason: "read_failed",
      },
    };
  }

  // #602 — content-hash skip. Computed on the RAW event stream immediately after
  // a successful read, BEFORE the pre-filter / minContentChars / triage gates, so
  // an unchanged session never reaches the LLM. Hash-based ⇒ clock-independent
  // (immune to the Jun 11-12 timestamp double-extract/over-throttle bug). The skip
  // applies UNIFORMLY — including explicit `--session-id` targeting (so a
  // session-end hook firing `extract --session-id <id>` is idempotent). ONLY
  // `--force` overrides it to re-extract a previously-extracted session.
  const contentHash = hashSessionContent(data);
  if (!force && shouldSkipAlreadyExtractedSession(prior, contentHash)) {
    return { skip: alreadyExtractedResult(harness.name, sessionRef.sessionId, prior, contentHash) };
  }

  // #840 — harvest-without-prompting hybrid: the LLM prompt is built only from
  // parent-origin events (folding stays as infrastructure for hashing above
  // and inline-ref harvesting on `data.inlineRefs`, both of which still see
  // the FULL folded stream). Subagent-origin events never reach
  // `preFilterSession`, so #839's `dedupeTaskNotifications` naturally becomes
  // a no-op on this path — a subagent's own event can no longer be in the
  // kept set for a notification to be deduped against, leaving the parent's
  // `<task-notification>` (the only surviving trace of that delegated work)
  // untouched. See docs/plans/subagent-extraction-design.md §6.
  const parentOriginData: typeof data = {
    ...data,
    events: data.events.filter((e) => e.filePath === data.ref.filePath),
  };
  const filtered = preFilterSession(parentOriginData, {
    ...(typeof maxTotalChars === "number" ? { maxTotalChars } : {}),
  });

  // #595/#596 — minContentChars gate: skip the LLM call for sessions whose RAW
  // size is below threshold. Measured on the raw event text BEFORE the noise
  // pre-filter, NOT on post-filter output — the pre-filter strips boilerplate
  // so aggressively that even signal-bearing sessions can have tiny output
  // (#596: gating post-filter filtered out 100% of sessions). Note: the 0.8.x
  // fix gated on `filtered.stats.inputCount`, which is an EVENT count, not a
  // char count — this port measures actual raw chars so the threshold matches
  // the config key's documented unit.
  // #840 — deliberately measured on the FULL folded `data.events` (parent +
  // subagents), not the parent-origin view above: narrowing this to
  // parent-origin chars would newly skip delegation-heavy sessions with a
  // thin parent transcript before extraction runs at all, even though their
  // subagent work is still fully harvested via `data.inlineRefs` above. The
  // full-stream measurement is today's unchanged behavior, so the worst case
  // this preserves is an LLM call over a small parent-only prompt, not a
  // missed extraction.
  const rawContentChars = data.events.reduce((sum, event) => sum + event.text.length, 0);
  if (minContentChars > 0 && rawContentChars < minContentChars) {
    return {
      skip: {
        sessionId: sessionRef.sessionId,
        harness: harness.name,
        candidateCount: 0,
        proposalIds: [],
        preFilter: {
          inputCount: filtered.stats.inputCount,
          outputCount: filtered.stats.outputCount,
          truncatedCount: filtered.stats.truncatedCount,
        },
        warnings: [],
        skipped: true,
        skipReason: "too_short",
        contentHash,
      },
    };
  }

  // #626 — pre-LLM heuristic triage gate. Runs AFTER minContentChars + the
  // already-extracted skip check (both in the caller / above), BEFORE the
  // extraction prompt and the session-asset write. When the session scores below
  // the configured threshold we triage it out: no chat() call, no session asset,
  // no proposals. Pure-heuristic — zero added LLM cost. Default-off → skipped.
  if (triage.enabled) {
    const t = scoreSessionTriage(data, triage.minScore);
    if (!t.pass) {
      return {
        skip: {
          sessionId: sessionRef.sessionId,
          harness: harness.name,
          candidateCount: 0,
          proposalIds: [],
          preFilter: {
            inputCount: filtered.stats.inputCount,
            outputCount: filtered.stats.outputCount,
            truncatedCount: filtered.stats.truncatedCount,
          },
          warnings: [],
          skipped: true,
          skipReason: "triaged_out",
          contentHash,
        },
      };
    }
  }

  return { data, filtered, contentHash };
}

type ExtractEligibleGate = Exclude<ReturnType<typeof runPreLlmSessionGates>, { skip: ExtractSessionOutcome }>;

type ExtractSessionPlan =
  | { kind: "skip"; summary: SessionSummary; result: ExtractSessionOutcome }
  | { kind: "model"; summary: SessionSummary; gate: ExtractEligibleGate };

function alreadyExtractedResult(
  harness: string,
  sessionId: string,
  prior: ExtractedSessionRow | undefined,
  contentHash: string,
): ExtractSessionOutcome {
  return {
    sessionId,
    harness,
    candidateCount: 0,
    proposalIds: [],
    preFilter: { inputCount: 0, outputCount: 0, truncatedCount: 0 },
    warnings: [`already extracted (content unchanged) at ${prior?.processed_at}; pass --force to re-process`],
    skipped: true,
    skipReason: "already_extracted",
    contentHash,
  };
}

function lockedConcurrentResult(harness: string, summary: SessionSummary): ExtractSessionOutcome {
  return {
    sessionId: summary.sessionId,
    harness,
    candidateCount: 0,
    proposalIds: [],
    preFilter: { inputCount: 0, outputCount: 0, truncatedCount: 0 },
    warnings: ["concurrent extract holds this session's lock — skipped (handled by the other run)"],
    skipped: true,
    skipReason: "locked_concurrent",
  };
}

function planExtractSessions(args: {
  candidates: SessionSummary[];
  options: AkmExtractOptions;
  harness: SessionLogHarness;
  seenMap: Map<string, ExtractedSessionRow>;
  maxTotalChars: number | undefined;
  minContentChars: number;
  maxSessionsPerRun: number;
  triage: { enabled: boolean; minScore: number };
  trackingEnabled: boolean;
  dryRun: boolean;
}): { plans: ExtractSessionPlan[]; deferredCandidates: SessionSummary[] } {
  const { candidates, options, harness, seenMap, maxSessionsPerRun, trackingEnabled, dryRun } = args;
  const plans: ExtractSessionPlan[] = [];
  let modelCount = 0;
  for (let index = 0; index < candidates.length; index++) {
    if (options.signal?.aborted) return { plans, deferredCandidates: candidates.slice(index) };
    if (!options.sessionId && !options.force && maxSessionsPerRun > 0 && modelCount >= maxSessionsPerRun) {
      return { plans, deferredCandidates: candidates.slice(index) };
    }
    const summary = candidates[index];
    if (!summary) continue;
    if (trackingEnabled && !dryRun && !options.stateDb) {
      if (extractSessionLockIsUnavailable(harness.name, summary.sessionId, options.stateDbPath ?? getStateDbPath())) {
        plans.push({ kind: "skip", summary, result: lockedConcurrentResult(harness.name, summary) });
        continue;
      }
    }
    const gate = runPreLlmSessionGates({
      harness,
      sessionRef: summary,
      prior: seenMap.get(summary.sessionId),
      force: options.force === true,
      maxTotalChars: args.maxTotalChars,
      minContentChars: args.minContentChars,
      triage: args.triage,
    });
    if ("skip" in gate) {
      plans.push({ kind: "skip", summary, result: gate.skip });
      continue;
    }
    // Reading and classifying a session can take long enough for a concurrent
    // session-end hook to claim its lock. Re-probe the fully classified model
    // plan before it consumes a cap slot or forces credential materialization.
    if (
      trackingEnabled &&
      !dryRun &&
      !options.stateDb &&
      extractSessionLockIsUnavailable(harness.name, summary.sessionId, options.stateDbPath ?? getStateDbPath())
    ) {
      plans.push({ kind: "skip", summary, result: lockedConcurrentResult(harness.name, summary) });
      continue;
    }
    plans.push({ kind: "model", summary, gate });
    modelCount += 1;
  }
  return { plans, deferredCandidates: [] };
}

/**
 * Run-scoped inputs shared by every {@link processSession} call — resolved once
 * per extract run by {@link runExtractSessionLoop}. WI-7.7 §2: the former
 * 18-positional-argument signature collapsed to `(runCtx, session)`.
 */
interface ExtractSessionRunCtx {
  harness: SessionLogHarness;
  stashDir: string;
  config: AkmConfig;
  llmRunner: ExtractLlmRunner;
  onNotices: (notices: readonly Readonly<LoweringNotice>[]) => void;
  getNotices: () => readonly Readonly<LoweringNotice>[];
  chat: AkmExtractOptions["chat"];
  ctx: ProposalsContext | undefined;
  /** R25: events carrier — event emits only; proposals keep `ctx`. */
  eventsCtx: EventsContext | undefined;
  sourceRun: string;
  dryRun: boolean;
  timeoutMs: number | null;
  sessionIndexing: {
    enabled: boolean;
    minDurationMinutes: number;
    generate: SessionSummaryGenerator;
  };
  signal: AbortSignal | undefined;
  /**
   * Stash authoring standards (convention/meta fact bodies) for non-wiki
   * output. Resolved ONCE per run and threaded in so facts are not re-read per
   * session. Empty string when none exist.
   */
  standardsContext: string;
}

/**
 * Per-session inputs for one {@link processSession} invocation.
 *
 * #602 — the already-extracted skip lives INSIDE processSession: the content
 * hash can only be computed after readSession, so the skip decision happens
 * there. The prior row + bypass flag are threaded in from the caller. Skipping
 * there still costs ZERO LLM calls (the expensive resource #602 protects);
 * only the cheap file read is incurred.
 */
interface ExtractSessionInput {
  sessionRef: SessionRef;
  gate: ExtractEligibleGate;
}

/**
 * The bounded per-session extraction LLM call. Routes the already-resolved
 * symbolic runner through `callStructured` under the `session_extraction`
 * gate. Invalid configuration escapes before session/proposal state is
 * persisted. Engines without JSON Schema support get one corrective retry;
 * exhausted structure failures retain typed, non-payload diagnostics.
 */
type SessionExtractionLlmCallResult =
  | { kind: "success"; payload: ExtractPayload; attempts: number }
  | { kind: "unavailable" }
  | {
      kind: "malformed";
      raw: string;
      attempts: number;
      failure: NonNullable<ExtractPayload["parseFailure"]>;
    };

const EXTRACT_LLM_UNAVAILABLE = Symbol("extract-llm-unavailable");

async function runSessionExtractionLlmCall(args: {
  config: AkmConfig;
  llmRunner: ExtractLlmRunner;
  chat: AkmExtractOptions["chat"];
  prompt: string;
  timeoutMs: number | null;
  signal: AbortSignal | undefined;
  onNotices: (notices: readonly Readonly<LoweringNotice>[]) => void;
}): Promise<SessionExtractionLlmCallResult> {
  const { config, llmRunner, chat, prompt, timeoutMs, signal, onNotices } = args;
  try {
    const result = await runStructured<ExtractPayload>({
      dispatch: async (feedback) => {
        const content = feedback ? `${prompt}\n\n## Corrective output instruction\n\n${feedback}` : prompt;
        const dispatched = await callStructured<{ kind: "response"; raw: string } | { kind: "unavailable" }>({
          feature: "session_extraction",
          akmConfig: config,
          runner: llmRunner,
          messages: [{ role: "user", content }],
          request: {
            timeoutMs,
            responseSchema: EXTRACT_JSON_SCHEMA,
            ...(signal ? { signal } : {}),
            ...(chat ? { chat } : {}),
          },
          onNotices,
          parse: (raw) => ({ kind: "response", raw: raw ?? "" }),
          onError: () => ({ kind: "unavailable" }),
          fallback: { kind: "unavailable" },
        });
        if (dispatched.kind === "unavailable") throw EXTRACT_LLM_UNAVAILABLE;
        return dispatched.raw;
      },
      parse: (raw) => {
        const payload = parseExtractPayload(raw);
        return payload.parseFailure ? undefined : payload;
      },
      validate: (payload) => ({ ok: true, value: payload as ExtractPayload }),
      // One attempt when structured output is expected to work (not explicitly
      // disabled, and this connection hasn't already proven otherwise this
      // process — see `isJsonSchemaKnownUnsupported`); two when it's known
      // unsupported and extraction is relying on looser prompt-contract JSON.
      maxAttempts:
        llmRunner.connection.supportsJsonSchema !== false && !isJsonSchemaKnownUnsupported(llmRunner.connection)
          ? 1
          : 2,
      buildFeedback: () =>
        "Your previous response did not contain a valid extraction payload. Respond with ONLY a JSON object matching the requested schema, with a candidates array and no prose or code fences.",
    });
    if (result.ok) return { kind: "success", payload: result.value, attempts: result.attempts };
    const payload = parseExtractPayload(result.raw);
    return {
      kind: "malformed",
      raw: result.raw,
      attempts: result.attempts,
      failure:
        payload.parseFailure ??
        ({ code: "invalid_payload", message: result.errors.join("; ") } satisfies NonNullable<
          ExtractPayload["parseFailure"]
        >),
    };
  } catch (err) {
    if (err === EXTRACT_LLM_UNAVAILABLE) return { kind: "unavailable" };
    throw err;
  }
}

function extractNoticeFields(
  getNotices: () => readonly Readonly<LoweringNotice>[],
): Pick<ExtractedSessionResult, "notices"> {
  const notices = getNotices();
  return notices.length > 0 ? { notices } : {};
}

function extractPreFilterStats(filtered: ReturnType<typeof preFilterSession>): ExtractedSessionResult["preFilter"] {
  return {
    inputCount: filtered.stats.inputCount,
    outputCount: filtered.stats.outputCount,
    truncatedCount: filtered.stats.truncatedCount,
  };
}

function malformedExtractionResult(args: {
  extraction: Extract<SessionExtractionLlmCallResult, { kind: "malformed" }>;
  sessionRef: SessionRef;
  harness: string;
  preFilter: ExtractedSessionResult["preFilter"];
  contentHash: string;
  notices: Pick<ExtractedSessionResult, "notices">;
}): ExtractSessionOutcome {
  const { extraction, sessionRef, harness, preFilter, contentHash, notices } = args;
  const diagnostic = `malformed_model_output: ${extraction.failure.message}; attempts=${extraction.attempts}; responseLength=${extraction.raw.length}; responseSha256=${sha256Hex(extraction.raw)}`;
  warnVerbose(
    `[extract] malformed model output for session ${sessionRef.sessionId}: ${redactErrorBody(extraction.raw)}`,
  );
  return {
    sessionId: sessionRef.sessionId,
    harness,
    candidateCount: 0,
    proposalIds: [],
    preFilter,
    warnings: [diagnostic],
    skipped: true,
    skipReason: "malformed_model_output",
    contentHash,
    ...notices,
  };
}

function unavailableExtractionResult(args: {
  sessionRef: SessionRef;
  harness: string;
  preFilter: ExtractedSessionResult["preFilter"];
  contentHash: string;
  notices: Pick<ExtractedSessionResult, "notices">;
}): ExtractSessionOutcome {
  return {
    sessionId: args.sessionRef.sessionId,
    harness: args.harness,
    candidateCount: 0,
    proposalIds: [],
    preFilter: args.preFilter,
    warnings: ["session_extraction feature returned empty (disabled / timeout / error)"],
    skipped: true,
    skipReason: "llm_unavailable",
    contentHash: args.contentHash,
    ...args.notices,
  };
}

// #561 — ADDITIVE session indexing. Generate + write the session asset
// (`sessions/<harness>/<id>.md`). FAIL-OPEN: any failure only returns a
// warning; it NEVER changes the proposal/skip outcome of extract. Returns the
// frontmatter fields to merge into the per-session result for state-db
// correlation. When disabled this makes NO LLM call and writes NOTHING.
async function maybeWriteSessionAsset(
  runCtx: ExtractSessionRunCtx,
  session: ExtractSessionInput,
): Promise<{ sessionAssetRef?: string; sessionLogPath?: string; warning?: string }> {
  const { stashDir, sessionIndexing, dryRun } = runCtx;
  const { data } = session.gate;
  if (!sessionIndexing.enabled || dryRun) return {};
  if (!sessionMeetsDurationGate(data, sessionIndexing.minDurationMinutes)) return {};
  try {
    const result = await writeSessionAsset(data, stashDir, (summaryData) => sessionIndexing.generate(summaryData));
    if (result.written) {
      // Write-path indexing (itself fail-open): standalone `akm extract`
      // (session-end hook) has no post-loop reindex to pick this file up.
      if (result.filePath) await indexWrittenAssets(stashDir, [result.filePath]);
      return {
        ...(result.ref ? { sessionAssetRef: result.ref } : {}),
        ...(result.logPath ? { sessionLogPath: result.logPath } : {}),
      };
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    return { warning: `session asset write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {};
}

async function processSession(
  runCtx: ExtractSessionRunCtx,
  session: ExtractSessionInput,
): Promise<ExtractSessionOutcome> {
  const {
    harness,
    stashDir,
    config,
    llmRunner,
    onNotices,
    getNotices,
    chat,
    ctx,
    eventsCtx,
    sourceRun,
    dryRun,
    timeoutMs,
    signal,
    standardsContext,
  } = runCtx;
  const { sessionRef, gate } = session;
  const warnings: string[] = [];
  const { data, filtered, contentHash } = gate;

  const prompt = buildExtractPrompt({
    data,
    events: filtered.events,
    inlineRefs: data.inlineRefs,
    ...(standardsContext.trim() ? { standardsContext } : {}),
  });

  const extraction = await runSessionExtractionLlmCall({
    config,
    llmRunner,
    chat,
    prompt,
    timeoutMs,
    signal,
    onNotices,
  });

  if (extraction.kind === "unavailable") {
    // The seam took the fallback path (disabled / timeout / error). Return skipped.
    return unavailableExtractionResult({
      sessionRef,
      harness: harness.name,
      preFilter: extractPreFilterStats(filtered),
      contentHash,
      notices: extractNoticeFields(getNotices),
    });
  }

  if (extraction.kind === "malformed") {
    return malformedExtractionResult({
      extraction,
      sessionRef,
      harness: harness.name,
      preFilter: extractPreFilterStats(filtered),
      contentHash,
      notices: extractNoticeFields(getNotices),
    });
  }

  const { payload } = extraction;
  const proposalIds: string[] = [];
  // Provenance refs are added only after the cited session asset exists.
  const sessionAsset = await maybeWriteSessionAsset(runCtx, session);
  if (sessionAsset.warning) warnings.push(sessionAsset.warning);

  if (payload.candidates.length === 0) {
    appendEvent(
      {
        eventType: "extract_invoked",
        ...(sessionAsset.sessionAssetRef ? { ref: sessionAsset.sessionAssetRef } : {}),
        metadata: {
          outcome: "no_candidates" as const,
          sessionId: sessionRef.sessionId,
          harness: harness.name,
          sourceRun,
          rationale: payload.rationale_if_empty,
          repairAttempts: extraction.attempts - 1,
          preFilterInput: filtered.stats.inputCount,
          preFilterOutput: filtered.stats.outputCount,
        },
      },
      eventsCtx,
    );
    return {
      sessionId: sessionRef.sessionId,
      harness: harness.name,
      candidateCount: 0,
      proposalIds: [],
      ...(payload.rationale_if_empty ? { rationaleIfEmpty: payload.rationale_if_empty } : {}),
      preFilter: {
        inputCount: filtered.stats.inputCount,
        outputCount: filtered.stats.outputCount,
        truncatedCount: filtered.stats.truncatedCount,
      },
      warnings,
      contentHash,
      ...sessionAsset,
      ...extractNoticeFields(getNotices),
    };
  }

  // A candidate the improve ledger already holds a live window for (proposed
  // and pending, or recently rejected) is not queued again.
  const ledgerAccess = { proposalsCtx: ctx, eventsCtx, ...(dryRun ? { readOnly: true } : {}) };
  const ledger = loadLedgerSnapshot(ledgerAccess, stashDir, ["extract"]);
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
      const { ref, content, description } = built;
      const result = emitProposal(
        { stashDir, proposalsCtx: ctx },
        {
          ref,
          source: "extract",
          sourceRun,
          attemptedRefs: [ref],
          payload: {
            content,
            frontmatter: {
              description,
              ...(candidate.when_to_use ? { when_to_use: candidate.when_to_use } : {}),
              confidence: candidate.confidence,
              ...(sessionAsset.sessionAssetRef ? { xrefs: [sessionAsset.sessionAssetRef] } : {}),
              evidence: candidate.evidence,
            },
          },
        },
      );
      proposalIds.push(result.id);
    } catch (err) {
      warnings.push(
        `candidate ${candidate.type}:${candidate.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  appendEvent(
    {
      eventType: "extract_invoked",
      ...(sessionAsset.sessionAssetRef ? { ref: sessionAsset.sessionAssetRef } : {}),
      metadata: {
        outcome: "candidates_queued" as const,
        sessionId: sessionRef.sessionId,
        harness: harness.name,
        sourceRun,
        candidateCount: payload.candidates.length,
        proposalCount: proposalIds.length,
        preFilterInput: filtered.stats.inputCount,
        preFilterOutput: filtered.stats.outputCount,
        repairAttempts: extraction.attempts - 1,
      },
    },
    eventsCtx,
  );

  return {
    sessionId: sessionRef.sessionId,
    harness: harness.name,
    candidateCount: payload.candidates.length,
    proposalIds,
    preFilter: {
      inputCount: filtered.stats.inputCount,
      outputCount: filtered.stats.outputCount,
      truncatedCount: filtered.stats.truncatedCount,
    },
    warnings,
    contentHash,
    ...sessionAsset,
    ...extractNoticeFields(getNotices),
  };
}

/** Run-scoped inputs for {@link runExtractSessionLoop}. */
interface ExtractSessionLoopArgs {
  plans: ExtractSessionPlan[];
  deferredCandidates: SessionSummary[];
  seenMap: Map<string, ExtractedSessionRow>;
  options: AkmExtractOptions;
  harness: SessionLogHarness;
  stateDb: Database | undefined;
  trackingEnabled: boolean;
  dryRun: boolean;
  stashDir: string;
  config: AkmConfig;
  llmRunner: ExtractLlmRunner;
  onNotices: (notices: readonly Readonly<LoweringNotice>[]) => void;
  getNotices: () => readonly Readonly<LoweringNotice>[];
  chat: AkmExtractOptions["chat"];
  sourceRun: string;
  timeoutMs: number | null;
  maxTotalChars: number | undefined;
  minContentChars: number;
  triage: { enabled: boolean; minScore: number };
  sessionIndexing: { enabled: boolean; minDurationMinutes: number; generate: SessionSummaryGenerator };
  extractStandardsContext: string;
  /** Mutated in place with run-level (non-session) warnings. */
  topLevelWarnings: string[];
}

/** Accumulated per-run tallies + results produced by {@link runExtractSessionLoop}. */
interface ExtractSessionLoopResult {
  /** The run's resolved engine name, stamped onto every session result and ledger row. */
  engine: string;
  sessions: ExtractedSessionResult[];
  processedCount: number;
  skippedCount: number;
  triageEvaluated: number;
  triagePassed: number;
  triagedOut: number;
  allProposalIds: string[];
  deferred: number;
}

function recordExtractSessionOutcome(args: {
  stateDb: Database | undefined;
  trackingEnabled: boolean;
  dryRun: boolean;
  harness: string;
  summary: SessionSummary;
  result: ExtractedSessionResult;
  sourceRun: string;
}): void {
  const { stateDb, trackingEnabled, dryRun, harness, summary, result, sourceRun } = args;
  if (
    !trackingEnabled ||
    !stateDb ||
    dryRun ||
    result.skipReason === "already_extracted" ||
    result.skipReason === "locked_concurrent"
  )
    return;
  try {
    const outcome: ExtractedSessionRow["outcome"] = result.skipped
      ? result.skipReason === "read_failed" ||
        result.skipReason === "exception" ||
        result.skipReason === "malformed_model_output"
        ? "failed"
        : "skipped"
      : result.candidateCount === 0
        ? "no_candidates"
        : "candidates_queued";
    upsertExtractedSession(stateDb, {
      harness,
      sessionId: summary.sessionId,
      processedAt: new Date().toISOString(),
      sessionEndedAt: summary.endedAt ?? null,
      outcome,
      candidateCount: result.candidateCount,
      proposalCount: result.proposalIds.length,
      rationale: result.rationaleIfEmpty ?? null,
      sourceRun,
      contentHash:
        result.skipReason === "llm_unavailable" ||
        result.skipReason === "triaged_out" ||
        result.skipReason === "malformed_model_output"
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

function accountExtractSessionResult(
  result: ExtractSessionOutcome,
  triageEnabled: boolean,
  output: ExtractSessionLoopResult,
): ExtractedSessionResult {
  const stamped: ExtractedSessionResult = { ...result, engine: output.engine };
  output.sessions.push(stamped);
  if (triageEnabled) {
    const preempted =
      result.skipReason === "read_failed" ||
      result.skipReason === "too_short" ||
      result.skipReason === "already_extracted" ||
      result.skipReason === "locked_concurrent";
    if (!preempted) {
      output.triageEvaluated += 1;
      if (result.skipReason === "triaged_out") output.triagedOut += 1;
      else output.triagePassed += 1;
    }
  }
  if (result.skipped) output.skippedCount += 1;
  else output.processedCount += 1;
  output.allProposalIds.push(...result.proposalIds);
  return stamped;
}

/**
 * Iterate the discovered candidate sessions: enforce the per-run cap, take the
 * per-session cross-process lock, dispatch to {@link processSession}, aggregate
 * the #626 triage counters, and persist each seen-row outcome. Extracted verbatim
 * from `akmExtract` — the maxSessionsPerRun break, lock/skip accounting, triage
 * aggregation, and seen-row upsert are byte-identical.
 */
async function runExtractSessionLoop(args: ExtractSessionLoopArgs): Promise<ExtractSessionLoopResult> {
  const {
    plans,
    deferredCandidates,
    seenMap,
    options,
    harness,
    stateDb,
    trackingEnabled,
    dryRun,
    stashDir,
    config,
    llmRunner,
    onNotices,
    getNotices,
    chat,
    sourceRun,
    timeoutMs,
    triage,
    sessionIndexing,
    extractStandardsContext,
    topLevelWarnings,
  } = args;
  // WI-7.7 §2: run-scoped processSession inputs, resolved once per run.
  const sessionRunCtx: ExtractSessionRunCtx = {
    harness,
    stashDir,
    config,
    llmRunner,
    onNotices,
    getNotices,
    chat,
    ctx: options.ctx,
    eventsCtx: options.eventsCtx,
    sourceRun,
    dryRun,
    timeoutMs,
    sessionIndexing,
    signal: options.signal,
    standardsContext: extractStandardsContext,
  };
  const output: ExtractSessionLoopResult = {
    engine: llmRunner.engine,
    sessions: [],
    processedCount: 0,
    skippedCount: 0,
    triageEvaluated: 0,
    triagePassed: 0,
    triagedOut: 0,
    allProposalIds: [],
    deferred: 0,
  };

  const workPlans = [...plans];
  let remainingCandidates = deferredCandidates;
  const refillModelSlot = (): void => {
    if (remainingCandidates.length === 0 || options.signal?.aborted) return;
    const refill = planExtractSessions({
      candidates: remainingCandidates,
      options,
      harness,
      seenMap,
      maxTotalChars: args.maxTotalChars,
      minContentChars: args.minContentChars,
      maxSessionsPerRun: 1,
      triage,
      trackingEnabled,
      dryRun,
    });
    workPlans.push(...refill.plans);
    remainingCandidates = refill.deferredCandidates;
  };

  for (const plan of workPlans) {
    if (options.signal?.aborted) break;
    const { summary } = plan;
    if (plan.kind === "skip") {
      const accounted = accountExtractSessionResult(plan.result, triage.enabled, output);
      recordExtractSessionOutcome({
        stateDb,
        trackingEnabled,
        dryRun,
        harness: harness.name,
        summary,
        result: accounted,
        sourceRun,
      });
      continue;
    }

    let sessionLockOwnership: LockOwnership | undefined;
    if (trackingEnabled && !dryRun && !options.stateDb) {
      const sessionLockPath = getExtractSessionLockPath(
        harness.name,
        summary.sessionId,
        options.stateDbPath ?? getStateDbPath(),
      );
      const sessionLock = acquireExtractSessionLock(sessionLockPath);
      if (!sessionLock.proceed) {
        accountExtractSessionResult(lockedConcurrentResult(harness.name, summary), triage.enabled, output);
        refillModelSlot();
        continue;
      }
      sessionLockOwnership = sessionLock.ownership;
    }

    try {
      // Planning stays read-only so a credential failure creates no state. Once
      // this run owns the session lock, read and gate the session again: the log
      // may have grown, become too short after replacement, or been completed by
      // another extractor between the planning snapshot and acquisition.
      const currentPrior = stateDb
        ? getExtractedSessionsMap(stateDb, harness.name, [summary.sessionId]).get(summary.sessionId)
        : seenMap.get(summary.sessionId);
      const executionGate = runPreLlmSessionGates({
        harness,
        sessionRef: summary,
        prior: currentPrior,
        force: options.force === true,
        maxTotalChars: args.maxTotalChars,
        minContentChars: args.minContentChars,
        triage,
      });
      if ("skip" in executionGate) {
        const accounted = accountExtractSessionResult(executionGate.skip, triage.enabled, output);
        recordExtractSessionOutcome({
          stateDb,
          trackingEnabled,
          dryRun,
          harness: harness.name,
          summary,
          result: accounted,
          sourceRun,
        });
        refillModelSlot();
        continue;
      }
      const result = await processSession(sessionRunCtx, {
        sessionRef: summary,
        gate: executionGate,
      });
      if (result.skipReason === "malformed_model_output") {
        for (const warning of result.warnings) topLevelWarnings.push(`session ${summary.sessionId}: ${warning}`);
      }
      const accounted = accountExtractSessionResult(result, triage.enabled, output);
      recordExtractSessionOutcome({
        stateDb,
        trackingEnabled,
        dryRun,
        harness: harness.name,
        summary,
        result: accounted,
        sourceRun,
      });
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      warn(`[extract] session ${summary.sessionId} threw: ${msg}`);
      topLevelWarnings.push(`session ${summary.sessionId} threw: ${msg}`);
      accountExtractSessionResult(
        {
          sessionId: summary.sessionId,
          harness: harness.name,
          candidateCount: 0,
          proposalIds: [],
          preFilter: { inputCount: 0, outputCount: 0, truncatedCount: 0 },
          warnings: [msg],
          skipped: true,
          skipReason: "exception",
          ...extractNoticeFields(getNotices),
        },
        triage.enabled,
        output,
      );
    } finally {
      if (sessionLockOwnership) releaseLock(sessionLockOwnership);
    }
  }

  output.deferred = remainingCandidates.length;
  return output;
}

/** Resolved run-scoped config for one `akmExtract` invocation. */
interface ExtractRunConfig {
  timeoutMs: number | null;
  llmRunner: ExtractLlmRunner;
  onNotices: (notices: readonly Readonly<LoweringNotice>[]) => void;
  getNotices: () => readonly Readonly<LoweringNotice>[];
  maxTotalChars: number | undefined;
  minContentChars: number;
  maxSessionsPerRun: number;
  effectiveSince: string | undefined;
  triage: { enabled: boolean; minScore: number };
  sessionIndexing: { enabled: boolean; minDurationMinutes: number; generate: SessionSummaryGenerator };
}

/**
 * Resolve the run-scoped LLM/engine, budget, triage, and session-indexing
 * settings for one extract invocation (throwing when no engine is configured).
 * Extracted verbatim from `akmExtract` — the timeout precedence chain, the
 * session-summary generator seam, and the default resolutions are byte-identical.
 */
function resolveExtractRunConfig(
  options: AkmExtractOptions,
  config: AkmConfig,
  extractProcess: Readonly<ImproveProcessConfig> | undefined,
  activeProfile: ImproveProfileConfig | undefined,
): ExtractRunConfig {
  const executionNotices = new Map<string, Readonly<LoweringNotice>>();
  const onNotices = (notices: readonly Readonly<LoweringNotice>[]): void => {
    for (const notice of notices) executionNotices.set(JSON.stringify(notice), notice);
  };
  const getNotices = (): readonly Readonly<LoweringNotice>[] => Object.freeze([...executionNotices.values()]);

  // Improve supplies its invocation-owned symbolic runner. Standalone extract
  // resolves the selected process engine through the shared execution planner.
  let llmRunner: ExtractLlmRunner | null | undefined;
  if (options.resolvedPlan) {
    llmRunner = options.resolvedPlan.runner;
    onNotices(options.resolvedPlan.notices ?? []);
  } else if (options.llmRunner) {
    llmRunner = options.llmRunner;
  } else {
    const resolved = resolveImproveLlmExecution({
      config,
      profile: activeProfile,
      process: extractProcess,
      processName: "extract",
    });
    llmRunner = resolved?.runner;
    if (resolved) onNotices(resolved.notices);
  }
  if (!llmRunner) {
    throw new ConfigError(
      "No LLM engine configured for extract. Set defaults.llmEngine or improve.strategies.<name>.processes.extract.engine.",
      "LLM_NOT_CONFIGURED",
    );
  }

  const timeoutMs = options.resolvedPlan
    ? options.resolvedPlan.timeoutMs
    : Object.hasOwn(options, "timeoutMs")
      ? (options.timeoutMs ?? null)
      : Object.hasOwn(llmRunner, "timeoutMs")
        ? (llmRunner.timeoutMs ?? null)
        : 600_000;
  // Pre-filter budget — process config can raise it for large-context models.
  const maxTotalChars = typeof extractProcess?.maxTotalChars === "number" ? extractProcess.maxTotalChars : undefined;
  // #595/#596 — minimum raw session size; sessions below it skip the LLM call
  // entirely. Set `processes.extract.minContentChars: 0` to disable the gate.
  const minContentChars =
    typeof extractProcess?.minContentChars === "number" ? extractProcess.minContentChars : DEFAULT_MIN_CONTENT_CHARS;
  // Cap on NEW sessions LLM-processed per run; 0 disables. Absent = default.
  // Bounds per-run wall time / LLM cost so a backlog can't push a run past its
  // task timeout — the overflow stays unseen and is picked up by later runs.
  const maxSessionsPerRun = options.since
    ? 0
    : typeof extractProcess?.maxSessionsPerRun === "number"
      ? extractProcess.maxSessionsPerRun
      : DEFAULT_MAX_SESSIONS_PER_RUN;
  // Default discovery window — process config can override the built-in 24h.
  const effectiveSince = options.since ?? extractProcess?.defaultSince;

  // #626 — resolve the triage gate config once per run. Default-off → the
  // per-session path never calls the scorer and emits no telemetry.
  const triage = resolveTriageConfig(extractProcess);

  // #561 — resolve session-indexing config. Default ON: we only reach this code
  // when `session_extraction` is enabled AND an LLM is configured (both checked
  // above), so defaulting on costs nothing offline (the summary call fails open)
  // while making sessions searchable in the common LLM-configured case. Set
  // `processes.extract.indexSessions: false` for byte-identical legacy behaviour.
  const sessionIndexingEnabled = extractProcess?.indexSessions ?? true;
  const minSessionDuration =
    typeof extractProcess?.minSessionDuration === "number"
      ? extractProcess.minSessionDuration
      : DEFAULT_MIN_SESSION_DURATION_MINUTES;
  // Production summary generator: a bounded in-tree LLM call wrapped in the
  // same fail-open `callStructured` seam as the rest of extract. Returns
  // `undefined` on disablement / timeout / error so no asset is written.
  // Tests inject a fake.
  const defaultSessionSummaryGenerator: SessionSummaryGenerator = async (data) => {
    let raw = "";
    await callStructured<string>({
      feature: "session_extraction",
      akmConfig: config,
      runner: llmRunner,
      messages: [{ role: "user", content: buildSessionSummaryPrompt(data) }],
      request: {
        timeoutMs,
        responseSchema: SESSION_SUMMARY_JSON_SCHEMA,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.chat ? { chat: options.chat } : {}),
      },
      onNotices,
      parse: (r) => {
        raw = r ?? "";
        return raw;
      },
      onError: () => "",
      fallback: "",
    });
    return parseSessionSummary(raw);
  };
  const sessionIndexing = {
    enabled: sessionIndexingEnabled,
    minDurationMinutes: minSessionDuration,
    generate: options.generateSessionSummary ?? defaultSessionSummaryGenerator,
  };

  return {
    timeoutMs,
    llmRunner,
    onNotices,
    getNotices,
    maxTotalChars,
    minContentChars,
    maxSessionsPerRun,
    effectiveSince,
    triage,
    sessionIndexing,
  };
}

/**
 * Resolve the session set to process: the single `--session-id` target (or a
 * not-found envelope) or the discovery-window listing. Extracted verbatim from
 * `akmExtract`; the 48h default-since floor and location filter are unchanged.
 */
function discoverExtractCandidates(
  options: AkmExtractOptions,
  harness: SessionLogHarness,
  effectiveSince: string | undefined,
  startMs: number,
  dryRun: boolean,
  llmRunner: ExtractLlmRunner,
): { candidates: SessionSummary[] } | { notFound: AkmExtractResult } {
  if (options.sessionId) {
    const all = harness.listSessions({
      ...(options.location ? { location: options.location } : {}),
    });
    const target = all.find((s) => s.sessionId === options.sessionId);
    if (!target) {
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
    return { candidates: [target] };
  }
  // No explicit `--since`/`defaultSince` → default to "since the last run"
  // (floored at 48h) so an intermittently-online host doesn't lose sessions
  // that ended while it was off. See {@link resolveDefaultSinceMs}.
  const sinceMs = effectiveSince
    ? parseSinceArg(effectiveSince)
    : resolveDefaultSinceMs(harness.name, startMs, {
        ...(options.stateDb ? { stateDb: options.stateDb } : {}),
        ...(options.stateDbPath ? { stateDbPath: options.stateDbPath } : {}),
        ...(options.skipTracking ? { skipTracking: options.skipTracking } : {}),
      });
  return {
    candidates: harness.listSessions({
      sinceMs,
      ...(options.location ? { location: options.location } : {}),
    }),
  };
}

// ── Public entrypoint ────────────────────────────────────────────────────────

/**
 * WI-9.10: build one `akm extract` run's {@link RunContext} from values
 * `akmExtract` has already resolved by the time it calls this (config,
 * stashDir, dryRun, sourceRun, and `resolveExtractRunConfig`'s symbolic runner)
 * — no second config load, credential materialization, or new db handle.
 */
function buildExtractRunContext(args: {
  options: AkmExtractOptions;
  config: AkmConfig;
  stashDir: string;
  dryRun: boolean;
  sourceRun: string;
  llmRunner: ExtractLlmRunner;
}): RunContext {
  const { options, config, stashDir, dryRun, sourceRun, llmRunner } = args;
  return createRunContext({
    stashDir,
    config,
    eventsCtx: options.eventsCtx ?? {},
    // Not yet wired into any proposal call site this stage (mirrors
    // buildImproveRunContext's proposalsCtx comment in improve.ts).
    proposalsCtx: options.ctx ?? {},
    getLlmRunner: () => llmRunner,
    sourceRun,
    dryRun,
    signal: options.signal,
  });
}

function loadExtractSeenMapReadOnly(args: {
  options: AkmExtractOptions;
  harness: string;
  candidates: SessionSummary[];
  trackingEnabled: boolean;
  warnings: string[];
}): Map<string, ExtractedSessionRow> {
  const { options, harness, candidates, trackingEnabled, warnings } = args;
  if (!trackingEnabled || candidates.length === 0) return new Map();
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

function openExtractLiveStateDb(args: {
  options: AkmExtractOptions;
  trackingEnabled: boolean;
  hasModelWork: boolean;
  dryRun: boolean;
  warnings: string[];
}): Database | undefined {
  const { options, trackingEnabled, hasModelWork, dryRun, warnings } = args;
  if (!trackingEnabled) return undefined;
  if (options.stateDb) return options.stateDb;
  if (!hasModelWork || dryRun) return undefined;
  try {
    return openStateDatabase(options.stateDbPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`[extract] state.db unavailable, processing without skip-tracking: ${msg}`);
    warnings.push(`state.db unavailable: ${msg}`);
    return undefined;
  }
}

function emitExtractTriageEvent(args: {
  modelPlanCount: number;
  triageEnabled: boolean;
  result: ExtractSessionLoopResult;
  sourceRun: string;
  eventsCtx: EventsContext | undefined;
}): void {
  const { modelPlanCount, triageEnabled, result, sourceRun, eventsCtx } = args;
  if (modelPlanCount === 0 || !triageEnabled || result.triageEvaluated === 0) return;
  appendEvent(
    {
      eventType: "extract_triaged",
      metadata: {
        evaluated: result.triageEvaluated,
        passed: result.triagePassed,
        triagedOut: result.triagedOut,
        sourceRun,
      },
    },
    eventsCtx,
  );
}

/**
 * Count every session's `skipReason` (#912) and push one warning line per
 * infrastructure reason in {@link EXTRACT_INFRASTRUCTURE_SKIP_REASONS}.
 * `undefined` when nothing was skipped, so the envelope carries no key.
 */
function buildExtractSkipAggregate(
  sessions: readonly ExtractedSessionResult[],
  engine: string,
  warnings: string[],
): AkmExtractResult["skipReasons"] {
  const counts: NonNullable<AkmExtractResult["skipReasons"]> = {};
  for (const session of sessions) {
    if (!session.skipReason) continue;
    counts[session.skipReason] = (counts[session.skipReason] ?? 0) + 1;
  }
  if (Object.keys(counts).length === 0) return undefined;
  const total = sessions.length;
  for (const reason of EXTRACT_INFRASTRUCTURE_SKIP_REASONS) {
    const n = counts[reason];
    if (n) warnings.push(`${n} of ${total} sessions skipped: ${reason} (engine "${engine}")`);
  }
  return counts;
}

export async function akmExtract(options: AkmExtractOptions): Promise<AkmExtractResult> {
  const startMs = Date.now();
  if (!options.type || options.type.trim() === "") {
    throw new UsageError("--type is required. Pass a harness name (e.g. --type claude).", "MISSING_REQUIRED_ARGUMENT");
  }

  const config = options.config ?? loadConfig();
  const stashDir = resolveRunStashDir(options.stashDir);
  const dryRun = options.dryRun ?? false;
  const sourceRun = options.sourceRun ?? `extract-${timestampForFilename()}`;

  // Read process behavior from the frozen standalone plan or the active improve
  // strategy. This prevents config changes during watch mode from changing later
  // triggers and prevents one improve strategy from overriding another.
  const activeProfile =
    options.improveProfile ?? (options.resolvedPlan ? undefined : resolveImproveStrategy(undefined, config).config);
  const extractProcess = options.resolvedPlan?.process ?? getImproveProcessConfig("extract", activeProfile);
  // The `extract.enabled` process toggle gates extract as a STAGE of `akm improve`
  // (the activeProfile path) — consistent with #593/#594 where the active profile,
  // not `default`, is the source of truth. An EXPLICIT `akm extract` invocation
  // (no activeProfile) is a direct user/cron action and always runs; gating it on
  // the default improve profile's stage toggle was a footgun — dropping extract
  // from the daily improve profile would silently disable the standalone command.
  const extractEnabled =
    options.resolvedPlan?.enabled ??
    (options.improveProfile ? resolveProcessEnabled("extract", options.improveProfile) : true);

  // Feature-gate early so we get a clean "skipped because disabled" envelope.
  if (!extractEnabled) {
    return emptyExtractResult({
      ok: true,
      dryRun,
      type: options.type,
      warning: "extract is disabled by the selected improve strategy",
      startMs,
    });
  }

  const {
    timeoutMs,
    llmRunner,
    onNotices,
    getNotices,
    maxTotalChars,
    minContentChars,
    maxSessionsPerRun,
    effectiveSince,
    triage,
    sessionIndexing,
  } = resolveExtractRunConfig(options, config, extractProcess, activeProfile);

  // WI-9.10: construct this run's RunContext (extracted to
  // buildExtractRunContext to keep akmExtract under the fn-size bar — R31).
  const ctx = buildExtractRunContext({ options, config, stashDir, dryRun, sourceRun, llmRunner });

  const harness = resolveHarness(options.type, options.harnesses);
  if (!harness) {
    return emptyExtractResult({
      ok: false,
      dryRun,
      type: options.type,
      warning: `no available harness matches type "${options.type}" (check that the platform is installed)`,
      startMs,
      llmRunner,
    });
  }
  if (!harness.isAvailable()) {
    return emptyExtractResult({
      ok: false,
      dryRun,
      type: options.type,
      warning: `harness ${options.type} is registered but reports not-available (no session data on this machine)`,
      startMs,
      llmRunner,
    });
  }

  // Decide which sessions to process: explicit sessionId OR discovery via since.
  const discovery = discoverExtractCandidates(options, harness, effectiveSince, startMs, dryRun, llmRunner);
  if ("notFound" in discovery) return discovery.notFound;
  const candidates = discovery.candidates;

  const topLevelWarnings: string[] = [];
  const trackingEnabled = options.skipTracking !== true;
  const seenMap = loadExtractSeenMapReadOnly({
    options,
    harness: harness.name,
    candidates,
    trackingEnabled,
    warnings: topLevelWarnings,
  });
  const planned = planExtractSessions({
    candidates,
    options,
    harness,
    seenMap,
    maxTotalChars,
    minContentChars,
    maxSessionsPerRun,
    triage,
    trackingEnabled,
    dryRun,
  });
  const modelPlanCount = planned.plans.filter((plan) => plan.kind === "model").length;

  // Eligible dry-runs still dispatch to produce their candidate preview. Only
  // deterministic no-work plans are credential-free. Materialize once after
  // every read-only gate and before opening live state or acquiring a lock.
  if (modelPlanCount > 0) assertRunnerCredentials(llmRunner);
  let stateDb: Database | undefined;
  let loopResult: ExtractSessionLoopResult;
  try {
    stateDb = openExtractLiveStateDb({
      options,
      trackingEnabled,
      hasModelWork: modelPlanCount > 0,
      dryRun,
      warnings: topLevelWarnings,
    });

    // Stash authoring standards (convention/meta fact bodies) for non-wiki
    // extract output. Resolved ONCE per run and threaded into each session's
    // prompt so facts are not re-read per session.
    const extractStandardsContext = modelPlanCount > 0 ? resolveExtractStandards(stashDir) : "";

    loopResult = await runExtractSessionLoop({
      plans: planned.plans,
      deferredCandidates: planned.deferredCandidates,
      seenMap,
      options,
      harness,
      stateDb,
      trackingEnabled,
      dryRun,
      stashDir,
      config,
      llmRunner,
      onNotices,
      getNotices,
      chat: options.chat,
      sourceRun,
      timeoutMs,
      maxTotalChars,
      minContentChars,
      triage,
      sessionIndexing,
      extractStandardsContext,
      topLevelWarnings,
    });
  } finally {
    if (stateDb && !options.stateDb) {
      try {
        stateDb.close();
      } catch {
        // best-effort close
      }
    }
  }
  const { sessions, processedCount, skippedCount, allProposalIds } = loopResult;
  if (loopResult.deferred > 0) {
    topLevelWarnings.push(
      `Reached maxSessionsPerRun=${maxSessionsPerRun}; ${loopResult.deferred} session(s) deferred to a later run.`,
    );
  }
  const skipReasons = buildExtractSkipAggregate(sessions, llmRunner.engine, topLevelWarnings);

  emitExtractTriageEvent({
    modelPlanCount,
    triageEnabled: triage.enabled,
    result: loopResult,
    sourceRun,
    eventsCtx: options.eventsCtx,
  });

  return {
    schemaVersion: 1,
    ok: true,
    shape: "extract-result",
    // Sourced from ctx (identical value to the local `dryRun` — see the
    // RunContext construction above) so the constructed RunContext has a
    // genuine downstream reference in this verb, which currently has no
    // content-read site to route through ctx.readAsset (see the WI-9.10c
    // report).
    dryRun: ctx.dryRun,
    type: options.type,
    sessionsProcessed: processedCount,
    sessionsSkipped: skippedCount,
    candidatesCreated: allProposalIds.length,
    proposals: allProposalIds,
    sessions,
    warnings: topLevelWarnings,
    durationMs: Date.now() - startMs,
    ...(getNotices().length > 0 ? { notices: getNotices() } : {}),
    ...(skipReasons ? { skipReasons } : {}),
    engine: llmRunner.engine,
    engineKind: llmRunner.kind,
  };
}

/** Options for {@link countNewExtractCandidates}. */
export interface CountNewExtractCandidatesOptions {
  /** Discovery cutoff (ISO timestamp or duration like `24h`). Defaults to harness/process default. */
  since?: string;
  /** Override the harness registry (test seam). */
  harnesses?: SessionLogHarness[];
  /** Override state.db handle (test seam). */
  stateDb?: Database;
  /**
   * C2 (#554): explicit state.db path (used only when `stateDb` is absent).
   * `akmImprove` threads its boundary-resolved path so the candidate-count
   * gate never re-reads `XDG_DATA_HOME` live mid-run.
   */
  stateDbPath?: string;
  /** Active improve profile, so the discovery window honors `--profile`. */
  improveProfile?: ImproveProfileConfig;
  /**
   * Planning-only mode. Never creates state.db; when no borrowed handle is
   * available, every in-window session is conservatively treated as new.
   */
  readOnly?: boolean;
}

/**
 * Count NEW (unseen, in-window) extract candidate sessions across all available
 * harnesses WITHOUT making any LLM calls. Mirrors the discovery + seen-filter
 * logic in {@link akmExtract} so the `#554 minNewSessions` gate in `improve`
 * can decide whether the extract pass is worth running before any work begins.
 *
 * #602 — this gate is intentionally CHEAP: it does NOT read session bodies, so
 * it cannot compute the content hash that {@link shouldSkipAlreadyExtractedSession}
 * now uses. It therefore uses a CONSERVATIVE row-presence approximation: a
 * session counts as "new" when there is NO prior row OR the prior row's
 * `content_hash` is null (never-seen or backfill-eligible). A prior row WITH a
 * non-null content_hash counts as NOT new — it MIGHT have changed, but the
 * precise per-session hash check happens downstream in processSession, so an
 * over-/under-count here only affects whether the pass RUNS, never whether a
 * changed session is actually re-processed.
 */
export function countNewExtractCandidates(_config: AkmConfig, options: CountNewExtractCandidatesOptions = {}): number {
  const extractProcess = getImproveProcessConfig("extract", options.improveProfile);
  const effectiveSince = options.since ?? extractProcess?.defaultSince;
  // Mirror akmExtract: when no explicit window is set, default per-harness to
  // "since the last run" (floored at 48h) instead of a fixed 24h. Keeps this
  // gate's discovery window identical to what akmExtract will actually scan.
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
      const candidates = harness.listSessions({
        sinceMs,
        ...(options.readOnly ? { isolatedSnapshot: true } : {}),
      });
      if (candidates.length === 0) continue;

      // A dry planner with no pre-existing state database has no seen-session
      // ledger by definition. Count the discovered sessions directly instead
      // of creating state.db merely to prove that it is empty.
      if (options.readOnly && !stateDb) {
        total += candidates.length;
        continue;
      }

      let seenMap = new Map<string, ExtractedSessionRow>();
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
        // state.db unavailable — treat every in-window session as a new
        // candidate (fail-open: never let a transient sqlite error wrongly
        // trip the gate and skip a pass that should have run).
        const msg = err instanceof Error ? err.message : String(err);
        warn(`[extract] state.db unavailable while counting candidates, treating all as new: ${msg}`);
        total += candidates.length;
        continue;
      }

      for (const summary of candidates) {
        const prior = seenMap.get(summary.sessionId);
        // #602 row-presence approximation (see fn doc): a prior row WITH a
        // non-null content_hash is treated as not-new here; everything else
        // (never-seen, or null-hash backfill-eligible) counts as new.
        if (prior && prior.content_hash != null) continue;
        total += 1;
      }
    }
  } finally {
    if (stateDb && openedStateDb) {
      try {
        stateDb.close();
      } catch {
        // best-effort close
      }
    }
  }
  return total;
}
