/**
 * akm-bench workflow trace normalization (issue #254).
 *
 * Produces a single, normalized stream of `WorkflowTraceEvent`s from a finished
 * `RunResult` so downstream consumers (#256 evaluator, workflow-compliance
 * reports) have ONE place to ask "what did this agent actually do?" instead of
 * scraping `events.jsonl`, agent stdout, workspace diffs, and verifier output
 * independently.
 *
 * Inputs:
 *   • `RunResult.events` — structured AKM events (preferred when present).
 *   • Captured agent stdout / tool-call text (`agentStdout`).
 *   • Verifier output already lives on the run (`verifierStdout`).
 *   • Optional `workspaceWrites` — paths the harness observed touched. The
 *     normalizer will pick the first one as `first_workspace_write`.
 *   • Optional `harness` lifecycle markers (started/finished timestamps).
 *
 * Outputs a `WorkflowTraceResult` with a stable `schemaVersion: 1` field on the
 * envelope so #256 (workflow evaluator, Wave 3) can pin against this contract.
 *
 * Design rules:
 *   • Pure: never mutates the input `RunResult` and never touches disk.
 *   • Bounded: caps total event count and per-event byte size. A pathological
 *     1MiB stdout line CANNOT become a 1MiB event — see
 *     `MAX_EVENT_COUNT` / `MAX_EVENT_BYTES`.
 *   • Stable order: events sort by `(orderHint asc, sourceRank asc, originalIndex asc)`
 *     so the same RunResult always normalizes to the same trace.
 *   • Source attribution: every event carries a `source` so callers can tell
 *     where evidence came from when reconstructing the run.
 *
 * NOT in scope: live tailing, persistence, evaluation. Those belong to #256.
 */

import type { EventEnvelope } from "../../src/core/events";
import type { RunResult } from "./driver";

/* ─── Public API ──────────────────────────────────────────────────────────── */

/**
 * Stable event-type vocabulary. Adding new types is non-breaking; renaming or
 * removing requires a `schemaVersion` bump on `WorkflowTraceResult`.
 */
export type WorkflowTraceEventType =
  | "agent_started"
  | "akm_search"
  | "akm_show"
  | "akm_feedback"
  | "akm_reflect"
  | "akm_distill"
  | "akm_propose"
  | "akm_proposal_accept"
  | "akm_workflow_start"
  | "akm_workflow_next"
  | "akm_workflow_complete"
  | "akm_workflow_finish"
  | "workspace_read"
  | "workspace_write"
  | "first_workspace_write"
  | "test_run"
  | "verifier_run"
  | "agent_finished";

/** Runtime set of all valid workflow trace event names. Single source of truth. */
export const WORKFLOW_TRACE_EVENT_NAMES = new Set<WorkflowTraceEventType>([
  "agent_started",
  "akm_search",
  "akm_show",
  "akm_feedback",
  "akm_reflect",
  "akm_distill",
  "akm_propose",
  "akm_proposal_accept",
  "akm_workflow_start",
  "akm_workflow_next",
  "akm_workflow_complete",
  "akm_workflow_finish",
  "workspace_read",
  "workspace_write",
  "first_workspace_write",
  "test_run",
  "verifier_run",
  "agent_finished",
]);

/** Where the evidence for an event came from. */
export type WorkflowTraceSource = "akm_events" | "agent_stdout" | "filesystem_diff" | "harness" | "verifier";

/**
 * One normalized workflow event. Field set is intentionally narrow: only the
 * fields the issue body listed PLUS a `bytesTruncated` flag the normalizer
 * sets when a payload was clamped to fit within `MAX_EVENT_BYTES`.
 */
export interface WorkflowTraceEvent {
  /** Monotonic id within the result. Stable across identical inputs. */
  id: number;
  /** ISO timestamp when known (events.jsonl carries one; stdout-derived events do not). */
  ts?: string;
  /** Pass-through identifier from the run, when supplied. */
  runId?: string;
  taskId: string;
  arm: string;
  seed: number;
  type: WorkflowTraceEventType;
  /** AKM CLI verb (e.g. `search`, `show`, `feedback`) when source is a CLI invocation. */
  command?: string;
  args?: string[];
  /** Asset ref like `skill:deploy` or `team//skill:deploy`. */
  assetRef?: string;
  query?: string;
  resultRefs?: string[];
  filePath?: string;
  exitCode?: number;
  source: WorkflowTraceSource;
  /** True when at least one string field on this event was clamped to MAX_EVENT_BYTES. */
  bytesTruncated?: boolean;
}

/** Optional auxiliary inputs for `normalizeRunToTrace`. */
export interface NormalizeOptions {
  /**
   * Captured agent stdout. Scanned for `akm <verb> ...` invocations when the
   * structured `events.jsonl` did not record them. Bounded by `MAX_STDOUT_SCAN_BYTES`.
   */
  agentStdout?: string;
  /**
   * Workspace paths observed written during the run, in the order the harness
   * saw them. The first becomes `first_workspace_write`; the rest become
   * `workspace_write` entries.
   */
  workspaceWrites?: string[];
  /** Pass-through run identifier. */
  runId?: string;
  /** Harness lifecycle markers. When present they emit `agent_started`/`agent_finished`. */
  harness?: {
    agentStartedTs?: string;
    agentFinishedTs?: string;
  };
  /**
   * Collector for trace-scoped warnings (e.g. "trace truncated to N events").
   * Mirrors the `warnings` pattern used by `readRunEvents` and `computeTrajectory`.
   */
  warnings?: string[];
}

/** Top-level envelope. `schemaVersion` is on the envelope, NOT on each event. */
export interface WorkflowTraceResult {
  schemaVersion: 1;
  taskId: string;
  arm: string;
  seed: number;
  events: WorkflowTraceEvent[];
  /** True when the trace was clamped to `MAX_EVENT_COUNT`. */
  truncated: boolean;
}

/* ─── Caps (documented contract) ──────────────────────────────────────────── */

/** Hard cap on total events per trace. Prevents a noisy run from OOM-ing the harness. */
export const MAX_EVENT_COUNT = 4096;

/**
 * Per-string-field byte cap. Applied to `query`, `assetRef`, `filePath`,
 * `command`, and each `args[]` / `resultRefs[]` element. A pathological 1MiB
 * stdout line cannot become a 1MiB event because every string we copy off it
 * passes through `clamp(...)`.
 */
export const MAX_EVENT_BYTES = 4096;

/**
 * Cap on bytes scanned from `agentStdout`. A runaway agent could emit GBs.
 * 16 MiB matches `EVENTS_READ_CAP_BYTES` / `VERIFIER_STDOUT_SCAN_CAP` so the
 * harness has a single mental model of "how much output we look at".
 */
export const MAX_STDOUT_SCAN_BYTES = 16 * 1024 * 1024;

/* ─── Implementation ──────────────────────────────────────────────────────── */

interface SeedEvent {
  /** Time-ish ordering hint. ISO timestamp when known, else a synthetic monotonic value. */
  orderHint: string;
  /** Tiebreaker rank by source — events from `akm_events` win over stdout-scraped duplicates. */
  sourceRank: number;
  /** Original discovery index (input order) — final tiebreaker. */
  originalIndex: number;
  /** Partial event — `id` is assigned after sort. */
  partial: Omit<WorkflowTraceEvent, "id">;
}

const SOURCE_RANK: Record<WorkflowTraceSource, number> = {
  akm_events: 0,
  harness: 1,
  filesystem_diff: 2,
  verifier: 3,
  agent_stdout: 4,
};

/**
 * Normalize a `RunResult` (plus optional sidecar inputs) into a stable
 * workflow trace. Pure function; never throws on malformed input — bad lines
 * are skipped and a warning is appended to `options.warnings` if provided.
 */
export function normalizeRunToTrace(run: RunResult, options: NormalizeOptions = {}): WorkflowTraceResult {
  const seeds: SeedEvent[] = [];
  let originalIndex = 0;

  // 1) Harness lifecycle (if supplied).
  if (options.harness?.agentStartedTs) {
    seeds.push({
      orderHint: options.harness.agentStartedTs,
      sourceRank: SOURCE_RANK.harness,
      originalIndex: originalIndex++,
      partial: makePartial(run, options, {
        type: "agent_started",
        ts: options.harness.agentStartedTs,
        source: "harness",
      }),
    });
  }

  // 2) AKM events.jsonl — preferred evidence for akm_search/show/feedback/etc.
  for (const ev of run.events ?? []) {
    const seed = fromAkmEvent(ev, run, options, originalIndex);
    if (seed) {
      seeds.push(seed);
      originalIndex += 1;
    }
  }

  // 3) Agent stdout — scan for `akm <verb>` invocations not already covered.
  const stdoutSeeds = fromAgentStdout(options.agentStdout, run, options, originalIndex);
  for (const seed of stdoutSeeds) {
    seeds.push(seed);
    originalIndex += 1;
  }

  // 4) Workspace writes — first becomes `first_workspace_write`.
  if (options.workspaceWrites && options.workspaceWrites.length > 0) {
    let isFirst = true;
    for (const filePath of options.workspaceWrites) {
      if (typeof filePath !== "string" || filePath.length === 0) continue;
      seeds.push({
        // Workspace writes have no native timestamp; place them after akm_events
        // by giving them a high lexical hint anchored to the run finish marker
        // when present, else a sentinel that sorts after ISO timestamps.
        orderHint: options.harness?.agentFinishedTs ?? "~workspace",
        sourceRank: SOURCE_RANK.filesystem_diff,
        originalIndex: originalIndex++,
        partial: (() => {
          const clampedFilePath = clamp(filePath);
          const partial = makePartial(run, options, {
            type: isFirst ? "first_workspace_write" : "workspace_write",
            source: "filesystem_diff",
            filePath: clampedFilePath.value,
          });
          if (clampedFilePath.truncated) partial.bytesTruncated = true;
          return partial;
        })(),
      });
      isFirst = false;
    }
  }

  // 5) Verifier — derive a single `verifier_run` event from the run envelope.
  if (run.verifierExitCode !== undefined && run.verifierExitCode !== null) {
    seeds.push({
      orderHint: options.harness?.agentFinishedTs ?? "~verifier",
      sourceRank: SOURCE_RANK.verifier,
      originalIndex: originalIndex++,
      partial: makePartial(run, options, {
        type: "verifier_run",
        source: "verifier",
        exitCode: run.verifierExitCode,
      }),
    });
  }

  // 6) Harness finish (if supplied).
  if (options.harness?.agentFinishedTs) {
    seeds.push({
      orderHint: `${options.harness.agentFinishedTs}~`,
      sourceRank: SOURCE_RANK.harness,
      originalIndex: originalIndex++,
      partial: makePartial(run, options, {
        type: "agent_finished",
        ts: options.harness.agentFinishedTs,
        source: "harness",
        exitCode: run.verifierExitCode,
      }),
    });
  }

  // Stable sort: orderHint, then sourceRank, then originalIndex.
  seeds.sort((a, b) => {
    if (a.orderHint < b.orderHint) return -1;
    if (a.orderHint > b.orderHint) return 1;
    if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
    return a.originalIndex - b.originalIndex;
  });

  // Cap event count.
  let truncated = false;
  let kept = seeds;
  if (seeds.length > MAX_EVENT_COUNT) {
    kept = seeds.slice(0, MAX_EVENT_COUNT);
    truncated = true;
    if (options.warnings) {
      options.warnings.push(
        `workflow trace truncated: ${seeds.length} events exceed ${MAX_EVENT_COUNT}-event cap; remainder dropped.`,
      );
    }
  }

  const events: WorkflowTraceEvent[] = kept.map((seed, idx) => ({ id: idx, ...seed.partial }));

  return {
    schemaVersion: 1,
    taskId: run.taskId,
    arm: run.arm,
    seed: run.seed,
    events,
    truncated,
  };
}

/* ─── Source: AKM events.jsonl envelopes ──────────────────────────────────── */

const AKM_EVENT_TYPE_MAP: Record<string, WorkflowTraceEventType> = {
  search: "akm_search",
  show: "akm_show",
  feedback: "akm_feedback",
  reflect_invoked: "akm_reflect",
  distill_invoked: "akm_distill",
  propose_invoked: "akm_propose",
  promoted: "akm_proposal_accept",
  workflow_started: "akm_workflow_start",
  workflow_step_completed: "akm_workflow_complete",
  workflow_finished: "akm_workflow_finish",
};

function fromAkmEvent(
  ev: EventEnvelope | unknown,
  run: RunResult,
  options: NormalizeOptions,
  originalIndex: number,
): SeedEvent | null {
  if (!ev || typeof ev !== "object") return null;
  const envelope = ev as Partial<EventEnvelope>;
  const eventType = typeof envelope.eventType === "string" ? envelope.eventType : undefined;
  if (!eventType) return null;
  const traceType = AKM_EVENT_TYPE_MAP[eventType];
  if (!traceType) return null; // ignore non-workflow events (add/remove/update/etc.)

  const ts = typeof envelope.ts === "string" && envelope.ts.length > 0 ? envelope.ts : undefined;
  const ref = typeof envelope.ref === "string" ? envelope.ref : undefined;
  const meta = (envelope.metadata ?? undefined) as Record<string, unknown> | undefined;

  const partial: Omit<WorkflowTraceEvent, "id"> = makePartial(run, options, {
    type: traceType,
    source: "akm_events",
    ts,
  });
  let bytesTruncated = false;
  if (ref) {
    const clampedRef = clamp(ref);
    partial.assetRef = clampedRef.value;
    bytesTruncated ||= clampedRef.truncated;
  }

  // Pull useful structured fields off metadata when present. We deliberately
  // probe a small whitelist so a malicious agent can't smuggle arbitrary
  // payloads into the trace.
  if (meta && typeof meta === "object") {
    const q = (meta as Record<string, unknown>).query;
    if (typeof q === "string") {
      const clampedQuery = clamp(q);
      partial.query = clampedQuery.value;
      bytesTruncated ||= clampedQuery.truncated;
    }
    const fp = (meta as Record<string, unknown>).path ?? (meta as Record<string, unknown>).filePath;
    if (typeof fp === "string") {
      const clampedFilePath = clamp(fp);
      partial.filePath = clampedFilePath.value;
      bytesTruncated ||= clampedFilePath.truncated;
    }
    const ec = (meta as Record<string, unknown>).exitCode;
    if (typeof ec === "number" && Number.isFinite(ec)) partial.exitCode = ec;
    const refs = (meta as Record<string, unknown>).resultRefs;
    if (Array.isArray(refs)) {
      partial.resultRefs = refs
        .filter((r): r is string => typeof r === "string")
        .map((r) => {
          const clampedRef = clamp(r);
          bytesTruncated ||= clampedRef.truncated;
          return clampedRef.value;
        });
    }
  }

  if (bytesTruncated) partial.bytesTruncated = true;

  return {
    orderHint: ts ?? "￿akm-events", // events without ts sort after timestamped ones
    sourceRank: SOURCE_RANK.akm_events,
    originalIndex,
    partial,
  };
}

/* ─── Source: agent stdout ────────────────────────────────────────────────── */

interface StdoutMatch {
  type: WorkflowTraceEventType;
  command: string;
  args?: string[];
  assetRef?: string;
  query?: string;
}

function fromAgentStdout(
  stdoutRaw: string | undefined,
  run: RunResult,
  options: NormalizeOptions,
  startIndex: number,
): SeedEvent[] {
  if (!stdoutRaw) return [];
  const stdout = stdoutRaw.length > MAX_STDOUT_SCAN_BYTES ? stdoutRaw.slice(0, MAX_STDOUT_SCAN_BYTES) : stdoutRaw;
  if (stdout.length < stdoutRaw.length && options.warnings) {
    options.warnings.push(
      `workflow trace stdout truncated: ${stdoutRaw.length} chars exceeds ${MAX_STDOUT_SCAN_BYTES}-char cap; trace computed from the prefix.`,
    );
  }

  const out: SeedEvent[] = [];
  let idx = startIndex;
  // Match invocations like `akm search "query"`, `akm show skill:foo`, `akm feedback +1 skill:foo`.
  // We scan line-by-line so position in the stdout becomes a stable order hint.
  const lines = stdout.split("\n");
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo];
    const match = parseAkmCli(line);
    if (!match) continue;
    const clampedCommand = clamp(match.command);
    let bytesTruncated = clampedCommand.truncated;
    const partial: Omit<WorkflowTraceEvent, "id"> = makePartial(run, options, {
      type: match.type,
      source: "agent_stdout",
      command: clampedCommand.value,
    });
    if (match.assetRef) {
      const clampedRef = clamp(match.assetRef);
      partial.assetRef = clampedRef.value;
      bytesTruncated ||= clampedRef.truncated;
    }
    if (match.query) {
      const clampedQuery = clamp(match.query);
      partial.query = clampedQuery.value;
      bytesTruncated ||= clampedQuery.truncated;
    }
    if (match.args) {
      partial.args = match.args.map((arg) => {
        const clampedArg = clamp(arg);
        bytesTruncated ||= clampedArg.truncated;
        return clampedArg.value;
      });
    }
    if (bytesTruncated) partial.bytesTruncated = true;
    out.push({
      // Stdout has no native timestamp; lexically place after timestamped events
      // by using a leading `~` sentinel (sorts after all printable ASCII timestamps),
      // then stable-order by line number padded to 8 digits.
      orderHint: `~stdout-${String(lineNo).padStart(8, "0")}`,
      sourceRank: SOURCE_RANK.agent_stdout,
      originalIndex: idx,
      partial,
    });
    idx += 1;
  }
  return out;
}

/**
 * Recognise an `akm <verb> ...` invocation in a single line of agent output.
 * Returns null when the line does not look like an akm CLI call.
 *
 * Supported shapes:
 *   • Bare CLI:   `akm search "deploy docker"`
 *   • Tool-call:  `tool: akm show skill:foo`
 *   • JSON-ish:   `{"command":"akm","args":["search","deploy"]}`
 */
function parseAkmCli(line: string): StdoutMatch | null {
  if (!line || line.length === 0) return null;
  // Quick reject — every form contains the literal `akm` token.
  if (line.indexOf("akm") === -1) return null;

  // JSON tool-call form first (most specific).
  const jsonMatch = line.match(/"command"\s*:\s*"akm"\s*,\s*"args"\s*:\s*\[([^\]]*)\]/);
  if (jsonMatch) {
    const argList = jsonMatch[1]
      .split(",")
      .map((a) => a.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    return classifyArgs("akm", argList);
  }

  // Bare CLI form: capture everything after `akm `.
  const bareMatch = line.match(/(?:^|[\s>`'"])akm\s+(\w[\w-]*)(?:\s+([^\n]*))?/);
  if (bareMatch) {
    const verb = bareMatch[1];
    const rest = (bareMatch[2] ?? "").trim();
    const args = tokenizeArgs(rest);
    return classifyArgs("akm", [verb, ...args]);
  }
  return null;
}

function classifyArgs(command: string, argv: string[]): StdoutMatch | null {
  if (argv.length === 0) return null;
  const verb = argv[0];
  const rest = argv.slice(1);
  switch (verb) {
    case "search":
      return { type: "akm_search", command, args: argv, query: rest.join(" ") || undefined };
    case "show":
      return { type: "akm_show", command, args: argv, assetRef: rest[0] };
    case "feedback":
      return { type: "akm_feedback", command, args: argv, assetRef: rest.find((a) => a.includes(":")) };
    case "reflect":
      return { type: "akm_reflect", command, args: argv };
    case "distill":
      return { type: "akm_distill", command, args: argv };
    case "propose":
      return { type: "akm_propose", command, args: argv };
    case "workflow": {
      const sub = rest[0];
      if (sub === "start") return { type: "akm_workflow_start", command, args: argv, assetRef: rest[1] };
      if (sub === "next") return { type: "akm_workflow_next", command, args: argv, assetRef: rest[1] };
      if (sub === "complete") return { type: "akm_workflow_complete", command, args: argv };
      return null;
    }
    default:
      return null;
  }
}

/**
 * Cheap shell-like tokenizer. Handles double-quoted and single-quoted strings;
 * everything else splits on whitespace. Not a full POSIX parser — we only need
 * "good enough" for opencode's tool-call logging.
 */
function tokenizeArgs(rest: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && rest[i] === " ") i += 1;
    if (i >= rest.length) break;
    const ch = rest[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      const start = i;
      while (i < rest.length && rest[i] !== quote) i += 1;
      out.push(rest.slice(start, i));
      if (i < rest.length) i += 1;
    } else {
      const start = i;
      while (i < rest.length && rest[i] !== " ") i += 1;
      out.push(rest.slice(start, i));
    }
  }
  return out;
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function makePartial(
  run: RunResult,
  options: NormalizeOptions,
  fields: Pick<WorkflowTraceEvent, "type" | "source"> & Partial<WorkflowTraceEvent>,
): Omit<WorkflowTraceEvent, "id"> {
  const base: Omit<WorkflowTraceEvent, "id"> = {
    taskId: run.taskId,
    arm: run.arm,
    seed: run.seed,
    type: fields.type,
    source: fields.source,
  };
  if (options.runId) base.runId = options.runId;
  if (fields.ts !== undefined) base.ts = fields.ts;
  if (fields.command !== undefined) base.command = fields.command;
  if (fields.args !== undefined) base.args = fields.args;
  if (fields.assetRef !== undefined) base.assetRef = fields.assetRef;
  if (fields.query !== undefined) base.query = fields.query;
  if (fields.resultRefs !== undefined) base.resultRefs = fields.resultRefs;
  if (fields.filePath !== undefined) base.filePath = fields.filePath;
  if (fields.exitCode !== undefined) base.exitCode = fields.exitCode;
  return base;
}

/** Clamp a single string to MAX_EVENT_BYTES UTF-8 bytes without splitting code points. */
function clamp(value: string): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= MAX_EVENT_BYTES) {
    return { value, truncated: false };
  }
  let out = "";
  let bytes = 0;
  for (const ch of value) {
    const nextBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + nextBytes > MAX_EVENT_BYTES) break;
    out += ch;
    bytes += nextBytes;
  }
  return { value: out, truncated: true };
}
