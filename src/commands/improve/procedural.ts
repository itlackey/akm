// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #615 — procedural-compilation pass.
 *
 * An OPT-IN post-loop improve stage (default disabled via
 * `IMPROVE_PROCESS_DEFAULTS.procedural`). It reads assets that carry an
 * `orderedActions` frontmatter list (captured by #619), detects RECURRING
 * successful action sequences across sessions (the SAME normalized ordered step
 * list appearing >= `minRecurrence` times with a non-failure `outcomeData`), and
 * emits ONE normal `type: workflow` proposal per recurring sequence through the
 * existing proposal queue + quality gate.
 *
 * The ordered step list — NOT the LLM — is the source of truth. The bounded LLM
 * call only NAMES the workflow and per-step titles/instructions; the parser
 * rejects any output whose step count / order drifts from the deterministic
 * sequence, and the assembled workflow markdown is re-parsed locally before it
 * is ever queued. A justified null (the LLM determines the sequence is not a
 * coherent procedure) is an acceptable outcome and produces no proposal.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import proceduralSystemPrompt from "../../assets/prompts/procedural-system.md" with { type: "text" };
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { getDefaultLlmConfig, loadConfig } from "../../core/config/config";
import { appendEvent, type EventsContext } from "../../core/events";
import type { EligibilitySource, ProceduralCompilationResult } from "../../core/improve-types";
import { parseEmbeddedJsonResponse } from "../../core/parse";
import { warn } from "../../core/warn";
import { closeDatabase, type DbIndexedEntry, getAllEntries, openExistingDatabase } from "../../indexer/db/db";
import { resolveImproveProcessRunnerFromProfile, runnerIsLlm } from "../../integrations/agent/runner";
import { type ChatMessage, chatCompletion } from "../../llm/client";
import { parseWorkflow } from "../../workflows/parser";
import { validateProposalFrontmatter } from "../proposal/validators/proposal-quality-validators";
import { createProposal, isProposalSkipped } from "../proposal/validators/proposals";

export type { ProceduralCompilationResult } from "../../core/improve-types";

const PROCEDURAL_SYSTEM_PROMPT = proceduralSystemPrompt;

const DEFAULT_MIN_RECURRENCE = 3;
const DEFAULT_MAX_PROPOSALS_PER_RUN = 3;

/** Failure-signal heuristic: an outcome matching this is NOT counted as success. */
const FAILURE_SIGNAL = /\b(fail|failed|failure|error|errored|abort|aborted|rollback|reverted)\b/i;

/**
 * Single bounded LLM seam. Receives the assembled per-sequence prompt and
 * returns the raw model output (JSON object or explicit null), or `null` when no
 * call could be made. Injected by tests; production resolves the runner
 * internally.
 */
export type ProceduralLlmFn = (prompt: string) => Promise<string | null>;

export interface AkmProceduralOptions {
  stashDir?: string;
  config: AkmConfig;
  /** PROV-DM run token stamped on every emitted proposal. */
  sourceRun?: string;
  /** Caller budget signal; an aborted signal short-circuits before any LLM call. */
  signal?: AbortSignal;
  /** Auto-accept threshold forwarded to the proposal gate (reserved; v1 queues pending). */
  autoAccept?: number;
  /** Attribution tag persisted on emitted proposals. Defaults to `"procedural"`. */
  eligibilitySource?: EligibilitySource;
  /** Test seam — state.db path override for proposal/event writes. */
  ctx?: EventsContext;
  /** Injected LLM seam (no real network in tests). */
  proceduralLlmFn?: ProceduralLlmFn;
  minRecurrence?: number;
  maxProposalsPerRun?: number;
}

/** A recurring-sequence cluster: a normalized ordered step list + its successful members. */
export interface SequenceCluster {
  /** Deterministic order-sensitive group key (`JSON.stringify(normalized)`). */
  groupKey: string;
  /** The normalized ordered step list shared by all members. */
  normalized: string[];
  /** Successful member assets that performed this exact sequence. */
  members: Array<{ ref: string; entryKey: string; outcome: string }>;
}

/** The parsed workflow payload produced by the procedural LLM. */
interface ProceduralWorkflow {
  title: string;
  description: string;
  steps: Array<{ title: string; instructions: string; completionCriteria?: string[] }>;
}

// ── Normalization + recurrence model (deterministic, no LLM) ────────────────────

/** Normalize a single action string: trim, lowercase, collapse whitespace, strip trailing punctuation. */
function normalizeStep(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.;,:]+$/, "")
    .trim();
}

/**
 * Normalize an ordered action list: each step token-normalized (case /
 * whitespace / trailing-punctuation insensitive), with empties dropped. The
 * result is ORDER-SENSITIVE — reordered sequences normalize distinctly.
 */
export function normalizeSequence(actions: string[]): string[] {
  return actions.map(normalizeStep).filter((s) => s.length > 0);
}

/** A member counts toward recurrence only when its outcome is present, non-empty, and not a failure signal. */
function isSuccessfulOutcome(outcome?: string): boolean {
  if (!outcome) return false;
  const trimmed = outcome.trim();
  if (!trimmed) return false;
  return !FAILURE_SIGNAL.test(trimmed);
}

/** Recover the ordered-action sequence + outcome from an asset's frontmatter (NOT a DB column). */
function readOrderedSequence(
  entry: DbIndexedEntry,
): { actions: string[]; outcome?: string; ref: string; entryKey: string } | null {
  let data: Record<string, unknown>;
  try {
    const raw = fs.readFileSync(entry.filePath, "utf8");
    data = parseFrontmatter(raw).data;
  } catch {
    return null;
  }
  const rawActions = data.orderedActions;
  if (!Array.isArray(rawActions)) return null;
  const actions = rawActions.filter((a): a is string => typeof a === "string");
  if (actions.length === 0) return null;
  const outcome = typeof data.outcomeData === "string" ? data.outcomeData : undefined;
  const ref = `${entry.entry.type}:${entry.entry.name}`;
  return { actions, ...(outcome !== undefined ? { outcome } : {}), ref, entryKey: entry.entryKey };
}

/**
 * Group entries by their normalized ordered sequence. Only successful members
 * (non-failure outcome) count toward recurrence. Keep groups whose successful
 * member count >= `minRecurrence`, sort deterministically (member-count desc
 * then groupKey asc), and cap to `maxProposalsPerRun`. Exported for unit tests.
 */
export function buildSequenceClusters(
  entries: DbIndexedEntry[],
  opts: { minRecurrence: number; maxProposalsPerRun: number },
): SequenceCluster[] {
  const groups = new Map<string, SequenceCluster>();

  for (const entry of entries) {
    const seq = readOrderedSequence(entry);
    if (!seq) continue;
    const normalized = normalizeSequence(seq.actions);
    if (normalized.length === 0) continue;
    if (!isSuccessfulOutcome(seq.outcome)) continue;

    const groupKey = JSON.stringify(normalized);
    const existing = groups.get(groupKey);
    const member = { ref: seq.ref, entryKey: seq.entryKey, outcome: seq.outcome ?? "" };
    if (existing) {
      if (!existing.members.some((m) => m.entryKey === member.entryKey)) existing.members.push(member);
    } else {
      groups.set(groupKey, { groupKey, normalized, members: [member] });
    }
  }

  const clusters = [...groups.values()].filter((c) => c.members.length >= opts.minRecurrence);
  clusters.sort((a, b) => b.members.length - a.members.length || a.groupKey.localeCompare(b.groupKey));
  return clusters.slice(0, Math.max(0, opts.maxProposalsPerRun));
}

/**
 * Stable workflow ref for a sequence cluster. The hash of the sorted member keys
 * + the normalized sequence keeps the ref deterministic across runs, so
 * re-detection maps to the same ref and the content-hash dedup in createProposal
 * suppresses queue churn.
 */
export function deriveProceduralWorkflowRef(cluster: SequenceCluster): string {
  const slug = cluster.normalized
    .slice(0, 3)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const memberKey = cluster.members
    .map((m) => m.entryKey)
    .sort()
    .join("|");
  const hash = createHash("sha256")
    .update(`${memberKey} ${JSON.stringify(cluster.normalized)}`, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `workflow:compiled/${slug || "sequence"}-${hash}`;
}

// ── Prompt + parse ──────────────────────────────────────────────────────────────

/** Assemble the per-sequence user prompt fed to the procedural LLM. */
export function buildProceduralPrompt(cluster: SequenceCluster): string {
  const lines: string[] = [
    `A recurring successful action sequence observed across ${cluster.members.length} sessions.`,
    "",
    "Ordered actions (turn EACH into exactly one step, in this order):",
  ];
  cluster.normalized.forEach((step, i) => {
    lines.push(`${i + 1}. ${step}`);
  });
  lines.push("", "Sample successful outcomes:");
  for (const m of cluster.members.slice(0, 5)) {
    if (m.outcome) lines.push(`- ${m.outcome}`);
  }
  lines.push(
    "",
    `Return strict JSON with EXACTLY ${cluster.normalized.length} steps in the same order, or an explicit null.`,
  );
  return lines.join("\n");
}

/** Parse the raw LLM output into a workflow, or `null` for the justified-null path. */
function parseProceduralWorkflow(raw: string | null, expectedSteps: number): ProceduralWorkflow | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  const parsed = parseEmbeddedJsonResponse<unknown>(trimmed);
  if (parsed === undefined || parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const description = typeof obj.description === "string" ? obj.description : "";
  if (!title && !description) return null;
  if (!Array.isArray(obj.steps) || obj.steps.length !== expectedSteps) return null;
  const steps: ProceduralWorkflow["steps"] = [];
  for (const rawStep of obj.steps) {
    if (typeof rawStep !== "object" || rawStep === null) return null;
    const s = rawStep as Record<string, unknown>;
    const stepTitle = typeof s.title === "string" ? s.title.trim() : "";
    const instructions = typeof s.instructions === "string" ? s.instructions.trim() : "";
    if (!stepTitle || !instructions) return null;
    const completionCriteria = Array.isArray(s.completionCriteria)
      ? s.completionCriteria.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      : undefined;
    steps.push({
      title: stepTitle,
      instructions,
      ...(completionCriteria && completionCriteria.length > 0 ? { completionCriteria } : {}),
    });
  }
  return { title: title || "Compiled Workflow", description, steps };
}

// ── Workflow markdown assembly ────────────────────────────────────────────────

/** Convert a step title into a kebab-case step id. */
function kebab(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "step"
  );
}

/** Build the exact workflow markdown the parser accepts. */
export function assembleWorkflowMarkdown(doc: ProceduralWorkflow): string {
  const lines: string[] = [
    "---",
    `description: ${JSON.stringify(doc.description)}`,
    "---",
    "",
    `# Workflow: ${doc.title}`,
    "",
  ];
  const usedIds = new Set<string>();
  doc.steps.forEach((step, idx) => {
    let id = kebab(step.title);
    if (usedIds.has(id)) id = `${id}-${idx + 1}`;
    usedIds.add(id);
    lines.push(`## Step: ${step.title}`, `Step ID: ${id}`, "", "### Instructions", step.instructions, "");
    if (step.completionCriteria && step.completionCriteria.length > 0) {
      lines.push("### Completion Criteria");
      for (const c of step.completionCriteria) lines.push(`- ${c}`);
      lines.push("");
    }
  });
  return lines.join("\n");
}

// ── Production LLM seam ───────────────────────────────────────────────────────

/**
 * Resolve the production LLM seam from the active improve profile. Returns a
 * `ProceduralLlmFn` that issues one bounded chatCompletion per call, or
 * `undefined` when no LLM is configured (the pass then makes no calls).
 */
function resolveProductionLlmFn(config: AkmConfig, signal?: AbortSignal): ProceduralLlmFn | undefined {
  const proceduralProcess = config.profiles?.improve?.default?.processes?.procedural;
  const runnerSpec = resolveImproveProcessRunnerFromProfile(proceduralProcess, config);
  const llmConfig = runnerSpec && runnerIsLlm(runnerSpec) ? runnerSpec.connection : getDefaultLlmConfig(config);
  if (!llmConfig) return undefined;
  return async (prompt: string) => {
    const messages: ChatMessage[] = [
      { role: "system", content: PROCEDURAL_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ];
    try {
      return await chatCompletion(llmConfig, messages, { signal, enableThinking: false });
    } catch (e) {
      warn(`[procedural] LLM call failed: ${String(e)}`);
      return null;
    }
  };
}

// ── Main entry point ───────────────────────────────────────────────────────────

export async function akmProcedural(opts: AkmProceduralOptions): Promise<ProceduralCompilationResult> {
  const startMs = Date.now();
  const config = opts.config ?? loadConfig();
  const stashDir = opts.stashDir ?? resolveStashDir();
  const sourceRun = opts.sourceRun ?? `procedural-${startMs}`;
  const eligibilitySource: EligibilitySource = opts.eligibilitySource ?? "procedural";
  const minRecurrence = opts.minRecurrence ?? DEFAULT_MIN_RECURRENCE;
  const maxProposalsPerRun = opts.maxProposalsPerRun ?? DEFAULT_MAX_PROPOSALS_PER_RUN;
  const warnings: string[] = [];

  const finish = (over: Partial<ProceduralCompilationResult>): ProceduralCompilationResult => ({
    schemaVersion: 1,
    ok: true,
    sequencesScanned: 0,
    clustersFormed: 0,
    proposalsEmitted: 0,
    nullsReturned: 0,
    durationMs: Date.now() - startMs,
    warnings,
    ...over,
  });

  // Budget guard: an already-aborted signal short-circuits before any LLM call.
  if (opts.signal?.aborted) {
    return finish({ ok: false, warnings: [...warnings, "aborted-before-start"] });
  }

  // Load all entries from the index (orderedActions can ride any asset type).
  let entries: DbIndexedEntry[] = [];
  let db: ReturnType<typeof openExistingDatabase> | undefined;
  try {
    db = openExistingDatabase();
    entries = getAllEntries(db);
  } catch (e) {
    warnings.push(`procedural: failed to open index — ${String(e)}`);
    return finish({ ok: false });
  } finally {
    if (db) closeDatabase(db);
  }

  const clusters = buildSequenceClusters(entries, { minRecurrence, maxProposalsPerRun });
  const sequencesScanned = entries.length;

  let clustersFormed = 0;
  let proposalsEmitted = 0;
  let nullsReturned = 0;

  if (clusters.length === 0) {
    return finish({ sequencesScanned, clustersFormed: 0 });
  }

  const llmFn = opts.proceduralLlmFn ?? resolveProductionLlmFn(config, opts.signal);
  if (!llmFn) {
    warnings.push("procedural: no LLM configured — skipping");
    return finish({ sequencesScanned, clustersFormed: 0 });
  }

  for (const cluster of clusters) {
    if (opts.signal?.aborted) {
      warnings.push("aborted-mid-run");
      break;
    }
    clustersFormed += 1;
    const workflowRef = deriveProceduralWorkflowRef(cluster);

    const prompt = buildProceduralPrompt(cluster);
    const raw = await llmFn(prompt);
    const doc = parseProceduralWorkflow(raw, cluster.normalized.length);

    if (!doc) {
      nullsReturned += 1;
      appendEvent(
        {
          eventType: "procedural_compiled",
          ref: workflowRef,
          metadata: {
            groupKey: cluster.groupKey,
            memberCount: cluster.members.length,
            outcome: "null_returned",
            sourceRun,
          },
        },
        opts.ctx,
      );
      continue;
    }

    // Quality gate (always-run, never bypassed): the description must be present
    // and non-truncated. Runs BEFORE createProposal.
    const fmCheck = validateProposalFrontmatter({ description: doc.description });
    if (!fmCheck.ok) {
      appendEvent(
        {
          eventType: "procedural_compiled",
          ref: workflowRef,
          metadata: {
            groupKey: cluster.groupKey,
            memberCount: cluster.members.length,
            outcome: "quality_rejected",
            reason: fmCheck.reason,
            sourceRun,
          },
        },
        opts.ctx,
      );
      continue;
    }

    // Assemble + locally validate the workflow markdown. Never queue an
    // unparseable workflow.
    const content = assembleWorkflowMarkdown(doc);
    const parsed = parseWorkflow(content, { path: workflowRef });
    if (!parsed.ok) {
      appendEvent(
        {
          eventType: "procedural_compiled",
          ref: workflowRef,
          metadata: {
            groupKey: cluster.groupKey,
            memberCount: cluster.members.length,
            outcome: "invalid_workflow",
            reason: parsed.errors[0]?.message,
            sourceRun,
          },
        },
        opts.ctx,
      );
      continue;
    }

    const proposalResult = createProposal(
      stashDir,
      {
        ref: workflowRef,
        source: "procedural",
        sourceRun,
        payload: { content, frontmatter: { description: doc.description } },
        eligibilitySource,
      },
      opts.ctx,
    );

    if (isProposalSkipped(proposalResult)) {
      appendEvent(
        {
          eventType: "procedural_compiled",
          ref: workflowRef,
          metadata: {
            groupKey: cluster.groupKey,
            memberCount: cluster.members.length,
            outcome: "skipped",
            skipReason: proposalResult.reason,
            sourceRun,
          },
        },
        opts.ctx,
      );
      continue;
    }

    proposalsEmitted += 1;
    appendEvent(
      {
        eventType: "procedural_compiled",
        ref: workflowRef,
        metadata: {
          groupKey: cluster.groupKey,
          memberCount: cluster.members.length,
          outcome: "queued",
          proposalId: proposalResult.id,
          sourceRun,
        },
      },
      opts.ctx,
    );
  }

  return finish({ sequencesScanned, clustersFormed, proposalsEmitted, nullsReturned });
}
