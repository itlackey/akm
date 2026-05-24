// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure shaping functions that select and trim fields from command result
 * objects according to the active detail level / agent mode.
 *
 * Every function in this module is side-effect free and operates on plain
 * `Record<string, unknown>` shapes, which makes them trivial to unit test.
 */

import type { DetailLevel } from "./context";

const NORMAL_DESCRIPTION_LIMIT = 250;

const PASSTHROUGH_COMMANDS = new Set([
  "add",
  "agent-result",
  "clone",
  "config",
  "consolidate",
  "curate",
  "db-backups",
  "disable",
  "enable",
  "feedback",
  "graph-entities",
  "graph-entity",
  "graph-export",
  "graph-orphans",
  "graph-related",
  "graph-relations",
  "graph-summary",
  "health",
  "import",
  "improve",
  "index",
  "info",
  "init",
  "lessons-coverage",
  "lint",
  "list",
  "registry-add",
  "registry-build-index",
  "registry-list",
  "registry-remove",
  "remember",
  "remove",
  "save",
  "setup",
  "tasks-add",
  "tasks-disable",
  "tasks-doctor",
  "tasks-enable",
  "tasks-history",
  "tasks-list",
  "tasks-remove",
  "tasks-run",
  "tasks-show",
  "tasks-sync",
  "update",
  "upgrade",
  "vault-create",
  "vault-set",
  "vault-unset",
  "wiki-create",
  "wiki-ingest",
  "wiki-lint",
  "wiki-list",
  "wiki-pages",
  "wiki-register",
  "wiki-remove",
  "wiki-show",
  "wiki-stash",
  "workflow-complete",
  "workflow-create",
  "workflow-list",
  "workflow-next",
  "workflow-resume",
  "workflow-start",
  "workflow-status",
  "workflow-validate",
]);

export function shapeForCommand(command: string, result: unknown, detail: DetailLevel, forAgent = false): unknown {
  switch (command) {
    case "search":
      return shapeSearchOutput(result as Record<string, unknown>, detail, forAgent);
    case "registry-search":
      return shapeRegistrySearchOutput(result as Record<string, unknown>, detail);
    case "show":
      return shapeShowOutput(result as Record<string, unknown>, detail, forAgent);
    // Output shape registration for `akm history` — paired with the textRenderer in text.ts.
    case "history":
      return shapeHistoryOutput(result as Record<string, unknown>, detail);
    // Output shape registration for `akm events list` and `akm events tail`
    // (#204). Both share the same envelope; the renderer in text.ts uses
    // distinct command names so it can format streaming differently.
    case "events-list":
    case "events-tail":
      return shapeEventsOutput(result as Record<string, unknown>, detail);
    // Output shape registration for `akm proposal {list,show,accept,reject,diff}`
    // (#225). Each verb gets its own arm so the registry stays exhaustive (no
    // silent JSON.stringify fallback). The proposal payload is reshaped per
    // detail level — `brief` omits the full content body, while some proposal
    // shapers still retain normal-level metadata such as review details;
    // `full`/`agent` includes everything.
    case "proposal-list":
      return shapeProposalListOutput(result as Record<string, unknown>, detail);
    case "proposal-show":
      return shapeProposalShowOutput(result as Record<string, unknown>, detail);
    case "proposal-accept":
      return shapeProposalAcceptOutput(result as Record<string, unknown>, detail);
    case "proposal-reject":
      return shapeProposalRejectOutput(result as Record<string, unknown>, detail);
    case "proposal-diff":
      return shapeProposalDiffOutput(result as Record<string, unknown>, detail);
    // Phase 6C (Advantage D6c): revert envelope mirrors accept/reject.
    case "proposal-revert":
      return shapeProposalRevertOutput(result as Record<string, unknown>, detail);
    // Output shape registration for `akm reflect` and `akm propose` (#226).
    // Both share the proposal-producer envelope shape (success carries a
    // proposal entry; failure carries an AgentFailureReason discriminant).
    case "reflect":
    case "propose":
      return shapeProposalProducerOutput(result as Record<string, unknown>, detail);
    case "distill":
      return shapeDistillOutput(result as Record<string, unknown>, detail);
    case "vault-list": {
      const r = result as Record<string, unknown>;
      const vaults = Array.isArray(r.vaults) ? r.vaults : [];
      return {
        ...r,
        vaults: vaults.map((v) => {
          const { path: _path, ...rest } = v as Record<string, unknown>;
          return rest;
        }),
      };
    }
    default:
      // v1 spec §9 (output-shape registry exhaustive): identity-passthrough
      // commands are listed in PASSTHROUGH_COMMANDS; anything not in that set
      // is a registration bug — fail loudly.
      if (PASSTHROUGH_COMMANDS.has(command)) return result;
      throw new Error(`output shape not registered for command: ${command}`);
  }
}

function maybeAddSchema<T extends Record<string, unknown>>(
  base: T,
  detail: DetailLevel,
  version?: number,
): T | (T & { schemaVersion: number }) {
  return detail === "full" ? { schemaVersion: version ?? 1, ...base } : base;
}

/**
 * Shape the result of `akm reflect` / `akm propose`. On success we surface
 * the queued proposal entry (using the standard proposal-entry shaper so
 * detail levels behave uniformly with `akm proposal show`). On failure we
 * surface the structured failure-reason envelope as-is — the failure
 * surface is small and the reason / error text is always load-bearing.
 */
export function shapeProposalProducerOutput(
  result: Record<string, unknown>,
  detail: DetailLevel,
): Record<string, unknown> {
  if (result.ok === false) {
    const base: Record<string, unknown> = {
      ok: false,
      reason: result.reason,
      error: result.error,
      ...(result.ref !== undefined ? { ref: result.ref } : {}),
      ...(result.type !== undefined ? { type: result.type } : {}),
      ...(result.name !== undefined ? { name: result.name } : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    };
    if (detail === "full") {
      return {
        schemaVersion: result.schemaVersion ?? 1,
        ...base,
        ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
        ...(result.stderr !== undefined ? { stderr: result.stderr } : {}),
      };
    }
    return base;
  }
  const proposal = (result.proposal as Record<string, unknown>) ?? {};
  const base: Record<string, unknown> = {
    ok: true,
    ref: result.ref,
    ...(result.agentProfile !== undefined ? { agentProfile: result.agentProfile } : {}),
    ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
    proposal: shapeProposalEntry(proposal, detail === "brief" ? "normal" : detail),
  };
  return maybeAddSchema(base, detail, result.schemaVersion as number | undefined);
}

export function shapeProposalEntry(entry: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  if (detail === "brief") {
    // Phase 6A: confidence is small + load-bearing for auto-accept telemetry,
    // so include it even at brief detail.
    return pickFields(entry, ["id", "ref", "status", "source", "createdAt", "confidence"]);
  }
  if (detail === "normal" || detail === "summary") {
    return pickFields(entry, [
      "id",
      "ref",
      "status",
      "source",
      "sourceRun",
      "createdAt",
      "updatedAt",
      "review",
      "confidence",
      "backup",
    ]);
  }
  // full / agent: project everything including the payload.
  return pickFields(entry, [
    "id",
    "ref",
    "status",
    "source",
    "sourceRun",
    "createdAt",
    "updatedAt",
    "payload",
    "review",
    "confidence",
    "backup",
  ]);
}

export function shapeProposalListOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const proposals = Array.isArray(result.proposals) ? (result.proposals as Record<string, unknown>[]) : [];
  const shaped = proposals.map((p) => shapeProposalEntry(p, detail));
  const base: Record<string, unknown> = {
    totalCount: result.totalCount ?? shaped.length,
    proposals: shaped,
  };
  return maybeAddSchema(base, detail, result.schemaVersion as number | undefined);
}

export function shapeProposalShowOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const proposal = (result.proposal as Record<string, unknown>) ?? {};
  const validation = result.validation as Record<string, unknown> | undefined;
  const base: Record<string, unknown> = {
    proposal: shapeProposalEntry(proposal, detail === "brief" ? "normal" : detail),
    ...(validation ? { validation } : {}),
  };
  return maybeAddSchema(base, detail, result.schemaVersion as number | undefined);
}

export function shapeProposalAcceptOutput(
  result: Record<string, unknown>,
  detail: DetailLevel,
): Record<string, unknown> {
  const proposal = (result.proposal as Record<string, unknown>) ?? {};
  const base: Record<string, unknown> = {
    ok: result.ok ?? true,
    id: result.id,
    ref: result.ref,
    assetPath: result.assetPath,
    proposal: shapeProposalEntry(proposal, detail === "brief" ? "normal" : detail),
  };
  return maybeAddSchema(base, detail, result.schemaVersion as number | undefined);
}

export function shapeProposalRejectOutput(
  result: Record<string, unknown>,
  detail: DetailLevel,
): Record<string, unknown> {
  const proposal = (result.proposal as Record<string, unknown>) ?? {};
  const base: Record<string, unknown> = {
    ok: result.ok ?? true,
    id: result.id,
    ref: result.ref,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    proposal: shapeProposalEntry(proposal, detail === "brief" ? "normal" : detail),
  };
  return maybeAddSchema(base, detail, result.schemaVersion as number | undefined);
}

/**
 * Shape the result of `akm proposal revert <id>` (Phase 6C / Advantage D6c).
 *
 * Mirrors {@link shapeProposalAcceptOutput} — the surface is intentionally
 * symmetric with accept because the user-visible workflow is: accept restores
 * the new content; revert restores the prior content; both should look the
 * same in JSON output beyond the verb.
 */
export function shapeProposalRevertOutput(
  result: Record<string, unknown>,
  detail: DetailLevel,
): Record<string, unknown> {
  const proposal = (result.proposal as Record<string, unknown>) ?? {};
  const base: Record<string, unknown> = {
    ok: result.ok ?? true,
    id: result.id,
    ref: result.ref,
    assetPath: result.assetPath,
    proposal: shapeProposalEntry(proposal, detail === "brief" ? "normal" : detail),
  };
  return maybeAddSchema(base, detail, result.schemaVersion as number | undefined);
}

export function shapeDistillOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const proposal = result.proposal as Record<string, unknown> | undefined;
  if (detail === "brief") {
    return pickFields(result, ["ok", "outcome", "inputRef", "lessonRef", "proposalId", "message"]);
  }
  const base: Record<string, unknown> = {
    ok: result.ok ?? true,
    outcome: result.outcome,
    inputRef: result.inputRef,
    lessonRef: result.lessonRef,
    ...(result.proposalId !== undefined ? { proposalId: result.proposalId } : {}),
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(Array.isArray(result.findings) && result.findings.length > 0 ? { findings: result.findings } : {}),
    ...(proposal ? { proposal: shapeProposalEntry(proposal, detail === "summary" ? "normal" : detail) } : {}),
  };
  return maybeAddSchema(base, detail, result.schemaVersion as number | undefined);
}

export function shapeProposalDiffOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: result.id,
    ref: result.ref,
    isNew: result.isNew,
    unified: result.unified,
    ...(result.targetPath !== undefined ? { targetPath: result.targetPath } : {}),
  };
  return maybeAddSchema(base, detail, result.schemaVersion as number | undefined);
}

export function shapeEventsOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const events = Array.isArray(result.events) ? (result.events as Record<string, unknown>[]) : [];
  const shapedEvents = events.map((event) => shapeEventEntry(event, detail));
  const base: Record<string, unknown> = {
    ...(result.ref !== undefined ? { ref: result.ref } : {}),
    ...(result.type !== undefined ? { type: result.type } : {}),
    ...(result.since !== undefined ? { since: result.since } : {}),
    ...(typeof result.sinceOffset === "number" ? { sinceOffset: result.sinceOffset } : {}),
    totalCount: result.totalCount ?? shapedEvents.length,
    events: shapedEvents,
  };
  if (typeof result.nextOffset === "number") {
    base.nextOffset = result.nextOffset;
  }
  if (typeof result.reason === "string") {
    base.reason = result.reason;
  }
  return maybeAddSchema(base, detail, result.schemaVersion as number | undefined);
}

export function shapeEventEntry(entry: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  if (detail === "brief" || detail === "normal" || detail === "summary") {
    return pickFields(entry, ["eventType", "ref", "ts"]);
  }
  // full / agent: project everything the reader emits.
  return pickFields(entry, ["id", "schemaVersion", "eventType", "ref", "ts", "metadata"]);
}

export function shapeHistoryOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const entries = Array.isArray(result.entries) ? (result.entries as Record<string, unknown>[]) : [];
  const shapedEntries = entries.map((entry) => shapeHistoryEntry(entry, detail));
  if (detail === "full") {
    return {
      schemaVersion: result.schemaVersion ?? 1,
      ...(result.ref !== undefined ? { ref: result.ref } : {}),
      ...(result.since !== undefined ? { since: result.since } : {}),
      totalCount: result.totalCount ?? shapedEntries.length,
      entries: shapedEntries,
      // `sources` lists the event sources included in this response.
      // Always contains "usage_events"; also "events.jsonl" when
      // --include-proposals was specified.
      ...(Array.isArray(result.sources) ? { sources: result.sources } : {}),
      ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
  }
  return {
    ...(result.ref !== undefined ? { ref: result.ref } : {}),
    ...(result.since !== undefined ? { since: result.since } : {}),
    totalCount: result.totalCount ?? shapedEntries.length,
    entries: shapedEntries,
    ...(Array.isArray(result.sources) ? { sources: result.sources } : {}),
    ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };
}

export function shapeHistoryEntry(entry: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  if (detail === "brief") {
    // signal is load-bearing for feedback rows (positive/negative) so we
    // project it even at brief — without it the entry is ambiguous.
    return pickFields(entry, ["eventType", "ref", "signal", "source", "createdAt"]);
  }
  if (detail === "normal" || detail === "summary") {
    return pickFields(entry, ["eventType", "ref", "signal", "query", "source", "createdAt"]);
  }
  // full / agent: return everything the reader emits.
  return pickFields(entry, ["id", "eventType", "ref", "entryId", "query", "signal", "source", "metadata", "createdAt"]);
}

export function shapeSearchOutput(
  result: Record<string, unknown>,
  detail: DetailLevel,
  forAgent = false,
): Record<string, unknown> {
  const hits = Array.isArray(result.hits) ? (result.hits as Record<string, unknown>[]) : [];
  const registryHits = Array.isArray(result.registryHits) ? (result.registryHits as Record<string, unknown>[]) : [];
  const shapedHits = forAgent
    ? hits.map((hit) => shapeSearchHitForAgent(hit))
    : hits.map((hit) => shapeSearchHit(hit, detail));
  const shapedRegistryHits = forAgent
    ? registryHits.map((hit) => shapeSearchHitForAgent(hit))
    : registryHits.map((hit) => shapeSearchHit(hit, detail));

  if (forAgent) {
    return {
      hits: shapedHits,
      ...(shapedRegistryHits.length > 0 ? { registryHits: shapedRegistryHits } : {}),
      ...(result.tip ? { tip: result.tip } : {}),
    };
  }

  if (detail === "full") {
    return {
      schemaVersion: result.schemaVersion,
      stashDir: result.stashDir,
      source: result.source,
      hits: shapedHits,
      ...(shapedRegistryHits.length > 0 ? { registryHits: shapedRegistryHits } : {}),
      ...(result.semanticSearch ? { semanticSearch: result.semanticSearch } : {}),
      ...(result.tip ? { tip: result.tip } : {}),
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(result.timing ? { timing: result.timing } : {}),
    };
  }

  return {
    hits: shapedHits,
    ...(shapedRegistryHits.length > 0 ? { registryHits: shapedRegistryHits } : {}),
    ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    ...(result.tip ? { tip: result.tip } : {}),
  };
}

export function shapeRegistrySearchOutput(
  result: Record<string, unknown>,
  detail: DetailLevel,
): Record<string, unknown> {
  const hits = Array.isArray(result.hits) ? (result.hits as Record<string, unknown>[]) : [];
  const assetHits = Array.isArray(result.assetHits) ? (result.assetHits as Record<string, unknown>[]) : [];

  // Shape stash hits as registry type
  const shapedKitHits = hits.map((hit) => shapeSearchHit({ ...hit, type: "registry" }, detail));

  // Shape asset hits by detail level
  const shapedAssetHits = assetHits.map((hit) => shapeAssetHit(hit, detail));

  const shaped: Record<string, unknown> = {
    hits: shapedKitHits,
    ...(shapedAssetHits.length > 0 ? { assetHits: shapedAssetHits } : {}),
    ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };

  if (detail === "full") {
    shaped.query = result.query;
  }

  return shaped;
}

export function shapeAssetHit(hit: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  if (detail === "brief") return pickFields(hit, ["assetName", "assetType", "action", "estimatedTokens"]);
  if (detail === "normal") {
    return capDescription(
      pickFields(hit, ["assetName", "assetType", "description", "stash", "action", "estimatedTokens"]),
      NORMAL_DESCRIPTION_LIMIT,
    );
  }
  return hit;
}

export function shapeSearchHit(hit: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  if (hit.type === "registry") {
    if (detail === "brief") {
      // RegistrySearchHit uses `title` (not `name`); always project installRef
      // and score so callers can use the result without --detail full (QA #28).
      const out = pickFields(hit, ["title", "name", "installRef", "score"]);
      // Normalise: if only title exists, expose it as `name` for consistency
      if (out.title && !out.name) out.name = out.title;
      return out;
    }
    if (detail === "normal") {
      // `curated` was removed in v1 (spec §4.2). Renderers project optional
      // hit-level `warnings` instead so providers can surface non-fatal issues.
      const out = capDescription(
        pickFields(hit, ["title", "name", "description", "action", "installRef", "score", "warnings"]),
        NORMAL_DESCRIPTION_LIMIT,
      );
      if (out.title && !out.name) out.name = out.title;
      return out;
    }
    return hit;
  }

  // Stash hit (local or remote)
  // `ref` is included at `brief` so agents can run `akm show <ref>` without
  // needing --detail full or --for-agent (REC-03).
  if (detail === "brief") return pickFields(hit, ["type", "name", "ref", "action", "estimatedTokens", "keys"]);
  if (detail === "normal") {
    // `warnings` is projected at `normal` so non-fatal hit-level issues are
    // visible without forcing callers up to `--detail full`. Optional
    // `quality` (v1 spec §4.2) is also surfaced when present so callers
    // can see why a `proposed` entry showed up under `--include-proposed`.
    const shaped = capDescription(
      pickFields(hit, ["type", "name", "description", "action", "score", "estimatedTokens", "warnings", "quality"]),
      NORMAL_DESCRIPTION_LIMIT,
    );
    if (Array.isArray(hit.keys) && hit.keys.length > 0) shaped.keys = hit.keys;
    return shaped;
  }
  return hit;
}

/** Agent-optimized search hit: only fields an LLM agent needs to decide and act */
export function shapeSearchHitForAgent(hit: Record<string, unknown>): Record<string, unknown> {
  const picked = pickFields(hit, ["name", "ref", "type", "description", "action", "score", "estimatedTokens", "keys"]);
  return capDescription(picked, NORMAL_DESCRIPTION_LIMIT);
}

export function capDescription(hit: Record<string, unknown>, limit: number): Record<string, unknown> {
  if (typeof hit.description !== "string") return hit;
  return { ...hit, description: truncateDescription(hit.description, limit) };
}

export function truncateDescription(description: string, limit: number): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;

  const truncated = normalized.slice(0, limit - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  const safe = lastSpace >= Math.floor(limit * 0.6) ? truncated.slice(0, lastSpace) : truncated;
  return `${safe.trimEnd()}...`;
}

export function shapeShowOutput(
  result: Record<string, unknown>,
  detail: DetailLevel,
  forAgent = false,
): Record<string, unknown> {
  if (forAgent) {
    return pickFields(result, [
      "type",
      "name",
      "description",
      "action",
      "content",
      "template",
      "prompt",
      "run",
      "setup",
      "cwd",
      "activeRun",
      "toolPolicy",
      "modelHint",
      "agent",
      "parameters",
      "workflowTitle",
      "workflowParameters",
      "steps",
      "keys",
      "comments",
      "related",
    ]);
  }
  if (detail === "summary") {
    return pickFields(result, [
      "type",
      "name",
      "description",
      "tags",
      "parameters",
      "workflowTitle",
      "action",
      "run",
      "origin",
      "keys",
      "comments",
      "related",
    ]);
  }

  const baseFields = [
    "type",
    "name",
    "origin",
    "action",
    "description",
    "tags",
    "content",
    "template",
    "prompt",
    "toolPolicy",
    "modelHint",
    "agent",
    "parameters",
    "workflowTitle",
    "workflowParameters",
    "steps",
    "run",
    "setup",
    "cwd",
    "activeRun",
    "keys",
    "comments",
    "related",
    // path and editable are always projected so JSON consumers can locate and
    // edit the asset without needing --detail full (QA #7).
    // Exception: vault assets omit path to avoid leaking absolute disk paths
    // into structured JSON output (security fix M3).
    ...(result.type === "vault" ? [] : ["path"]),
    "editable",
  ];
  const base = pickFields(result, baseFields);

  if (detail !== "full") {
    return base;
  }

  return {
    schemaVersion: 1,
    ...base,
    ...pickFields(result, ["editHint"]),
  };
}

export function pickFields(source: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field] !== undefined) {
      result[field] = source[field];
    }
  }
  return result;
}

export { NORMAL_DESCRIPTION_LIMIT };
