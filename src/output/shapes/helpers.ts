// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure shaping helper functions shared across per-command shape modules.
 *
 * No registry imports — no circular dependencies.
 */

import type { DetailLevel, ShapeMode } from "../context";

export const NORMAL_DESCRIPTION_LIMIT = 250;

const FRAGMENT_PROVENANCE_FIELDS = [
  "selectedRef",
  "parentRef",
  "fragmentOrdinal",
  "fragmentCount",
  "startLine",
  "endLine",
  "previousRef",
  "nextRef",
  "fragmentChars",
  "fragmentEstimatedTokens",
  "parentChars",
  "parentEstimatedTokens",
];

const FRAGMENT_CONTEXT_FIELDS = ["contextMode", "contextMaxChars", "contextTruncated"];

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
      ...(result.engine !== undefined ? { engine: result.engine } : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(Array.isArray(result.notices) ? { notices: result.notices } : {}),
    };
    if (detail === "full") {
      return {
        schemaVersion: result.schemaVersion,
        ...base,
        ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
        ...(result.stderr !== undefined ? { stderr: result.stderr } : {}),
      };
    }
    return base;
  }
  const proposal = result.proposal as Record<string, unknown>;
  const base: Record<string, unknown> = {
    ok: result.ok,
    ref: result.ref,
    ...(result.engine !== undefined ? { engine: result.engine } : {}),
    ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
    ...(Array.isArray(result.notices) ? { notices: result.notices } : {}),
    proposal: shapeProposalEntry(proposal, detail === "brief" ? "normal" : detail),
  };
  if (detail === "full") {
    return { schemaVersion: result.schemaVersion, ...base };
  }
  return base;
}

export function shapeProposalEntry(entry: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  if (detail === "brief") {
    return pickFields(entry, ["id", "ref", "status", "source", "createdAt"]);
  }
  if (detail === "normal") {
    // `confidence` and `gateDecision` (#577) explain why a proposal is pending,
    // so they are projected at `normal` for `akm proposal list/show` when present.
    return pickFields(entry, [
      "id",
      "ref",
      "status",
      "source",
      "sourceRun",
      "createdAt",
      "updatedAt",
      "confidence",
      "gateDecision",
      "review",
    ]);
  }
  // full: project everything including the payload.
  return pickFields(entry, [
    "id",
    "ref",
    "status",
    "source",
    "sourceRun",
    "createdAt",
    "updatedAt",
    "confidence",
    "gateDecision",
    "payload",
    "review",
  ]);
}

export function shapeProposalListOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const proposals = result.proposals as Record<string, unknown>[];
  const shaped = proposals.map((p) => shapeProposalEntry(p, detail));
  const base: Record<string, unknown> = {
    totalCount: result.totalCount,
    proposals: shaped,
  };
  if (detail === "full") {
    return { schemaVersion: result.schemaVersion, ...base };
  }
  return base;
}

export function shapeProposalShowOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const proposal = result.proposal as Record<string, unknown>;
  const validation = result.validation as Record<string, unknown> | undefined;
  const base: Record<string, unknown> = {
    proposal: shapeProposalEntry(proposal, detail === "brief" ? "normal" : detail),
    ...(validation ? { validation } : {}),
  };
  if (detail === "full") {
    return { schemaVersion: result.schemaVersion, ...base };
  }
  return base;
}

export function shapeProposalAcceptOutput(
  result: Record<string, unknown>,
  detail: DetailLevel,
): Record<string, unknown> {
  const proposal = result.proposal as Record<string, unknown>;
  const base: Record<string, unknown> = {
    ok: result.ok,
    id: result.id,
    ref: result.ref,
    assetPath: result.assetPath,
    proposal: shapeProposalEntry(proposal, detail === "brief" ? "normal" : detail),
  };
  if (detail === "full") {
    return { schemaVersion: result.schemaVersion, ...base };
  }
  return base;
}

export function shapeProposalRejectOutput(
  result: Record<string, unknown>,
  detail: DetailLevel,
): Record<string, unknown> {
  const proposal = result.proposal as Record<string, unknown>;
  const base: Record<string, unknown> = {
    ok: result.ok,
    id: result.id,
    ref: result.ref,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    proposal: shapeProposalEntry(proposal, detail === "brief" ? "normal" : detail),
  };
  if (detail === "full") {
    return { schemaVersion: result.schemaVersion, ...base };
  }
  return base;
}

export function shapeProposalDiffOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: result.id,
    ref: result.ref,
    isNew: result.isNew,
    unified: result.unified,
    ...(result.targetPath !== undefined ? { targetPath: result.targetPath } : {}),
  };
  if (detail === "full") {
    return { schemaVersion: result.schemaVersion, ...base };
  }
  return base;
}

export function shapeEventsOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const events = Array.isArray(result.events) ? (result.events as Record<string, unknown>[]) : [];
  const shapedEvents = events.map((event) => shapeEventEntry(event, detail));
  const base: Record<string, unknown> = {
    ...(result.ref !== undefined ? { ref: result.ref } : {}),
    ...(result.type !== undefined ? { type: result.type } : {}),
    ...(result.run !== undefined ? { run: result.run } : {}),
    ...(result.since !== undefined ? { since: result.since } : {}),
    ...(typeof result.sinceOffset === "number" ? { sinceOffset: result.sinceOffset } : {}),
    // D-38: echo `--limit` through the shaped envelope too — `akmEventsList`
    // already conditionally includes it in its raw result (see
    // src/commands/events.ts) only when the caller passed it, so this mirrors
    // that same "present only if requested" convention.
    ...(typeof result.limit === "number" ? { limit: result.limit } : {}),
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
  if (detail === "normal") {
    return pickFields(entry, ["eventType", "ref", "ts"]);
  }
  // full: project everything the reader emits.
  return pickFields(entry, ["id", "schemaVersion", "eventType", "ref", "ts", "metadata"]);
}

export function shapeSearchOutput(
  result: Record<string, unknown>,
  detail: DetailLevel,
  shape: ShapeMode = "human",
): Record<string, unknown> {
  const forAgent = shape === "agent";
  const hits = Array.isArray(result.hits) ? (result.hits as Record<string, unknown>[]) : [];
  const registryHits = Array.isArray(result.registryHits) ? (result.registryHits as Record<string, unknown>[]) : [];
  const shapedHits = forAgent
    ? hits.map((hit) => shapeSearchHitForAgent(hit))
    : hits.map((hit) => shapeSearchHit(hit, detail));
  const shapedRegistryHits = forAgent
    ? registryHits.map((hit) => shapeSearchHitForAgent(hit))
    : registryHits.map((hit) => shapeSearchHit(hit, detail));
  const searchMode = typeof result.searchMode === "string" ? result.searchMode : undefined;
  const warnings = Array.isArray(result.warnings) && result.warnings.length > 0 ? result.warnings : undefined;

  if (forAgent) {
    return {
      hits: shapedHits,
      ...(shapedRegistryHits.length > 0 ? { registryHits: shapedRegistryHits } : {}),
      ...(searchMode ? { searchMode } : {}),
      ...(warnings ? { warnings } : {}),
      ...(result.tip ? { tip: result.tip } : {}),
    };
  }

  if (detail === "full") {
    return {
      schemaVersion: result.schemaVersion,
      bundleDir: result.bundleDir,
      source: result.source,
      hits: shapedHits,
      ...(shapedRegistryHits.length > 0 ? { registryHits: shapedRegistryHits } : {}),
      ...(result.tip ? { tip: result.tip } : {}),
      ...(searchMode ? { searchMode } : {}),
      ...(warnings ? { warnings } : {}),
      ...(result.timing ? { timing: result.timing } : {}),
    };
  }

  return {
    hits: shapedHits,
    ...(shapedRegistryHits.length > 0 ? { registryHits: shapedRegistryHits } : {}),
    ...(searchMode ? { searchMode } : {}),
    ...(warnings ? { warnings } : {}),
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
  // needing --detail full or --shape agent (REC-03).
  if (detail === "brief") {
    return pickFields(hit, [
      "type",
      "name",
      "ref",
      "action",
      "estimatedTokens",
      "keys",
      "selectedRef",
      "parentRef",
      "fragmentOrdinal",
      "fragmentCount",
      "parentEstimatedTokens",
    ]);
  }
  if (detail === "normal") {
    // `warnings` is projected at `normal` so non-fatal hit-level issues are
    // visible without forcing callers up to `--detail full`. Optional
    // `quality` (v1 spec §4.2) is also surfaced when present so callers
    // can see why a `proposed` entry showed up under `--include-proposed`.
    // `matchStage` (issue #856) surfaces which stage of the progressive
    // AND->OR lexical ladder produced the hit; cheap compact enum, worth
    // showing without requiring `--detail full`.
    const shaped = capDescription(
      pickFields(hit, [
        "type",
        "name",
        "description",
        "action",
        "score",
        "estimatedTokens",
        "warnings",
        "quality",
        "matchStage",
        ...FRAGMENT_PROVENANCE_FIELDS,
      ]),
      NORMAL_DESCRIPTION_LIMIT,
    );
    if (Array.isArray(hit.keys) && hit.keys.length > 0) shaped.keys = hit.keys;
    return shaped;
  }
  return hit;
}

/** Agent-optimized search hit: only fields an LLM agent needs to decide and act */
export function shapeSearchHitForAgent(hit: Record<string, unknown>): Record<string, unknown> {
  const picked = pickFields(hit, [
    "name",
    "ref",
    "type",
    "path",
    "editable",
    "editHint",
    "description",
    "action",
    "score",
    "estimatedTokens",
    "keys",
    // Issue #856: which stage of the progressive AND->OR lexical ladder
    // produced this hit. Agents need this to gauge how much to trust a
    // hit (a strict-AND match is stronger signal than an OR-fallback
    // recovery match) without going to `--detail full`.
    "matchStage",
    ...FRAGMENT_PROVENANCE_FIELDS,
  ]);
  if (picked.editable !== false) delete picked.editHint;
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
  shape: ShapeMode = "human",
): Record<string, unknown> {
  if (shape === "agent") {
    const shaped = pickFields(result, [
      "type",
      "name",
      "ref",
      "path",
      "editable",
      "editHint",
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
      "related",
      ...FRAGMENT_PROVENANCE_FIELDS,
      ...FRAGMENT_CONTEXT_FIELDS,
    ]);
    if (shaped.editable !== false) delete shaped.editHint;
    return shaped;
  }
  if (shape === "summary") {
    return pickFields(result, [
      "type",
      "name",
      // ref is present on every show shape (human/summary/agent) — it is the
      // canonical identity of the asset, not an agent-only convenience field
      // (R-020).
      "ref",
      "description",
      "tags",
      "parameters",
      "workflowTitle",
      "action",
      "run",
      "origin",
      "keys",
      "related",
      ...FRAGMENT_PROVENANCE_FIELDS,
      ...FRAGMENT_CONTEXT_FIELDS,
    ]);
  }

  const base = pickFields(result, [
    "type",
    "name",
    // ref is always projected, same as path/editable below (R-020).
    "ref",
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
    "related",
    ...FRAGMENT_PROVENANCE_FIELDS,
    ...FRAGMENT_CONTEXT_FIELDS,
    // ref, path, and editable are always projected — at every --detail level,
    // not just --detail full — so JSON consumers can locate and edit the
    // asset without needing --detail full (QA #7 / D-14).
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
