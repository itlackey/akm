// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm extract` — session-insight extractor.
 *
 * Replaces the akm-plugin session-checkpoint hook with an on-demand extractor
 * that reads native session files (claude-code JSONL, opencode storage tree)
 * through the {@link SessionLogHarness} registry, pre-filters noise, and asks
 * a bounded in-tree LLM to produce candidate memory/lesson/knowledge proposals
 * for content the agent did NOT preserve via inline `akm remember`/`akm feedback`.
 *
 * Architectural notes:
 *   - Stateless. All file/LLM access goes through injectable seams so tests
 *     never touch a real platform.
 *   - Bounded LLM call routed through `callStructured` under the
 *     `session_extraction` gate (default-on; opt out via
 *     `improve.strategies.<name>.processes.extract.enabled: false`).
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
import { tryAcquireMaintenanceBarrier } from "../../core/maintenance-barrier";
import { resolveStashStandards } from "../../core/standards/resolve-stash-standards";
import { resolveTypeConventions, typeConventionRef } from "../../core/standards/resolve-type-conventions";
import { getStateDbPath, openStateDatabase, withStateDb } from "../../core/state-db";
import { repairTruncatedDescription } from "../../core/text-truncation";
import { warn } from "../../core/warn";
import { indexWrittenAssets } from "../../indexer/index-written-assets";
import { resolveLlmEngineUse } from "../../integrations/agent/engine-resolution";
import {
  materializeLlmRunnerConnection,
  type RunnerSpec,
  resolveImproveProcessRunner,
} from "../../integrations/agent/runner";
import { normalizeHarnessId } from "../../integrations/harnesses";
import { getAvailableHarnesses } from "../../integrations/session-logs";
import { preFilterSession } from "../../integrations/session-logs/pre-filter";
import type { SessionData, SessionLogHarness, SessionRef, SessionSummary } from "../../integrations/session-logs/types";
import type { ChatMessage } from "../../llm/client";
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
import { isProposalSkipped, type ProposalsContext } from "../proposal/repository";
import { buildExtractPrompt, EXTRACT_JSON_SCHEMA, type ExtractCandidate, parseExtractPayload } from "./extract-prompt";
import { resolveImproveStrategy, resolveProcessEnabled } from "./improve-strategies";
import { emitProposal } from "./proposal-envelope";
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
  try {
    return withStateDb(
      (db) => {
        const lastRun = getLastExtractRunAt(db, harnessName);
        return lastRun != null ? Math.min(lastRun, floor) : floor;
      },
      { path: opts.stateDbPath, borrowed: opts.stateDb },
    );
  } catch {
    return floor;
  }
}

/** Filesystem-safe per-session lock path, co-located with the state.db. */
function getExtractSessionLockPath(harness: string, sessionId: string, stateDbPath: string): string {
  const safe = `${harness}-${sessionId}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(path.dirname(stateDbPath), "extract-locks", `extract-${safe}.lock`);
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
  const releaseBarrier = tryAcquireMaintenanceBarrier();
  if (!releaseBarrier) return { proceed: false };
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
  } finally {
    releaseBarrier();
  }
}

// ── Options + Result envelopes ──────────────────────────────────────────────

export interface AkmExtractOptions {
  /** Harness name (e.g. "claude-code", "opencode"). Required. */
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
  /** Pre-resolved connection supplied by the improve invocation plan. */
  llmConfig?: LlmProfileConfig;
  /** Complete standalone invocation plan, resolved once at the CLI boundary. */
  resolvedPlan?: ResolvedExtractPlan;
  /** Override the harness registry (test seam). */
  harnesses?: SessionLogHarness[];
  /**
   * Override the LLM chat function (test seam). When absent, `callStructured`
   * dispatches to the real late-bound `chatCompletion` transport.
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
  const process = cloneAndFreeze(getImproveProcessConfig(config, "extract", selected.config) ?? {});
  const invocation = {
    ...(selection.engine ? { engine: selection.engine } : {}),
    ...(Object.hasOwn(selection, "timeoutMs") ? { timeoutMs: selection.timeoutMs ?? null } : {}),
  };
  const resolved = resolveLlmEngineUse(config, [selected.config, process, invocation], { optional: true });
  if (!resolved) {
    throw new ConfigError(
      "No LLM engine configured for extract. Set defaults.llmEngine, pass --engine, or select an improve strategy with processes.extract.engine.",
      "LLM_NOT_CONFIGURED",
    );
  }
  const runner: ExtractLlmRunner = {
    kind: "llm",
    engine: resolved.engine,
    connection: resolved.connection,
    ...(resolved.credential ? { credential: resolved.credential } : {}),
    timeoutMs: resolved.timeoutMs,
  };
  return Object.freeze({
    strategy: selected.name,
    engine: resolved.engine,
    // `akm extract` is an explicit operation. The strategy supplies behavior,
    // but its improve-stage enablement gate does not disable this command.
    enabled: true,
    process,
    runner: cloneAndFreeze(runner),
    timeoutMs: resolved.timeoutMs,
    embeddingConfig: cloneAndFreeze(config.embedding),
  });
}

export interface ExtractedSessionResult {
  sessionId: string;
  harness: string;
  candidateCount: number;
  proposalIds: string[];
  /** When candidates was empty, the LLM's explanation. */
  rationaleIfEmpty?: string;
  /** Pre-filter stats for the session. */
  preFilter: { inputCount: number; outputCount: number; truncatedCount: number };
  warnings: string[];
  skipped?: boolean;
  skipReason?:
    | "read_failed"
    | "llm_unavailable"
    | "exception"
    | "already_extracted"
    | "too_short"
    | "triaged_out"
    | "locked_concurrent";
  /** #561 — canonical ref of the session asset written for this session, when indexing is enabled and a summary was produced. */
  sessionAssetRef?: string;
  /** #561 — log_path recorded in the session asset frontmatter (durable correlation key). */
  sessionLogPath?: string;
  /**
   * #602 — sha256 (hex) of the normalized session content computed at process
   * time. Undefined only when the session failed to read (read_failed) before a
   * hash could be computed; the caller persists `contentHash ?? null` so such
   * rows stay eligible for retry.
   */
  contentHash?: string;
}

export interface AkmExtractResult {
  schemaVersion: 1;
  ok: boolean;
  shape: "extract-result";
  dryRun: boolean;
  type: string;
  sessionsProcessed: number;
  sessionsSkipped: number;
  candidatesCreated: number;
  proposals: string[];
  sessions: ExtractedSessionResult[];
  warnings: string[];
  durationMs: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a since-string into an absolute ms-epoch cutoff. Accepts:
 *   - ISO timestamps (parsed via Date.parse)
 *   - Relative durations: `<n>m`, `<n>h`, `<n>d` (minutes / hours / days)
 *
 * Throws UsageError on unparseable input so the CLI surfaces a clear error
 * rather than silently defaulting.
 */
export function parseSinceArg(value: string | undefined, now: number = Date.now()): number {
  if (!value || value.trim() === "") {
    return now - 24 * 60 * 60 * 1000; // default: 24h
  }
  const trimmed = value.trim();
  const relMatch = trimmed.match(/^(\d+)\s*([mhd])$/i);
  if (relMatch) {
    const n = Number.parseInt(relMatch[1] ?? "0", 10);
    const unit = (relMatch[2] ?? "h").toLowerCase();
    const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return now - ms;
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
  // #563 id-normalization bridge: a provider's `name` is its runtime id (e.g.
  // the Claude provider is "claude-code"), but the canonical harness id is
  // "claude". Normalize BOTH the requested `--type` and each provider name to
  // canonical before comparing, so `--type claude` and `--type claude-code`
  // both resolve to the Claude provider. Behaviour fix: previously only the
  // exact runtime string ("claude-code") matched; the canonical "claude" used
  // everywhere else (agent profiles, config schema) silently found nothing.
  const wanted = normalizeHarnessId(type);
  return pool.find((h) => normalizeHarnessId(h.name) === wanted);
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
    return `${candidate.type}:${scope ? `${scope}/` : ""}${leaf}`;
  }
  return `knowledge:${leaf}`;
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
  | { skip: ExtractedSessionResult }
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
    return {
      skip: {
        sessionId: sessionRef.sessionId,
        harness: harness.name,
        candidateCount: 0,
        proposalIds: [],
        preFilter: { inputCount: 0, outputCount: 0, truncatedCount: 0 },
        warnings: [`already extracted (content unchanged) at ${prior?.processed_at}; pass --force to re-process`],
        skipped: true,
        skipReason: "already_extracted",
        contentHash,
      },
    };
  }

  const filtered = preFilterSession(data, {
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

/**
 * Run-scoped inputs shared by every {@link processSession} call — resolved once
 * per extract run by {@link runExtractSessionLoop}. WI-7.7 §2: the former
 * 18-positional-argument signature collapsed to `(runCtx, session)`.
 */
interface ExtractSessionRunCtx {
  harness: SessionLogHarness;
  stashDir: string;
  config: AkmConfig;
  getLlmConfig: () => LlmProfileConfig;
  chat: AkmExtractOptions["chat"];
  ctx: ProposalsContext | undefined;
  /** R25: events carrier — event emits only; proposals keep `ctx`. */
  eventsCtx: EventsContext | undefined;
  sourceRun: string;
  dryRun: boolean;
  timeoutMs: number | null;
  maxTotalChars: number | undefined;
  minContentChars: number;
  /**
   * #626 — pre-LLM heuristic triage gate. Default-off (enabled:false) takes the
   * exact pre-change path (no scorer call, no new skipReason).
   */
  triage: { enabled: boolean; minScore: number };
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
  prior: ExtractedSessionRow | undefined;
  force: boolean;
}

/**
 * The bounded per-session extraction LLM call. Resolves the connection with
 * the same fail-open contract the gated fn had (a `getLlmConfig()` throw —
 * `materializeLlmConnection` can raise ConfigError — takes the skipped path,
 * never propagates), then routes through `callStructured` under the
 * `session_extraction` gate. Returns the seam result plus the `llmRaw`
 * side-channel value that distinguishes fallback-took-over from a
 * genuinely-empty response.
 */
async function runSessionExtractionLlmCall(args: {
  config: AkmConfig;
  getLlmConfig: () => LlmProfileConfig;
  chat: AkmExtractOptions["chat"];
  prompt: string;
  timeoutMs: number | null;
  signal: AbortSignal | undefined;
}): Promise<{ llmResult: string; llmRaw: string }> {
  const { config, getLlmConfig, chat, prompt, timeoutMs, signal } = args;
  let extractLlm: LlmProfileConfig | undefined;
  try {
    extractLlm = getLlmConfig();
  } catch {
    extractLlm = undefined;
  }
  let llmRaw = "";
  const llmResult =
    extractLlm === undefined
      ? ""
      : await callStructured<string>({
          feature: "session_extraction",
          akmConfig: config,
          config: extractLlm,
          messages: [{ role: "user", content: prompt }],
          request: {
            timeoutMs,
            responseSchema: EXTRACT_JSON_SCHEMA,
            ...(signal ? { signal } : {}),
            ...(chat ? { chat } : {}),
          },
          parse: (raw) => {
            llmRaw = raw ?? "";
            return llmRaw;
          },
          // A transport throw takes the "" fallback with llmRaw left unset —
          // the same skipped path the gated-fn throw produced before.
          onError: () => "",
          fallback: "",
        });
  return { llmResult, llmRaw };
}

async function processSession(
  runCtx: ExtractSessionRunCtx,
  session: ExtractSessionInput,
): Promise<ExtractedSessionResult> {
  const {
    harness,
    stashDir,
    config,
    getLlmConfig,
    chat,
    ctx,
    eventsCtx,
    sourceRun,
    dryRun,
    timeoutMs,
    maxTotalChars,
    minContentChars,
    triage,
    sessionIndexing,
    signal,
    standardsContext,
  } = runCtx;
  const { sessionRef, prior, force } = session;
  const warnings: string[] = [];
  const gate = runPreLlmSessionGates({ harness, sessionRef, prior, force, maxTotalChars, minContentChars, triage });
  if ("skip" in gate) return gate.skip;
  const { data, filtered, contentHash } = gate;

  const prompt = buildExtractPrompt({
    data,
    events: filtered.events,
    inlineRefs: data.inlineRefs,
    ...(standardsContext.trim() ? { standardsContext } : {}),
  });

  // #561 — ADDITIVE session indexing. Generate + write the session asset
  // (`sessions/<harness>/<id>.md`). FAIL-OPEN: any failure only records a
  // warning; it NEVER changes the proposal/skip outcome of extract. Returns the
  // frontmatter fields to merge into the per-session result for state-db
  // correlation. When disabled this closure makes NO LLM call and writes NOTHING.
  const maybeWriteSessionAsset = async (): Promise<{ sessionAssetRef?: string; sessionLogPath?: string }> => {
    if (!sessionIndexing.enabled || dryRun) return {};
    if (!sessionMeetsDurationGate(data, sessionIndexing.minDurationMinutes)) return {};
    try {
      const result = await writeSessionAsset(data, stashDir, sessionIndexing.generate);
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
      warnings.push(`session asset write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {};
  };

  const { llmResult, llmRaw } = await runSessionExtractionLlmCall({
    config,
    getLlmConfig,
    chat,
    prompt,
    timeoutMs,
    signal,
  });

  if (llmResult === "" && !llmRaw) {
    // The seam took the fallback path (disabled / timeout / error). Return skipped.
    return {
      sessionId: sessionRef.sessionId,
      harness: harness.name,
      candidateCount: 0,
      proposalIds: [],
      preFilter: {
        inputCount: filtered.stats.inputCount,
        outputCount: filtered.stats.outputCount,
        truncatedCount: filtered.stats.truncatedCount,
      },
      warnings: ["session_extraction feature returned empty (disabled / timeout / error)"],
      skipped: true,
      skipReason: "llm_unavailable",
      contentHash,
    };
  }

  const payload = parseExtractPayload(llmRaw);
  const proposalIds: string[] = [];
  // Provenance refs are added only after the cited session asset exists.
  const sessionAsset = await maybeWriteSessionAsset();

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
    };
  }

  // §23.6 fingerprint model-id term: the profile resolved for this session's
  // LLM call (best-effort — an unconfigured profile leaves the term empty).
  let extractModelId: string | undefined;
  try {
    extractModelId = runCtx.getLlmConfig().model;
  } catch {
    extractModelId = undefined;
  }
  for (const candidate of payload.candidates) {
    const built = buildCandidateProposal(candidate, data.ref, sessionAsset.sessionAssetRef);
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
          // §23.6 fingerprint model-id term (WI-6.4). The LLM already ran for
          // this session, so the profile is resolvable; guard anyway.
          ...(extractModelId ? { modelId: extractModelId } : {}),
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
      if (isProposalSkipped(result)) {
        warnings.push(`candidate ${candidate.type}:${candidate.name} skipped: ${result.reason}: ${result.message}`);
      } else {
        proposalIds.push(result.id);
      }
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
  };
}

/** Run-scoped inputs for {@link runExtractSessionLoop}. */
interface ExtractSessionLoopArgs {
  candidates: SessionSummary[];
  options: AkmExtractOptions;
  harness: SessionLogHarness;
  seenMap: Map<string, ExtractedSessionRow>;
  stateDb: Database | undefined;
  trackingEnabled: boolean;
  dryRun: boolean;
  stashDir: string;
  config: AkmConfig;
  getLlmConfig: () => LlmProfileConfig;
  chat: AkmExtractOptions["chat"];
  sourceRun: string;
  timeoutMs: number | null;
  maxTotalChars: number | undefined;
  minContentChars: number;
  maxSessionsPerRun: number;
  triage: { enabled: boolean; minScore: number };
  sessionIndexing: { enabled: boolean; minDurationMinutes: number; generate: SessionSummaryGenerator };
  extractStandardsContext: string;
  /** Mutated in place with run-level (non-session) warnings. */
  topLevelWarnings: string[];
}

/** Accumulated per-run tallies + results produced by {@link runExtractSessionLoop}. */
interface ExtractSessionLoopResult {
  sessions: ExtractedSessionResult[];
  processedCount: number;
  skippedCount: number;
  triageEvaluated: number;
  triagePassed: number;
  triagedOut: number;
  allProposalIds: string[];
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
    candidates,
    options,
    harness,
    seenMap,
    stateDb,
    trackingEnabled,
    dryRun,
    stashDir,
    config,
    getLlmConfig,
    chat,
    sourceRun,
    timeoutMs,
    maxTotalChars,
    minContentChars,
    maxSessionsPerRun,
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
    getLlmConfig,
    chat,
    ctx: options.ctx,
    eventsCtx: options.eventsCtx,
    sourceRun,
    dryRun,
    timeoutMs,
    maxTotalChars,
    minContentChars,
    triage,
    sessionIndexing,
    signal: options.signal,
    standardsContext: extractStandardsContext,
  };
  const sessions: ExtractedSessionResult[] = [];
  let processedCount = 0;
  let skippedCount = 0;
  // #626 — per-run triage aggregation counters (counts-only telemetry, AC4).
  let triageEvaluated = 0;
  let triagePassed = 0;
  let triagedOut = 0;
  const allProposalIds: string[] = [];

  for (const summary of candidates) {
    if (options.signal?.aborted) break;
    // #602 — the already-extracted skip moved INTO processSession (the content
    // hash needs the session body, only available after readSession). The prior
    // row + bypass flags are threaded through; an unchanged session returns
    // skipReason 'already_extracted' WITHOUT any LLM call.
    const prior = seenMap.get(summary.sessionId);

    // Per-run cap on LLM-processed sessions (skip-tracked seen sessions above
    // don't count). Single-session / --force modes bypass the cap (explicit
    // intent). Overflow sessions are left unseen for the next run.
    if (!options.sessionId && !options.force && maxSessionsPerRun > 0 && processedCount >= maxSessionsPerRun) {
      topLevelWarnings.push(
        `Reached maxSessionsPerRun=${maxSessionsPerRun}; ${candidates.length - processedCount - skippedCount} session(s) deferred to a later run.`,
      );
      break;
    }

    // Q5 — per-session lock so two concurrent extracts (e.g. a session-end hook
    // firing `--session-id` while the hourly improve discovery pass runs) can't
    // both LLM-process the SAME session. The holder records the outcome; a
    // second run skips without any LLM call. Engaged only for real cross-process
    // runs (those that open their own state.db): dry-run is read-only, an
    // injected `stateDb` handle is an in-process/test scenario with no cross-
    // process race, and skip-tracking-off opts out entirely.
    let sessionLockOwnership: LockOwnership | undefined;
    if (trackingEnabled && !dryRun && !options.stateDb) {
      const sessionLockPath = getExtractSessionLockPath(
        harness.name,
        summary.sessionId,
        options.stateDbPath ?? getStateDbPath(),
      );
      const sessionLock = acquireExtractSessionLock(sessionLockPath);
      if (!sessionLock.proceed) {
        sessions.push({
          sessionId: summary.sessionId,
          harness: harness.name,
          candidateCount: 0,
          proposalIds: [],
          preFilter: { inputCount: 0, outputCount: 0, truncatedCount: 0 },
          warnings: ["concurrent extract holds this session's lock — skipped (handled by the other run)"],
          skipped: true,
          skipReason: "locked_concurrent",
        });
        skippedCount += 1;
        continue;
      }
      sessionLockOwnership = sessionLock.ownership;
    }

    try {
      const result = await processSession(sessionRunCtx, {
        sessionRef: summary,
        prior,
        force: options.force === true,
      });
      sessions.push(result);
      // #626 — triage aggregation. A session reached the triage gate only when it
      // was NOT already preempted by an earlier skip (read_failed / too_short /
      // already_extracted handled above the processSession call). When triage is
      // enabled, processSession either triages-out (skipReason 'triaged_out') or
      // proceeds past the gate — both count as "evaluated".
      if (triage.enabled) {
        const preemptedBeforeTriage =
          result.skipReason === "read_failed" ||
          result.skipReason === "too_short" ||
          result.skipReason === "already_extracted";
        if (!preemptedBeforeTriage) {
          triageEvaluated += 1;
          if (result.skipReason === "triaged_out") triagedOut += 1;
          else triagePassed += 1;
        }
      }
      if (result.skipped) skippedCount += 1;
      else processedCount += 1;
      allProposalIds.push(...result.proposalIds);

      // Persist outcome so the next run skips this session unless its content
      // changes. We only track non-dry-run paths — dry-run is for inspection
      // and should never poison the seen-table. #602: an `already_extracted`
      // skip is a no-op (the row already carries the matching hash), so don't
      // re-write it — that keeps `processed_at` stable across unchanged runs.
      if (trackingEnabled && stateDb && !dryRun && result.skipReason !== "already_extracted") {
        try {
          const outcome: ExtractedSessionRow["outcome"] = result.skipped
            ? result.skipReason === "read_failed" || result.skipReason === "exception"
              ? "failed"
              : "skipped"
            : result.candidateCount === 0
              ? "no_candidates"
              : "candidates_queued";
          upsertExtractedSession(stateDb, {
            harness: harness.name,
            sessionId: summary.sessionId,
            processedAt: new Date().toISOString(),
            sessionEndedAt: summary.endedAt ?? null,
            outcome,
            candidateCount: result.candidateCount,
            proposalCount: result.proposalIds.length,
            rationale: result.rationaleIfEmpty ?? null,
            sourceRun,
            // #602 — persist the freshly computed content hash so the NEXT run
            // can compare byte-for-byte. read_failed (before hash) → null, which
            // keeps the row eligible for retry (matches failed-row semantics).
            // R4 — llm_unavailable (LLM was down) and triaged_out (deferred by the
            // triage gate) are transient outcomes: persist null so the null-hash
            // retry re-processes them on a later run instead of pinning them as
            // "seen" forever against the current byte content.
            contentHash:
              result.skipReason === "llm_unavailable" || result.skipReason === "triaged_out"
                ? null
                : (result.contentHash ?? null),
            metadata: {
              preFilterInputCount: result.preFilter.inputCount,
              preFilterOutputCount: result.preFilter.outputCount,
              preFilterTruncatedCount: result.preFilter.truncatedCount,
              ...(result.skipReason ? { skipReason: result.skipReason } : {}),
              // #561 — record the session's log_path for correlation across
              // index rebuilds (the session asset frontmatter is the primary
              // durable key; this is the state-db mirror of it).
              ...(result.sessionLogPath ? { logPath: result.sessionLogPath } : {}),
              ...(result.sessionAssetRef ? { sessionAssetRef: result.sessionAssetRef } : {}),
            },
          });
        } catch (err) {
          // Tracking failure must not abort the run — log + continue.
          const msg = err instanceof Error ? err.message : String(err);
          warn(`[extract] failed to record session ${summary.sessionId} in state.db: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`[extract] session ${summary.sessionId} threw: ${msg}`);
      topLevelWarnings.push(`session ${summary.sessionId} threw: ${msg}`);
      sessions.push({
        sessionId: summary.sessionId,
        harness: harness.name,
        candidateCount: 0,
        proposalIds: [],
        preFilter: { inputCount: 0, outputCount: 0, truncatedCount: 0 },
        warnings: [msg],
        skipped: true,
        skipReason: "exception",
      });
      skippedCount += 1;
    } finally {
      if (sessionLockOwnership) releaseLock(sessionLockOwnership);
    }
  }

  return { sessions, processedCount, skippedCount, triageEvaluated, triagePassed, triagedOut, allProposalIds };
}

/** Resolved run-scoped config for one `akmExtract` invocation. */
interface ExtractRunConfig {
  timeoutMs: number | null;
  getLlmConfig: () => LlmProfileConfig;
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
  // Improve supplies its invocation-owned connection. Standalone extract
  // resolves the selected process engine, then defaults.llmEngine.
  const runnerSpec = options.resolvedPlan
    ? options.resolvedPlan.runner
    : resolveImproveProcessRunner(activeProfile, "extract", config);
  const fixedLlmConfig = options.resolvedPlan ? undefined : options.llmConfig;
  if (!runnerSpec && !fixedLlmConfig) {
    throw new ConfigError(
      "No LLM engine configured for extract. Set defaults.llmEngine or improve.strategies.<name>.processes.extract.engine.",
      "LLM_NOT_CONFIGURED",
    );
  }

  const timeoutMs = options.resolvedPlan
    ? options.resolvedPlan.timeoutMs
    : Object.hasOwn(options, "timeoutMs")
      ? (options.timeoutMs ?? null)
      : runnerSpec?.timeoutMs !== undefined
        ? runnerSpec.timeoutMs
        : fixedLlmConfig && Object.hasOwn(fixedLlmConfig, "timeoutMs")
          ? (fixedLlmConfig.timeoutMs ?? null)
          : 600_000;
  const getLlmConfig = (): LlmProfileConfig =>
    runnerSpec ? materializeLlmRunnerConnection(runnerSpec) : (fixedLlmConfig as LlmProfileConfig);
  // Pre-filter budget — process config can raise it for large-context models.
  const maxTotalChars = typeof extractProcess?.maxTotalChars === "number" ? extractProcess.maxTotalChars : undefined;
  // #595/#596 — minimum raw session size; sessions below it skip the LLM call
  // entirely. Set `processes.extract.minContentChars: 0` to disable the gate.
  const minContentChars =
    typeof extractProcess?.minContentChars === "number" ? extractProcess.minContentChars : DEFAULT_MIN_CONTENT_CHARS;
  // Cap on NEW sessions LLM-processed per run; 0 disables. Absent = default.
  // Bounds per-run wall time / LLM cost so a backlog can't push a run past its
  // task timeout — the overflow stays unseen and is picked up by later runs.
  const maxSessionsPerRun =
    typeof extractProcess?.maxSessionsPerRun === "number"
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
    // Same fail-open contract as the per-session call: a getLlmConfig()
    // throw takes the "" fallback rather than propagating.
    let summaryLlm: LlmProfileConfig | undefined;
    try {
      summaryLlm = getLlmConfig();
    } catch {
      summaryLlm = undefined;
    }
    let raw = "";
    if (summaryLlm !== undefined) {
      await callStructured<string>({
        feature: "session_extraction",
        akmConfig: config,
        config: summaryLlm,
        messages: [{ role: "user", content: buildSessionSummaryPrompt(data) }],
        request: {
          timeoutMs,
          responseSchema: SESSION_SUMMARY_JSON_SCHEMA,
          ...(options.chat ? { chat: options.chat } : {}),
        },
        parse: (r) => {
          raw = r ?? "";
          return raw;
        },
        onError: () => "",
        fallback: "",
      });
    }
    return parseSessionSummary(raw);
  };
  const sessionIndexing = {
    enabled: sessionIndexingEnabled,
    minDurationMinutes: minSessionDuration,
    generate: options.generateSessionSummary ?? defaultSessionSummaryGenerator,
  };

  return {
    timeoutMs,
    getLlmConfig,
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
): { candidates: SessionSummary[] } | { notFound: AkmExtractResult } {
  if (options.sessionId) {
    const all = harness.listSessions({
      ...(options.location ? { location: options.location } : {}),
    });
    const target = all.find((s) => s.sessionId === options.sessionId);
    if (!target) {
      return {
        notFound: {
          schemaVersion: 1,
          ok: false,
          shape: "extract-result",
          dryRun,
          type: options.type,
          sessionsProcessed: 0,
          sessionsSkipped: 0,
          candidatesCreated: 0,
          proposals: [],
          sessions: [],
          warnings: [`session ${options.sessionId} not found for harness ${options.type}`],
          durationMs: Date.now() - startMs,
        },
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

export async function akmExtract(options: AkmExtractOptions): Promise<AkmExtractResult> {
  const startMs = Date.now();
  if (!options.type || options.type.trim() === "") {
    throw new UsageError(
      "--type is required. Pass a harness name (e.g. --type claude-code).",
      "MISSING_REQUIRED_ARGUMENT",
    );
  }

  const config = options.config ?? loadConfig();
  const stashDir = options.stashDir ?? resolveStashDir();
  const dryRun = options.dryRun ?? false;
  const sourceRun = options.sourceRun ?? `extract-${timestampForFilename()}`;

  // Read process behavior from the frozen standalone plan or the active improve
  // strategy. This prevents config changes during watch mode from changing later
  // triggers and prevents one improve strategy from overriding another.
  const activeProfile =
    options.improveProfile ?? (options.resolvedPlan ? undefined : resolveImproveStrategy(undefined, config).config);
  const extractProcess = options.resolvedPlan?.process ?? getImproveProcessConfig(config, "extract", activeProfile);
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
    return {
      schemaVersion: 1,
      ok: true,
      shape: "extract-result",
      dryRun,
      type: options.type,
      sessionsProcessed: 0,
      sessionsSkipped: 0,
      candidatesCreated: 0,
      proposals: [],
      sessions: [],
      warnings: ["extract is disabled by the selected improve strategy"],
      durationMs: Date.now() - startMs,
    };
  }

  const {
    timeoutMs,
    getLlmConfig,
    maxTotalChars,
    minContentChars,
    maxSessionsPerRun,
    effectiveSince,
    triage,
    sessionIndexing,
  } = resolveExtractRunConfig(options, config, extractProcess, activeProfile);

  const harness = resolveHarness(options.type, options.harnesses);
  if (!harness) {
    return {
      schemaVersion: 1,
      ok: false,
      shape: "extract-result",
      dryRun,
      type: options.type,
      sessionsProcessed: 0,
      sessionsSkipped: 0,
      candidatesCreated: 0,
      proposals: [],
      sessions: [],
      warnings: [`no available harness matches type "${options.type}" (check that the platform is installed)`],
      durationMs: Date.now() - startMs,
    };
  }
  if (!harness.isAvailable()) {
    return {
      schemaVersion: 1,
      ok: false,
      shape: "extract-result",
      dryRun,
      type: options.type,
      sessionsProcessed: 0,
      sessionsSkipped: 0,
      candidatesCreated: 0,
      proposals: [],
      sessions: [],
      warnings: [`harness ${options.type} is registered but reports not-available (no session data on this machine)`],
      durationMs: Date.now() - startMs,
    };
  }

  // Decide which sessions to process: explicit sessionId OR discovery via since.
  const discovery = discoverExtractCandidates(options, harness, effectiveSince, startMs, dryRun);
  if ("notFound" in discovery) return discovery.notFound;
  const candidates = discovery.candidates;

  const topLevelWarnings: string[] = [];

  // Open state.db once for the run and bulk-load seen-rows for the candidate
  // set so we can decide skip/process in O(1) per session. Tracking is opt-out
  // via options.skipTracking (used by tests + one-shot debug calls).
  const trackingEnabled = options.skipTracking !== true;
  let stateDb: Database | undefined;
  let seenMap = new Map<string, ExtractedSessionRow>();
  if (trackingEnabled && candidates.length > 0) {
    try {
      stateDb = options.stateDb ?? openStateDatabase(options.stateDbPath);
      seenMap = getExtractedSessionsMap(
        stateDb,
        harness.name,
        candidates.map((c) => c.sessionId),
      );
    } catch (err) {
      // state.db open is best-effort — log and proceed without skip-tracking
      // so a transient sqlite error never blocks the actual extraction.
      const msg = err instanceof Error ? err.message : String(err);
      warn(`[extract] state.db unavailable, processing without skip-tracking: ${msg}`);
      topLevelWarnings.push(`state.db unavailable: ${msg}`);
      stateDb = undefined;
    }
  }

  // Stash authoring standards (convention/meta fact bodies) for non-wiki
  // extract output. Resolved ONCE per run and threaded into each session's
  // prompt so facts are not re-read per session.
  const extractStandardsContext = resolveExtractStandards(stashDir);

  const { sessions, processedCount, skippedCount, triageEvaluated, triagePassed, triagedOut, allProposalIds } =
    await runExtractSessionLoop({
      candidates,
      options,
      harness,
      seenMap,
      stateDb,
      trackingEnabled,
      dryRun,
      stashDir,
      config,
      getLlmConfig,
      chat: options.chat,
      sourceRun,
      timeoutMs,
      maxTotalChars,
      minContentChars,
      maxSessionsPerRun,
      triage,
      sessionIndexing,
      extractStandardsContext,
      topLevelWarnings,
    });

  // Close the state.db connection we opened. Callers that injected stateDb
  // via the test seam own its lifecycle.
  if (stateDb && !options.stateDb) {
    try {
      stateDb.close();
    } catch {
      // best-effort close
    }
  }

  // #626 — counts-only triage telemetry (AC4). Exactly ONE aggregated event per
  // run, emitted only when the gate was enabled and actually evaluated at least
  // one session. No per-session events (avoids the log-spam the issue warns of).
  if (triage.enabled && triageEvaluated > 0) {
    appendEvent(
      {
        eventType: "extract_triaged",
        metadata: {
          evaluated: triageEvaluated,
          passed: triagePassed,
          triagedOut,
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
    sessionsProcessed: processedCount,
    sessionsSkipped: skippedCount,
    candidatesCreated: allProposalIds.length,
    proposals: allProposalIds,
    sessions,
    warnings: topLevelWarnings,
    durationMs: Date.now() - startMs,
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
export function countNewExtractCandidates(config: AkmConfig, options: CountNewExtractCandidatesOptions = {}): number {
  const extractProcess = getImproveProcessConfig(config, "extract", options.improveProfile);
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
        });
      const candidates = harness.listSessions({ sinceMs });
      if (candidates.length === 0) continue;

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
