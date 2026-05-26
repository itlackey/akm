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

import type { Database } from "bun:sqlite";
import { stringify as yamlStringify } from "yaml";
import { assembleAssetFromString } from "../core/asset-serialize";
import { resolveStashDir, timestampForFilename } from "../core/common";
import type { AkmConfig, LlmConnectionConfig } from "../core/config";
import { getDefaultLlmConfig, loadConfig } from "../core/config";
import { ConfigError, UsageError } from "../core/errors";
import { appendEvent } from "../core/events";
import { createProposal, isProposalSkipped, type ProposalsContext } from "../core/proposals";
import {
  type ExtractedSessionRow,
  getExtractedSessionsMap,
  openStateDatabase,
  shouldSkipAlreadyExtractedSession,
  upsertExtractedSession,
} from "../core/state-db";
import { warn } from "../core/warn";
import { resolveImproveProcessRunnerFromProfile } from "../integrations/agent/runner";
import { getAvailableHarnesses } from "../integrations/session-logs";
import { preFilterSession } from "../integrations/session-logs/pre-filter";
import type { SessionLogHarness, SessionRef, SessionSummary } from "../integrations/session-logs/types";
import { type ChatMessage, chatCompletion } from "../llm/client";
import { isLlmFeatureEnabled, tryLlmFeature } from "../llm/feature-gate";
import { buildExtractPrompt, EXTRACT_JSON_SCHEMA, type ExtractCandidate, parseExtractPayload } from "./extract-prompt";

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
  skipReason?: "read_failed" | "llm_unavailable" | "exception" | "already_extracted";
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
  return pool.find((h) => h.name === type);
}

/**
 * Build the ref + content for a candidate. The body must contain a
 * frontmatter block carrying `description` (and `when_to_use` for lessons)
 * so the accept-time descriptionQualityValidator passes — same pattern as
 * the consolidate-writer fix at consolidate.ts.
 */
function buildCandidateProposal(candidate: ExtractCandidate, sourceRef: SessionRef): { ref: string; content: string } {
  const ref = `${candidate.type}:${candidate.name}`;
  const fm: Record<string, unknown> = {
    description: candidate.description,
    sources: [`session:${sourceRef.harness}:${sourceRef.sessionId}`],
  };
  if (candidate.type === "lesson" && candidate.when_to_use) {
    fm.when_to_use = candidate.when_to_use;
  }
  const serialized = yamlStringify(fm).trimEnd();
  const content = assembleAssetFromString(serialized, candidate.body);
  return { ref, content };
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

  const filtered = preFilterSession(data, {
    ...(typeof maxTotalChars === "number" ? { maxTotalChars } : {}),
  });
  const prompt = buildExtractPrompt({ data, events: filtered.events, inlineRefs: data.inlineRefs });

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
    };
  }

  for (const candidate of payload.candidates) {
    if (dryRun) {
      proposalIds.push(`dry-run:${candidate.type}:${candidate.name}`);
      continue;
    }
    try {
      const { ref, content } = buildCandidateProposal(candidate, sessionRef);
      const result = createProposal(
        stashDir,
        {
          ref,
          source: "extract",
          sourceRun,
          payload: {
            content,
            frontmatter: {
              description: candidate.description,
              ...(candidate.when_to_use ? { when_to_use: candidate.when_to_use } : {}),
              ...(typeof candidate.confidence === "number" ? { confidence: candidate.confidence } : {}),
              sources: [`session:${sessionRef.harness}:${sessionRef.sessionId}`],
              evidence: candidate.evidence,
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

  // Read the per-process extract config from the active improve profile. Matches
  // the pattern reflect/distill/consolidate use: `profiles.improve.<active>.processes.extract`.
  // Only the `default` improve profile is consulted here — extract isn't invoked
  // with a profile flag yet (parity item for a future change).
  const extractProcess = config.profiles?.improve?.default?.processes?.extract;

  // Feature-gate early so we get a clean "skipped because disabled" envelope.
  if (!isLlmFeatureEnabled(config, "session_extraction")) {
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
    if (runnerSpec.kind !== "llm") {
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
  // Default discovery window — process config can override the built-in 24h.
  const effectiveSince = options.since ?? extractProcess?.defaultSince;

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
      stateDb = options.stateDb ?? openStateDatabase();
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

  for (const summary of candidates) {
    // Skip-tracking: if this session was already processed AND no new events
    // have arrived since (live endedAt <= recorded endedAt), don't burn an LLM
    // call. --force or single-session mode (explicit sessionId) bypasses.
    const prior = seenMap.get(summary.sessionId);
    if (!options.force && !options.sessionId && shouldSkipAlreadyExtractedSession(prior, summary.endedAt)) {
      sessions.push({
        sessionId: summary.sessionId,
        harness: harness.name,
        candidateCount: 0,
        proposalIds: [],
        preFilter: { inputCount: 0, outputCount: 0, truncatedCount: 0 },
        warnings: [
          `already extracted at ${prior?.processed_at}; pass --force to re-process or wait until the session has new content`,
        ],
        skipped: true,
        skipReason: "already_extracted",
      });
      skippedCount += 1;
      continue;
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
      );
      sessions.push(result);
      if (result.skipped) skippedCount += 1;
      else processedCount += 1;
      allProposalIds.push(...result.proposalIds);

      // Persist outcome so the next run skips this session unless new events
      // arrive. We only track non-dry-run paths — dry-run is for inspection
      // and should never poison the seen-table.
      if (trackingEnabled && stateDb && !dryRun) {
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
            metadata: {
              preFilterInputCount: result.preFilter.inputCount,
              preFilterOutputCount: result.preFilter.outputCount,
              preFilterTruncatedCount: result.preFilter.truncatedCount,
              ...(result.skipReason ? { skipReason: result.skipReason } : {}),
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
