/**
 * Pure shaping functions that select and trim fields from command result
 * objects according to the active detail level / agent mode.
 *
 * Every function in this module is side-effect free and operates on plain
 * `Record<string, unknown>` shapes, which makes them trivial to unit test.
 */

import type { DetailLevel } from "./context";

const NORMAL_DESCRIPTION_LIMIT = 250;

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
    default:
      return result;
  }
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
  if (detail === "full") {
    return { schemaVersion: result.schemaVersion ?? 1, ...base };
  }
  return base;
}

export function shapeEventEntry(entry: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  if (detail === "brief") {
    return pickFields(entry, ["eventType", "ref", "ts"]);
  }
  if (detail === "normal" || detail === "summary") {
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
      ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
  }
  return {
    ...(result.ref !== undefined ? { ref: result.ref } : {}),
    ...(result.since !== undefined ? { since: result.since } : {}),
    totalCount: result.totalCount ?? shapedEntries.length,
    entries: shapedEntries,
    ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };
}

export function shapeHistoryEntry(entry: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  if (detail === "brief") {
    // signal is load-bearing for feedback rows (positive/negative) so we
    // project it even at brief — without it the entry is ambiguous.
    return pickFields(entry, ["eventType", "ref", "signal", "createdAt"]);
  }
  if (detail === "normal" || detail === "summary") {
    return pickFields(entry, ["eventType", "ref", "signal", "query", "createdAt"]);
  }
  // full / agent: return everything the reader emits.
  return pickFields(entry, ["id", "eventType", "ref", "entryId", "query", "signal", "metadata", "createdAt"]);
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
  if (detail === "brief") return pickFields(hit, ["type", "name", "action", "estimatedTokens"]);
  if (detail === "normal") {
    // `warnings` is projected at `normal` so non-fatal hit-level issues are
    // visible without forcing callers up to `--detail full`.
    return capDescription(
      pickFields(hit, ["type", "name", "description", "action", "score", "estimatedTokens", "warnings"]),
      NORMAL_DESCRIPTION_LIMIT,
    );
  }
  return hit;
}

/** Agent-optimized search hit: only fields an LLM agent needs to decide and act */
export function shapeSearchHitForAgent(hit: Record<string, unknown>): Record<string, unknown> {
  const picked = pickFields(hit, ["name", "ref", "type", "description", "action", "score", "estimatedTokens"]);
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
      "toolPolicy",
      "modelHint",
      "agent",
      "parameters",
      "workflowTitle",
      "workflowParameters",
      "steps",
      "keys",
      "comments",
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
    ]);
  }

  const base = pickFields(result, [
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
    "keys",
    "comments",
    // path and editable are always projected so JSON consumers can locate and
    // edit the asset without needing --detail full (QA #7).
    "path",
    "editable",
  ]);

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
