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
 *   - Bounded LLM call wrapped by {@link tryLlmFeature} under the
 *     `session_extraction` gate (default-on; opt out via
 *     `profiles.improve.default.processes.extract.enabled: false`).
 *   - Proposals routed via `createProposal({ source: "extract", ... })` — the
 *     same review queue as reflect / distill / consolidate. Never direct-write.
 *   - Per-candidate body assembly merges description (+ when_to_use for lessons)
 *     into the body's YAML frontmatter so the accept-time
 *     descriptionQualityValidator passes — same pattern as the
 *     consolidate-writer fix.
 */

import { assembleAsset } from "../../core/asset/asset-serialize";
import { resolveStashDir, timestampForFilename } from "../../core/common";
import type { AkmConfig, LlmConnectionConfig } from "../../core/config/config";
import { getDefaultLlmConfig, loadConfig } from "../../core/config/config";
import { ConfigError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import {
  type ExtractedSessionRow,
  getExtractedSessionsMap,
  openStateDatabase,
  shouldSkipAlreadyExtractedSession,
  upsertExtractedSession,
} from "../../core/state-db";
import { repairTruncatedDescription } from "../../core/text-truncation";
import { warn } from "../../core/warn";
import { resolveImproveProcessRunnerFromProfile, runnerIsLlm } from "../../integrations/agent/runner";
import { normalizeHarnessId } from "../../integrations/harnesses";
import { getAvailableHarnesses } from "../../integrations/session-logs";
import { preFilterSession } from "../../integrations/session-logs/pre-filter";
import type { SessionData, SessionLogHarness, SessionRef, SessionSummary } from "../../integrations/session-logs/types";
import { type ChatMessage, chatCompletion } from "../../llm/client";
import { embed } from "../../llm/embedder";
import { isLlmFeatureEnabled, tryLlmFeature } from "../../llm/feature-gate";
import { sha256Hex } from "../../runtime";
import type { Database } from "../../storage/database";
import { createProposal, isProposalSkipped, type ProposalsContext } from "../proposal/validators/proposals";
import { buildExtractPrompt, EXTRACT_JSON_SCHEMA, type ExtractCandidate, parseExtractPayload } from "./extract-prompt";
import {
  applySchemaSimilarityPenalty,
  buildHotProbationFrontmatter,
  loadDerivedLayerEmbeddings,
  type SchemaSimilarityConfig,
} from "./homeostatic";
import { type ImproveProfileConfig, resolveProcessEnabled } from "./improve-profiles";
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
  /** Override the harness registry (test seam). */
  harnesses?: SessionLogHarness[];
  /**
   * Override the LLM chat function (test seam). Defaults to {@link chatCompletion}.
   */
  chat?: (
    config: LlmConnectionConfig & { supportsJsonSchema?: boolean },
    messages: ChatMessage[],
    options?: { timeoutMs?: number; responseSchema?: Record<string, unknown> },
  ) => Promise<string>;
  /** Override proposal clock/id (test seam). */
  ctx?: ProposalsContext;
  /** sourceRun for PROV-DM traceability. Generated when absent. */
  sourceRun?: string;
  /**
   * The resolved ACTIVE improve profile, threaded by `akmImprove` so the
   * feature gate and per-process extract config are read from the profile that
   * is actually running — not always `profiles.improve.default`. Without it a
   * non-default profile that enables extract was silently overridden by the
   * default profile's `extract.enabled: false` (and vice-versa). When absent
   * (e.g. an explicit `akm extract` invocation) the gate falls back to the
   * default-profile `session_extraction` feature flag, so explicit runs still
   * honour `profiles.improve.default.processes.extract.enabled`.
   */
  improveProfile?: ImproveProfileConfig;
  /** Hard timeout for each LLM call (ms). Default 60s per session. */
  timeoutMs?: number;
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
   * {@link tryLlmFeature} (fail-open). Tests inject a fake to avoid any real
   * LLM/network call. When session indexing is disabled this is never invoked.
   */
  generateSessionSummary?: SessionSummaryGenerator;
  /**
   * WS-3b Step-0b test seam: pre-loaded derived-layer embeddings to use in
   * place of opening index.db. When provided with `schemaSimilarity.enabled`,
   * the gate checks these vectors without any I/O. Tests inject synthetic
   * vectors here to exercise the penalty path without a real index.
   */
  schemaSimilarityEmbeddings?: Array<{ ref: string; embedding: number[] }>;
  /**
   * Test seam: inject the candidate-body embedding function used by the
   * schema-similarity gate, so the penalty branch is exercisable without a live
   * embedding model. Production leaves this undefined and uses the real `embed`.
   */
  schemaSimilarityEmbedFn?: (text: string) => Promise<number[]>;
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
  skipReason?: "read_failed" | "llm_unavailable" | "exception" | "already_extracted" | "too_short" | "triaged_out";
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
  sourceRef: SessionRef,
): { ref: string; content: string; description: string } {
  const ref = `${candidate.type}:${candidate.name}`;
  // Post-generation repair pass (#556): deterministically complete a
  // description the LLM sliced mid-sentence before it reaches the
  // auto-accept validators. No-op (byte-identical) for valid descriptions.
  const description = repairTruncatedDescription(candidate.description, candidate.body);
  const fm: Record<string, unknown> = {
    description,
    sources: [`session:${sourceRef.harness}:${sourceRef.sessionId}`],
  };
  if (candidate.type === "lesson" && candidate.when_to_use) {
    fm.when_to_use = candidate.when_to_use;
  }
  // #615 WS-0: preserve ordered-action + outcome data in frontmatter so the data
  // survives even if source transcripts are not re-extractable later. The
  // procedural-compilation feature (detection/compilation) is deferred to 0.10+.
  if (candidate.orderedActions && candidate.orderedActions.length > 0) {
    fm.orderedActions = candidate.orderedActions;
    if (candidate.outcomeData) {
      fm.outcomeData = candidate.outcomeData;
    }
  }
  const content = assembleAsset(fm, candidate.body);
  return { ref, content, description };
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
async function processSession(
  harness: SessionLogHarness,
  sessionRef: SessionRef,
  stashDir: string,
  config: AkmConfig,
  llmConfig: LlmConnectionConfig & { supportsJsonSchema?: boolean },
  chat: NonNullable<AkmExtractOptions["chat"]>,
  ctx: ProposalsContext | undefined,
  sourceRun: string,
  dryRun: boolean,
  timeoutMs: number,
  maxTotalChars: number | undefined,
  minContentChars: number,
  // #626 — pre-LLM heuristic triage gate. Default-off (enabled:false) takes the
  // exact pre-change path (no scorer call, no new skipReason).
  triage: { enabled: boolean; minScore: number },
  sessionIndexing: {
    enabled: boolean;
    minDurationMinutes: number;
    generate: SessionSummaryGenerator;
  },
  schemaSimilarityCtx: {
    config: SchemaSimilarityConfig;
    derivedEmbeddings: Array<{ ref: string; embedding: number[] }>;
    embeddingConfig: AkmConfig["embedding"];
    embedFn?: (text: string) => Promise<number[]>;
  } | null,
  // #602 — already-extracted skip moved INSIDE processSession: the content hash
  // can only be computed after readSession, so the skip decision lives here. The
  // prior row + bypass flags are threaded in from the caller. Skipping here still
  // costs ZERO LLM calls (the expensive resource #602 protects); only the cheap
  // file read is incurred.
  prior: ExtractedSessionRow | undefined,
  force: boolean,
  singleSession: boolean,
): Promise<ExtractedSessionResult> {
  const warnings: string[] = [];
  let data: ReturnType<SessionLogHarness["readSession"]>;
  try {
    data = harness.readSession(sessionRef);
  } catch (err) {
    return {
      sessionId: sessionRef.sessionId,
      harness: harness.name,
      candidateCount: 0,
      proposalIds: [],
      preFilter: { inputCount: 0, outputCount: 0, truncatedCount: 0 },
      warnings: [`readSession failed: ${err instanceof Error ? err.message : String(err)}`],
      skipped: true,
      skipReason: "read_failed",
    };
  }

  // #602 — content-hash skip. Computed on the RAW event stream immediately after
  // a successful read, BEFORE the pre-filter / minContentChars / triage gates, so
  // an unchanged session never reaches the LLM. Hash-based ⇒ clock-independent
  // (immune to the Jun 11-12 timestamp double-extract/over-throttle bug). --force
  // and single-session (explicit sessionId) modes bypass the skip entirely.
  const contentHash = hashSessionContent(data);
  if (!force && !singleSession && shouldSkipAlreadyExtractedSession(prior, contentHash)) {
    return {
      sessionId: sessionRef.sessionId,
      harness: harness.name,
      candidateCount: 0,
      proposalIds: [],
      preFilter: { inputCount: 0, outputCount: 0, truncatedCount: 0 },
      warnings: [`already extracted (content unchanged) at ${prior?.processed_at}; pass --force to re-process`],
      skipped: true,
      skipReason: "already_extracted",
      contentHash,
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
      };
    }
  }

  const prompt = buildExtractPrompt({ data, events: filtered.events, inlineRefs: data.inlineRefs });

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

  let llmRaw = "";
  const llmResult = await tryLlmFeature(
    "session_extraction",
    config,
    async () => {
      llmRaw = await chat(llmConfig, [{ role: "user", content: prompt }], {
        timeoutMs,
        responseSchema: EXTRACT_JSON_SCHEMA,
      });
      return llmRaw;
    },
    "",
    { timeoutMs },
  );

  if (llmResult === "" && !llmRaw) {
    // tryLlmFeature took the fallback path (disabled / timeout / error). Return skipped.
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

  if (payload.candidates.length === 0) {
    appendEvent(
      {
        eventType: "extract_invoked",
        ref: `session:${harness.name}:${sessionRef.sessionId}`,
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
      ctx,
    );
    const sessionAsset = await maybeWriteSessionAsset();
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

  // WS-3b step 0c: hot-probation intake buffer (#604).
  // When enabled, system-generated extractions enter captureMode: hot-probation
  // so they spend ONE consolidation cycle in probation before the deterministic
  // dedup+quality pass promotes them. Default OFF.
  const hotProbationEnabled =
    (config.profiles?.improve?.default?.processes?.extract?.hotProbation as { enabled?: boolean } | undefined)
      ?.enabled === true;

  for (const candidate of payload.candidates) {
    if (dryRun) {
      proposalIds.push(`dry-run:${candidate.type}:${candidate.name}`);
      continue;
    }
    try {
      // WS-3b Step-0b: schema-similarity intake gate. When enabled and the
      // candidate is a lesson/knowledge whose body embedding is within ε of an
      // existing derived-layer node, down-prioritize by multiplying confidence by
      // the penalty. PARITY: schemaSimilarityCtx is null when the flag is off →
      // applySchemaSimilarityPenalty returns the original confidence untouched and
      // never embeds. (Logic lives in homeostatic.ts so it is unit-testable.)
      const gateResult = await applySchemaSimilarityPenalty(candidate, schemaSimilarityCtx, (text) =>
        schemaSimilarityCtx?.embedFn
          ? schemaSimilarityCtx.embedFn(text)
          : embed(text, schemaSimilarityCtx?.embeddingConfig),
      );
      const effectiveConfidence = gateResult.effectiveConfidence;
      if (gateResult.warning) warn(gateResult.warning);
      const { ref, content, description } = buildCandidateProposal(candidate, sessionRef);
      const result = createProposal(
        stashDir,
        {
          ref,
          source: "extract",
          sourceRun,
          payload: {
            content,
            frontmatter: {
              description,
              ...(candidate.when_to_use ? { when_to_use: candidate.when_to_use } : {}),
              ...(effectiveConfidence !== undefined ? { confidence: effectiveConfidence } : {}),
              sources: [`session:${sessionRef.harness}:${sessionRef.sessionId}`],
              evidence: candidate.evidence,
              // #615 WS-0: mirror ordered-action + outcome data in the proposal
              // frontmatter record so downstream tooling can read it without
              // re-parsing the content body. Omitted when not present.
              ...(candidate.orderedActions && candidate.orderedActions.length > 0
                ? { orderedActions: candidate.orderedActions }
                : {}),
              ...(candidate.outcomeData ? { outcomeData: candidate.outcomeData } : {}),
              // WS-3b step 0c: tag system-generated extractions as hot-probation
              // when the feature is enabled. The consolidation pass will exclude
              // them from the LLM merge pool until the intake dedup+quality pass
              // runs against them. User-explicit `akm remember` (captureMode: hot)
              // is unaffected — this only applies to extract-generated proposals.
              ...(hotProbationEnabled ? buildHotProbationFrontmatter() : {}),
            },
          },
        },
        ctx,
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
      ref: `session:${harness.name}:${sessionRef.sessionId}`,
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
    ctx,
  );

  const sessionAsset = await maybeWriteSessionAsset();
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

  // Read the per-process extract config + enabled-state from the ACTIVE improve
  // profile when `akmImprove` threaded it; otherwise fall back to the `default`
  // profile (the explicit `akm extract` path, which has no active profile). This
  // is what stops a non-default profile's `extract.enabled` from being silently
  // overridden by the default profile and vice-versa.
  const activeProfile = options.improveProfile;
  const extractProcess = activeProfile
    ? activeProfile.processes?.extract
    : config.profiles?.improve?.default?.processes?.extract;
  const extractEnabled = activeProfile
    ? resolveProcessEnabled("extract", activeProfile)
    : isLlmFeatureEnabled(config, "session_extraction");

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
      warnings: [
        "session_extraction feature disabled — set profiles.improve.default.processes.extract.enabled: true to use",
      ],
      durationMs: Date.now() - startMs,
    };
  }

  // Resolve the LLM connection. Priority order:
  //   1. Options.config.profiles.improve.default.processes.extract.profile
  //      (per-process override, matches reflect/distill/consolidate)
  //   2. config.defaults.llm (the default LLM profile)
  //   3. throw — extract requires an LLM.
  let llmConfig: (LlmConnectionConfig & { supportsJsonSchema?: boolean }) | undefined;
  const runnerSpec = resolveImproveProcessRunnerFromProfile(extractProcess, config);
  if (runnerSpec) {
    if (!runnerIsLlm(runnerSpec)) {
      throw new ConfigError(
        `Extract only supports mode: "llm" (in-tree LLM call). Got mode: "${runnerSpec.kind}" from profiles.improve.default.processes.extract — change it to "llm" or remove the override.`,
        "INVALID_CONFIG_FILE",
      );
    }
    llmConfig = runnerSpec.connection;
  } else {
    llmConfig = getDefaultLlmConfig(config) ?? undefined;
  }
  if (!llmConfig) {
    throw new ConfigError(
      "No LLM connection configured for extract. Set profiles.llm + defaults.llm, or set profiles.improve.default.processes.extract.profile to a configured LLM profile.",
    );
  }

  // Honor per-process timeoutMs override; fall back to options.timeoutMs; then 60s.
  const timeoutMs =
    options.timeoutMs ??
    (typeof extractProcess?.timeoutMs === "number" ? extractProcess.timeoutMs : undefined) ??
    60_000;
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
  // Production summary generator: a bounded in-tree LLM call wrapped in the same
  // fail-open `tryLlmFeature` seam as the rest of extract. Returns `undefined`
  // on disablement / timeout / error so no asset is written. Tests inject a fake.
  const chatForSummary = options.chat ?? chatCompletion;
  const defaultSessionSummaryGenerator: SessionSummaryGenerator = async (data) => {
    let raw = "";
    await tryLlmFeature(
      "session_extraction",
      config,
      async () => {
        raw = await chatForSummary(llmConfig, [{ role: "user", content: buildSessionSummaryPrompt(data) }], {
          timeoutMs,
          responseSchema: SESSION_SUMMARY_JSON_SCHEMA,
        });
        return raw;
      },
      "",
      { timeoutMs },
    );
    return parseSessionSummary(raw);
  };
  const sessionIndexing = {
    enabled: sessionIndexingEnabled,
    minDurationMinutes: minSessionDuration,
    generate: options.generateSessionSummary ?? defaultSessionSummaryGenerator,
  };

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
  let candidates: SessionSummary[];
  if (options.sessionId) {
    const all = harness.listSessions({
      ...(options.location ? { location: options.location } : {}),
    });
    const target = all.find((s) => s.sessionId === options.sessionId);
    if (!target) {
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
        warnings: [`session ${options.sessionId} not found for harness ${options.type}`],
        durationMs: Date.now() - startMs,
      };
    }
    candidates = [target];
  } else {
    const sinceMs = parseSinceArg(effectiveSince);
    candidates = harness.listSessions({
      sinceMs,
      ...(options.location ? { location: options.location } : {}),
    });
  }

  const sessions: ExtractedSessionResult[] = [];
  let processedCount = 0;
  let skippedCount = 0;
  // #626 — per-run triage aggregation counters (counts-only telemetry, AC4).
  let triageEvaluated = 0;
  let triagePassed = 0;
  let triagedOut = 0;
  const allProposalIds: string[] = [];
  const topLevelWarnings: string[] = [];
  const chat = options.chat ?? chatCompletion;

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

  // WS-3b Step-0b: schema-similarity intake gate.
  // Load derived-layer (lesson/knowledge) embeddings once per run, but ONLY
  // when the gate is enabled in config. When disabled (the default) this block
  // is fully skipped and schemaSimilarityCtx stays null → byte-identical to
  // prior behaviour.
  const schemaSimilarityCfg = extractProcess?.schemaSimilarity as SchemaSimilarityConfig | undefined;
  let schemaSimilarityCtx: {
    config: SchemaSimilarityConfig;
    derivedEmbeddings: Array<{ ref: string; embedding: number[] }>;
    embeddingConfig: AkmConfig["embedding"];
    embedFn?: (text: string) => Promise<number[]>;
  } | null = null;
  if (schemaSimilarityCfg?.enabled === true) {
    const derivedEmbeddings = options.schemaSimilarityEmbeddings ?? loadDerivedLayerEmbeddings();
    schemaSimilarityCtx = {
      config: schemaSimilarityCfg,
      derivedEmbeddings,
      embeddingConfig: config.embedding,
      embedFn: options.schemaSimilarityEmbedFn,
    };
  }

  for (const summary of candidates) {
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

    try {
      const result = await processSession(
        harness,
        summary,
        stashDir,
        config,
        llmConfig,
        chat,
        options.ctx,
        sourceRun,
        dryRun,
        timeoutMs,
        maxTotalChars,
        minContentChars,
        triage,
        sessionIndexing,
        schemaSimilarityCtx,
        prior,
        options.force === true,
        typeof options.sessionId === "string" && options.sessionId.length > 0,
      );
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
            contentHash: result.contentHash ?? null,
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
    }
  }

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
      options.ctx,
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
  const extractProcess = config.profiles?.improve?.default?.processes?.extract;
  const effectiveSince = options.since ?? extractProcess?.defaultSince;
  const sinceMs = parseSinceArg(effectiveSince);

  const harnesses = (options.harnesses ?? getAvailableHarnesses()).filter((h) => h.isAvailable());

  let stateDb: Database | undefined = options.stateDb;
  let openedStateDb = false;
  let total = 0;
  try {
    for (const harness of harnesses) {
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
