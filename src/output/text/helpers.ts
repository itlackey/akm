// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure plain-text formatting helper functions shared across per-command
 * text formatter modules.
 *
 * No registry imports — no circular dependencies.
 */

import type { IndexResponse } from "../../indexer/indexer";
import type { DetailLevel } from "../context";

export function formatInfoPlain(r: Record<string, unknown>): string {
  const lines: string[] = [];
  if (r.version) lines.push(`version: ${String(r.version)}`);
  if (r.stashDir) lines.push(`stashDir: ${String(r.stashDir)}`);
  if (r.configPath) lines.push(`configPath: ${String(r.configPath)}`);
  if (r.cacheDir) lines.push(`cacheDir: ${String(r.cacheDir)}`);
  if (r.dbPath) lines.push(`dbPath: ${String(r.dbPath)}`);
  const capabilities = r.capabilities as Record<string, unknown> | undefined;
  if (capabilities) {
    lines.push("capabilities:");
    for (const [k, v] of Object.entries(capabilities)) {
      lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
  }
  const indexStats = r.index as Record<string, unknown> | undefined;
  if (indexStats) {
    lines.push("index:");
    for (const [k, v] of Object.entries(indexStats)) {
      lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
  }
  if (lines.length === 0) return JSON.stringify(r, null, 2);
  return lines.join("\n");
}

export function formatConfigPlain(r: Record<string, unknown>): string {
  // Recursive flattener: prints `key=value` lines, and nested objects as
  // `parent.child=value`. Arrays render as JSON for compactness.
  const lines: string[] = [];
  const walk = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v === null || v === undefined) {
        lines.push(`${path}=`);
      } else if (Array.isArray(v)) {
        lines.push(`${path}=${JSON.stringify(v)}`);
      } else if (typeof v === "object") {
        walk(v as Record<string, unknown>, path);
      } else {
        lines.push(`${path}=${String(v)}`);
      }
    }
  };
  walk(r, "");
  if (lines.length === 0) return "(empty config)";
  return lines.join("\n");
}

export function formatFeedbackPlain(r: Record<string, unknown>): string {
  const ref = String(r.ref ?? "?");
  const signal = String(r.signal ?? "?");
  const note = typeof r.note === "string" && r.note ? ` — ${r.note}` : "";
  return `Recorded ${signal} feedback for ${ref}${note}`;
}

export function formatRememberPlain(r: Record<string, unknown>): string {
  const ref = String(r.ref ?? "?");
  const pathValue = String(r.path ?? "?");
  return `Saved ${ref} at ${pathValue}`;
}

export function formatImportPlain(r: Record<string, unknown>): string {
  const ref = String(r.ref ?? "?");
  const source = String(r.source ?? "?");
  const pathValue = String(r.path ?? "?");
  return `Imported ${source} → ${ref} at ${pathValue}`;
}

export function formatSavePlain(r: Record<string, unknown>): string {
  if (r.ok === false) {
    const reason = typeof r.reason === "string" ? r.reason : "unknown";
    return `save: failed (${reason})`;
  }
  const name = typeof r.name === "string" ? r.name : "primary stash";
  const committed = r.committed === true;
  const pushed = r.pushed === true;
  const parts = [`save: ${name}`];
  parts.push(committed ? "committed" : "no changes");
  if (pushed) parts.push("pushed");
  return parts.join(" — ");
}

export function formatToggleComponentPlain(command: string, r: Record<string, unknown>): string {
  const verb = command === "enable" ? "Enabled" : "Disabled";
  const component = String(r.component ?? "?");
  const changed = r.changed === true;
  return changed ? `${verb} ${component}` : `${component} was already ${command}d`;
}

export function formatRegistryListPlain(r: Record<string, unknown>): string {
  const registries = Array.isArray(r.registries) ? (r.registries as Array<Record<string, unknown>>) : [];
  if (registries.length === 0) {
    return "No registries configured. Add one with `akm registry add <url>`.";
  }
  const lines: string[] = [];
  for (const reg of registries) {
    const url = String(reg.url ?? "?");
    const name = typeof reg.name === "string" ? reg.name : "";
    const provider = typeof reg.provider === "string" ? ` (${reg.provider})` : "";
    const enabled = reg.enabled === false ? " [disabled]" : "";
    const head = name ? `${name}: ${url}` : url;
    lines.push(`${head}${provider}${enabled}`);
  }
  return lines.join("\n");
}

export function formatRegistryAddPlain(r: Record<string, unknown>): string {
  if (r.added === false) {
    return typeof r.message === "string" ? r.message : "Registry already configured.";
  }
  const registries = Array.isArray(r.registries) ? r.registries.length : 0;
  return `Registry added (${registries} total).`;
}

export function formatRegistryRemovePlain(r: Record<string, unknown>): string {
  if (r.removed === false) {
    return typeof r.message === "string" ? r.message : "No matching registry found.";
  }
  const entry = r.entry as Record<string, unknown> | undefined;
  const url = entry ? String(entry.url ?? entry.name ?? "?") : "?";
  return `Removed registry ${url}`;
}

export function formatRegistrySearchPlain(r: Record<string, unknown>, detail: DetailLevel): string {
  // Reuse the same renderer as `search` — both share `hits` / `registryHits`.
  return formatSearchPlain(r, detail);
}

export function formatRegistryBuildIndexPlain(r: Record<string, unknown>): string {
  const outPath = String(r.outPath ?? "?");
  const total = typeof r.totalKits === "number" ? r.totalKits : 0;
  const version = typeof r.version === "number" ? `v${r.version}` : "";
  return `Wrote registry index ${version} (${total} kits) → ${outPath}`.replace(/\s+/g, " ").trim();
}

export function formatEnvListPlain(r: Record<string, unknown>): string {
  // Multi-env listing: { envs: [{ ref, path, keys }, ...] }
  const envs = Array.isArray(r.envs) ? (r.envs as Array<Record<string, unknown>>) : [];
  if (envs.length === 0) {
    return "No env files. Create one with `akm env create <name>`, then edit the .env file directly.";
  }
  const lines: string[] = [];
  for (const v of envs) {
    const ref = String(v.ref ?? "?");
    const keys = Array.isArray(v.keys) ? (v.keys as unknown[]).map(String) : [];
    if (lines.length > 0) lines.push("");
    lines.push(`## ${ref}`);
    if (keys.length === 0) {
      lines.push("- (no keys)");
      continue;
    }
    for (const key of keys) {
      lines.push(`- ${key}`);
    }
  }
  return lines.join("\n");
}

export function formatEnvCreatePlain(r: Record<string, unknown>): string {
  return `Created env ${String(r.ref ?? "?")}`;
}

export function formatEnvExportPlain(r: Record<string, unknown>): string {
  return `Wrote ${String(r.ref ?? "?")} export script → ${String(r.out ?? "?")} (mode 0600; source it, then delete)`;
}

export function formatEnvRemovePlain(r: Record<string, unknown>): string {
  const removed = r.removed === true;
  return removed ? `Removed env ${String(r.ref ?? "?")}` : `Env ${String(r.ref ?? "?")} was not present`;
}

export function formatEnvSetPlain(r: Record<string, unknown>): string {
  return `Set ${String(r.key ?? "?")} in env ${String(r.ref ?? "?")} (value not displayed)`;
}

export function formatEnvUnsetPlain(r: Record<string, unknown>): string {
  const removed = Array.isArray(r.removed) ? (r.removed as unknown[]).map(String) : [];
  const missing = Array.isArray(r.missing) ? (r.missing as unknown[]).map(String) : [];
  const ref = String(r.ref ?? "?");
  const parts: string[] = [];
  if (removed.length > 0) parts.push(`Removed ${removed.join(", ")} from env ${ref}`);
  if (missing.length > 0) parts.push(`Not present in env ${ref}: ${missing.join(", ")}`);
  return parts.join("\n") || `No keys changed in env ${ref}`;
}

export function formatWikiRegisterPlain(r: Record<string, unknown>): string {
  const name = String(r.name ?? r.wiki ?? "?");
  const ref = String(r.ref ?? r.path ?? r.url ?? "?");
  return `Registered wiki ${name} → ${ref}`;
}

export function formatWorkflowValidatePlain(r: Record<string, unknown>): string {
  const ok = r.ok !== false;
  const pathValue = String(r.path ?? "?");
  if (!ok) return `workflow validate: failed (${pathValue})`;
  const title = typeof r.title === "string" ? r.title : "";
  const stepCount = typeof r.stepCount === "number" ? r.stepCount : 0;
  return `workflow validate: ok — ${title || pathValue} (${stepCount} step(s))`;
}

/**
 * Plain-text rendering for a step-completion that was rejected by the
 * summary-validation gate (#506): the step stays pending and the agent gets
 * corrective feedback on what to finish/fix.
 */
export function formatWorkflowCompleteRejectedPlain(r: Record<string, unknown>): string {
  const stepId = String(r.stepId ?? "?");
  const feedback = typeof r.feedback === "string" ? r.feedback : "";
  const missing = Array.isArray(r.missing) ? (r.missing as unknown[]).map((m) => String(m)) : [];
  const lines = [`workflow complete: rejected — step "${stepId}" does not meet its completion criteria`];
  if (feedback) lines.push(`  feedback: ${feedback}`);
  if (missing.length > 0) {
    lines.push("  outstanding:");
    for (const m of missing) lines.push(`    - ${m}`);
  }
  return lines.join("\n");
}

export function formatProposalProducerPlain(command: string, r: Record<string, unknown>): string {
  if (r.ok === false) {
    const reason = String(r.reason ?? "unknown");
    const error = typeof r.error === "string" ? r.error : "";
    const lines = [`${command}: failed (${reason})`];
    if (error) lines.push(`  error: ${error}`);
    if (r.ref) lines.push(`  ref: ${String(r.ref)}`);
    if (r.exitCode !== undefined && r.exitCode !== null) {
      lines.push(`  exitCode: ${String(r.exitCode)}`);
    }
    return lines.join("\n");
  }
  const proposal = (r.proposal as Record<string, unknown>) ?? {};
  const id = String(proposal.id ?? "?");
  const ref = String(r.ref ?? proposal.ref ?? "?");
  const status = String(proposal.status ?? "pending");
  return `${command}: queued proposal ${id} (${ref}) [${status}]`;
}

export function formatProposalListPlain(r: Record<string, unknown>): string {
  const proposals = Array.isArray(r.proposals) ? (r.proposals as Array<Record<string, unknown>>) : [];
  const total = typeof r.totalCount === "number" ? r.totalCount : proposals.length;
  if (proposals.length === 0) {
    return `${total} proposal(s).\nNo proposals.\nGenerate one with \`akm reflect <ref>\`, \`akm propose <type> <name> --task ...\`, or \`akm distill <ref>\`.`;
  }
  const lines = [`${total} proposal(s)`, ""];
  for (const p of proposals) {
    const id = String(p.id ?? "?");
    const ref = String(p.ref ?? "?");
    const status = String(p.status ?? "?");
    const source = String(p.source ?? "?");
    const created = String(p.createdAt ?? "?");
    lines.push(`${id}  [${status}] ${ref}  source=${source}  ${created}`);
  }
  return lines.join("\n").trimEnd();
}

export function formatProposalShowPlain(r: Record<string, unknown>): string {
  const p = (r.proposal as Record<string, unknown>) ?? {};
  const lines: string[] = [];
  lines.push(`# proposal ${String(p.id ?? "?")}`);
  lines.push(`ref: ${String(p.ref ?? "?")}`);
  lines.push(`status: ${String(p.status ?? "?")}`);
  lines.push(`source: ${String(p.source ?? "?")}`);
  if (p.sourceRun) lines.push(`sourceRun: ${String(p.sourceRun)}`);
  if (p.createdAt) lines.push(`createdAt: ${String(p.createdAt)}`);
  if (p.updatedAt) lines.push(`updatedAt: ${String(p.updatedAt)}`);
  const review = p.review as Record<string, unknown> | undefined;
  if (review) {
    lines.push(`review.outcome: ${String(review.outcome ?? "?")}`);
    if (review.reason) lines.push(`review.reason: ${String(review.reason)}`);
    if (review.decidedAt) lines.push(`review.decidedAt: ${String(review.decidedAt)}`);
  }
  const validation = r.validation as Record<string, unknown> | undefined;
  if (validation) {
    const findings = Array.isArray(validation.findings) ? (validation.findings as Array<Record<string, unknown>>) : [];
    // Partition findings by severity. `severity: "warn"` findings are
    // non-blocking (the validator reports `ok: true` for a warn-only proposal),
    // so they must read as advisory — a distinct icon/label from blocking errors.
    const warnings = findings.filter((f) => f.severity === "warn");
    const errors = findings.filter((f) => f.severity !== "warn");
    lines.push("");
    if (errors.length > 0) {
      const warnSuffix = warnings.length > 0 ? `, ${warnings.length} warning(s)` : "";
      lines.push(`✗ invalid (${errors.length} error(s)${warnSuffix})`);
    } else if (warnings.length > 0) {
      lines.push(`✓ valid (${warnings.length} warning(s))`);
    } else {
      lines.push("✓ valid");
    }
    // Errors first (blocking), then warnings (advisory, non-blocking).
    for (const f of errors) {
      lines.push(`  ✗ error  [${String(f.kind)}] ${String(f.message)}`);
    }
    for (const f of warnings) {
      lines.push(`  ⚠ warning  [${String(f.kind)}] ${String(f.message)} (non-blocking)`);
    }
  }
  const payload = p.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload.content === "string") {
    lines.push("");
    lines.push("payload:");
    lines.push(payload.content);
  }
  return lines.join("\n").trimEnd();
}

export function formatProposalAcceptPlain(r: Record<string, unknown>): string {
  return `Accepted proposal ${String(r.id ?? "?")} → ${String(r.ref ?? "?")} at ${String(r.assetPath ?? "?")}`;
}

export function formatProposalRejectPlain(r: Record<string, unknown>): string {
  const reason = r.reason ? ` (${String(r.reason)})` : "";
  return `Rejected proposal ${String(r.id ?? "?")} (${String(r.ref ?? "?")})${reason}`;
}

export function formatProposalDrainPlain(r: Record<string, unknown>): string {
  const policy = String(r.policy ?? "?");
  const applyMode = String(r.applyMode ?? "queue");
  const promoted = Array.isArray(r.promoted) ? (r.promoted as unknown[]) : [];
  const rejected = Array.isArray(r.rejected) ? (r.rejected as unknown[]) : [];
  const deferred = Array.isArray(r.deferred) ? (r.deferred as Array<Record<string, unknown>>) : [];
  const skippedByCap = Array.isArray(r.skippedByCap) ? (r.skippedByCap as unknown[]) : [];
  const prefix = r.dryRun === true ? "[dry-run] " : "";
  const lines = [
    `${prefix}Drained proposal queue (policy=${policy}, applyMode=${applyMode})`,
    `  promoted: ${promoted.length}`,
    `  rejected: ${rejected.length}`,
    `  deferred: ${deferred.length}`,
    `  skippedByCap: ${skippedByCap.length}`,
  ];
  for (const d of deferred) {
    lines.push(`    - ${String(d.id ?? "?")} (${String(d.reason ?? "?")})`);
  }
  return lines.join("\n").trimEnd();
}

export function formatDistillPlain(r: Record<string, unknown>): string {
  const outcome = String(r.outcome ?? "unknown");
  const inputRef = String(r.inputRef ?? "?");
  const lessonRef = String(r.lessonRef ?? "?");
  if (outcome === "queued") {
    const id = String(r.proposalId ?? "?");
    return `Distilled ${inputRef} → proposal ${id} (${lessonRef}). Run \`akm proposal show ${id}\` to review.`;
  }
  if (outcome === "validation_failed") {
    const findings = Array.isArray(r.findings) ? (r.findings as Array<Record<string, unknown>>) : [];
    const lines = [`Distillation produced an invalid lesson for ${inputRef}; no proposal queued.`];
    for (const f of findings) {
      lines.push(`  - ${String(f.message ?? f.kind ?? "validation finding")}`);
    }
    return lines.join("\n");
  }
  // skipped
  const message = typeof r.message === "string" ? r.message : "feature disabled or LLM unavailable";
  return `Distill skipped for ${inputRef}: ${message}`;
}

export function formatProposalDiffPlain(r: Record<string, unknown>): string {
  const header = r.isNew
    ? `# proposal ${String(r.id ?? "?")} (new asset: ${String(r.ref ?? "?")})`
    : `# proposal ${String(r.id ?? "?")} (update: ${String(r.ref ?? "?")})`;
  const unified = typeof r.unified === "string" ? r.unified : "";
  if (!unified) return `${header}\n(no changes)`;
  return `${header}\n${unified}`;
}

export function formatEventsPlain(r: Record<string, unknown>): string {
  const events = Array.isArray(r.events) ? (r.events as Array<Record<string, unknown>>) : [];
  const headerParts: string[] = [];
  if (typeof r.ref === "string" && r.ref) headerParts.push(`ref: ${r.ref}`);
  if (typeof r.type === "string" && r.type) headerParts.push(`type: ${r.type}`);
  if (typeof r.since === "string" && r.since) headerParts.push(`since: ${r.since}`);
  const totalCount = typeof r.totalCount === "number" ? r.totalCount : events.length;
  headerParts.push(`${totalCount} event(s)`);
  const header = headerParts.join("  ");
  if (events.length === 0) {
    return `${header}\nNo events.`;
  }
  const lines = [header, ""];
  for (const event of events) {
    lines.push(formatEventLine(event));
  }
  return lines.join("\n").trimEnd();
}

export function formatEventLine(event: Record<string, unknown>): string {
  const ts = String(event.ts ?? "?");
  const eventType = String(event.eventType ?? "?");
  const ref = event.ref ? String(event.ref) : null;
  const head = ref ? `${ts}  [${eventType}] ${ref}` : `${ts}  [${eventType}]`;
  if (event.metadata != null && event.metadata !== "") {
    const meta = typeof event.metadata === "string" ? event.metadata : JSON.stringify(event.metadata);
    return `${head}\n  metadata: ${meta}`;
  }
  return head;
}

export function formatHistoryPlain(r: Record<string, unknown>): string {
  const entries = Array.isArray(r.entries) ? (r.entries as Array<Record<string, unknown>>) : [];
  const headerParts: string[] = [];
  if (typeof r.ref === "string" && r.ref) headerParts.push(`ref: ${r.ref}`);
  if (typeof r.since === "string" && r.since) headerParts.push(`since: ${r.since}`);
  const totalCount = typeof r.totalCount === "number" ? r.totalCount : entries.length;
  headerParts.push(`${totalCount} event(s)`);
  // Show active event sources so operators know which streams were consulted.
  if (Array.isArray(r.sources) && r.sources.length > 0) {
    headerParts.push(`sources: ${(r.sources as string[]).join(", ")}`);
  }
  const header = headerParts.join("  ");

  if (entries.length === 0) {
    const scope = typeof r.ref === "string" && r.ref ? ` for ${r.ref}` : "";
    return `${header}\nNo history${scope}.`;
  }

  const lines: string[] = [header, ""];
  for (const entry of entries) {
    const created = String(entry.createdAt ?? "?");
    const eventType = String(entry.eventType ?? "?");
    const ref = entry.ref ? String(entry.ref) : null;
    const signal = entry.signal ? String(entry.signal) : null;
    const query = entry.query ? String(entry.query) : null;

    const head = ref ? `${created}  [${eventType}] ${ref}` : `${created}  [${eventType}]`;
    lines.push(head);
    if (signal) lines.push(`  signal: ${signal}`);
    if (query) lines.push(`  query: ${query}`);
    if (entry.metadata != null && entry.metadata !== "") {
      const meta = typeof entry.metadata === "string" ? entry.metadata : JSON.stringify(entry.metadata);
      lines.push(`  metadata: ${meta}`);
    }
  }
  return lines.join("\n").trimEnd();
}

export function formatShowPlain(r: Record<string, unknown>, detail: DetailLevel): string | null {
  const lines: string[] = [];
  if (r.type || r.name) {
    lines.push(`# ${String(r.type ?? "asset")}: ${String(r.name ?? "unknown")}`);
  }
  if (r.path && r.editable !== false) {
    lines.push(`file: ${String(r.path)}`);
  }
  if (r.origin !== undefined) lines.push(`# origin: ${String(r.origin)}`);
  if (r.action) lines.push(`# ${String(r.action)}`);
  if (r.description) lines.push(`description: ${String(r.description)}`);
  if (r.workflowTitle) lines.push(`workflowTitle: ${String(r.workflowTitle)}`);
  if (r.agent) lines.push(`agent: ${String(r.agent)}`);
  if (Array.isArray(r.parameters) && r.parameters.length > 0) lines.push(`parameters: ${r.parameters.join(", ")}`);
  if (Array.isArray(r.workflowParameters) && r.workflowParameters.length > 0) {
    lines.push("workflowParameters:");
    for (const parameter of r.workflowParameters as Array<Record<string, unknown>>) {
      const name = typeof parameter.name === "string" ? parameter.name : "unknown";
      const description =
        typeof parameter.description === "string" && parameter.description.trim() ? `: ${parameter.description}` : "";
      lines.push(`  - ${name}${description}`);
    }
  }
  if (r.modelHint != null) lines.push(`modelHint: ${String(r.modelHint)}`);
  if (r.toolPolicy != null) lines.push(`toolPolicy: ${JSON.stringify(r.toolPolicy)}`);
  if (r.run) lines.push(`run: ${String(r.run)}`);
  if (r.setup) lines.push(`setup: ${String(r.setup)}`);
  if (r.cwd) lines.push(`cwd: ${String(r.cwd)}`);
  if (detail === "full") {
    if (r.path) lines.push(`path: ${String(r.path)}`);
    if (r.editable !== undefined) lines.push(`editable: ${String(r.editable)}`);
    if (r.editHint) lines.push(`editHint: ${String(r.editHint)}`);
    if (r.schemaVersion !== undefined) lines.push(`schemaVersion: ${String(r.schemaVersion)}`);
  }
  const related =
    typeof r.related === "object" && r.related !== null ? (r.related as Record<string, unknown>) : undefined;
  const relatedHits = related && Array.isArray(related.hits) ? (related.hits as Array<Record<string, unknown>>) : [];
  if (related) {
    lines.push("");
    lines.push(`related: ${String(related.total ?? relatedHits.length)}`);
    for (const hit of relatedHits) {
      lines.push(`  - ${String(hit.type ?? "?")}: ${formatRelatedLabel(hit)}`);
      const shared = Array.isArray(hit.sharedEntities) ? (hit.sharedEntities as unknown[]).map(String) : [];
      if (shared.length > 0) lines.push(`    shared: ${shared.join(", ")}`);
      lines.push(`    relationCount: ${String(hit.relationCount ?? 0)}`);
    }
  }
  const payloads = [r.content, r.template, r.prompt].filter((value) => value != null).map(String);
  if (Array.isArray(r.steps) && r.steps.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("steps:");
    for (const [index, step] of (r.steps as Array<Record<string, unknown>>).entries()) {
      const title = typeof step.title === "string" ? step.title : "Untitled step";
      const id = typeof step.id === "string" ? step.id : "unknown";
      lines.push(`  ${index + 1}. ${title} [${id}]`);
      if (typeof step.instructions === "string" && step.instructions.trim()) {
        const instrLines = step.instructions.trim().split("\n");
        lines.push(`     instructions: ${instrLines[0]}`);
        for (const instrLine of instrLines.slice(1)) lines.push(`       ${instrLine}`);
      }
      if (Array.isArray(step.completionCriteria) && step.completionCriteria.length > 0) {
        lines.push("     completion:");
        for (const criterion of step.completionCriteria) {
          lines.push(`       - ${String(criterion)}`);
        }
      }
    }
  }
  if (payloads.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...payloads);
  }

  // REC-01 / REC-09: Append a type-specific directive so agents apply the
  // content rather than substituting training-data approximations.
  const assetType = typeof r.type === "string" ? r.type : null;
  const assetRef = typeof r.name === "string" && assetType ? `${assetType}:${r.name}` : null;

  // Show-loop detection: if the agent has shown this asset 3+ times without
  // writing anything, surface a warning so it stops cycling and acts.
  const showLoopCount = typeof r.showLoopWarning === "number" ? r.showLoopWarning : 0;
  if (showLoopCount >= 3) {
    lines.push("");
    lines.push(`WARNING: You have shown this asset ${showLoopCount} times without completing the task.`);
    lines.push("Stop re-reading — you have the information you need. Act on it now:");
    lines.push("  - Write your output file using the content above.");
    lines.push(
      `  - If this asset does not contain what you need, run \`akm feedback '${assetRef ?? "<ref>"}' --negative\` and search for a different asset.`,
    );
  }

  if (assetType === "skill" || assetType === "knowledge") {
    const activeRun = r.activeRun as { runId: string; stepId: string | null; workflowRef: string } | null | undefined;
    if (activeRun) {
      // Active workflow: redirect agent to workflow commands instead of direct apply
      lines.unshift(
        `  akm workflow complete '${activeRun.runId}'${activeRun.stepId ? ` --step '${activeRun.stepId}'` : ""}`,
      );
      lines.unshift(
        "Read this schema, then follow your workflow step's instructions to edit the workspace file. When done, mark the step complete:",
      );
      lines.unshift(`WORKFLOW ACTIVE — schema shown as reference (run: ${activeRun.runId})`);
      lines.unshift("---");
      lines.unshift("");
      // Still show feedback line at the end but skip the APPLY directive
      lines.push("");
      lines.push(
        `Run \`akm feedback ${assetRef ? `'${assetRef}'` : "<ref>"} --positive\` if the step succeeds, or \`--negative\` if this schema did not help.`,
      );
    } else {
      // No active workflow: show the APPLY directive. Branch on whether this
      // skill primarily teaches CLI commands (shell output) vs YAML schema.
      const preApplyLines = [...lines];
      lines.push("");
      lines.push("---");
      if (isCommandOutputSkill(preApplyLines)) {
        lines.push("APPLY (only if no workflow step is required for this task):");
        lines.push("  1. Identify the output file from README.md (typically commands.txt).");
        lines.push(
          "  2. Write the exact command syntax from the code blocks above — replace every placeholder (`<name>`, `<value>`) with a real, concrete value from your task context. Do not write placeholder text.",
        );
        lines.push(
          "  3. Each command should be on a single line (no backslash line continuation unless the verifier expects it).",
        );
        lines.push(
          `Run \`akm feedback ${assetRef ? `'${assetRef}'` : "<ref>"} --positive\` after the task succeeds, or \`--negative\` if this reference did not contain the needed command syntax.`,
        );
      } else {
        lines.push("APPLY (only if no workflow step is required for this task):");
        lines.push(
          "  1. Identify the target file from README.md — write or edit it. If the file does not yet exist, CREATE it with the full structure from this schema.",
        );
        lines.push("  2. Add/edit the fields shown above using the exact field names from this schema.");
        lines.push(
          "  3. COPY the exact YAML structure and field names from the code blocks above — do not substitute synonyms or invent nesting. Replace every placeholder value with a real, concrete value from your task context. Do not leave any field as null, empty, or a placeholder.",
        );
        lines.push(
          `Run \`akm feedback ${assetRef ? `'${assetRef}'` : "<ref>"} --positive\` after the task succeeds, or \`--negative\` if the task fails after following this guidance.`,
        );
      }
    }
  } else if (assetType === "workflow") {
    const workflowName = typeof r.name === "string" ? r.name : null;
    const workflowRef = workflowName ? `workflow:${workflowName}` : "<ref>";
    // Insert action directive BEFORE the workflow content by prepending to lines at the
    // separator position. We find where the header ends and insert after the first `---`.
    // Since lines already contain the full content at this point, we locate the insertion
    // index: right after the first `---` separator if present, otherwise after the header.
    const separatorIdx = lines.indexOf("---");
    const insertIdx = separatorIdx >= 0 ? separatorIdx + 1 : r.type || r.name ? 1 : 0;
    const actionDirective = [
      `ACTION REQUIRED: Do not execute steps manually from this output.`,
      `Run \`akm workflow next '${workflowRef}'\` to get your current step with exact instructions.`,
      "---",
    ];
    lines.splice(insertIdx, 0, "", ...actionDirective);
    lines.push("");
    lines.push("---");
    lines.push(`NEXT STEP: Run \`akm workflow next '${workflowRef}'\` to see the current workflow step.`);
    lines.push("Do not edit workspace files before completing each step with `akm workflow complete`.");
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Detect whether a skill's rendered content primarily teaches CLI commands
 * rather than YAML schema. Used to select the right APPLY directive variant.
 *
 * Heuristic: count code-block lines that start with known shell command
 * prefixes vs lines that look like YAML key-value pairs. If CLI lines
 * outnumber YAML lines (and there is at least one CLI line), treat the
 * skill as command-output.
 */
function isCommandOutputSkill(lines: string[]): boolean {
  const codeLines = lines.filter((l) => l.startsWith("  ") || l.startsWith("\t") || /^`/.test(l));
  const cliPattern = /^(az |kubectl |docker |git |helm |terraform |aws |gcloud )/;
  const yamlPattern = /^\s+\w+:/;
  const cliCount = codeLines.filter((l) => cliPattern.test(l.trim())).length;
  const yamlCount = codeLines.filter((l) => yamlPattern.test(l)).length;
  return cliCount > yamlCount && cliCount > 0;
}

export function formatWorkflowListPlain(result: Record<string, unknown>): string {
  const runs = Array.isArray(result.runs) ? (result.runs as Array<Record<string, unknown>>) : [];
  if (runs.length === 0) {
    return "No workflow runs in the current working scope. Start one with `akm workflow next workflow:<name>` or author one with `akm workflow create <name>`.";
  }

  return runs
    .map((run) => {
      const id = typeof run.id === "string" ? run.id : "unknown";
      const ref = typeof run.workflowRef === "string" ? run.workflowRef : "workflow:unknown";
      const status = typeof run.status === "string" ? run.status : "unknown";
      const currentStep = typeof run.currentStepId === "string" ? ` (current: ${run.currentStepId})` : "";
      return `${id} ${ref} [${status}]${currentStep}`;
    })
    .join("\n");
}

export function formatWorkflowStatusPlain(result: Record<string, unknown>): string | null {
  const run =
    typeof result.run === "object" && result.run !== null ? (result.run as Record<string, unknown>) : undefined;
  const workflow =
    typeof result.workflow === "object" && result.workflow !== null
      ? (result.workflow as Record<string, unknown>)
      : undefined;
  if (!run || !workflow) return null;

  const lines = [
    `workflow: ${String(workflow.ref ?? "workflow:unknown")}`,
    `run: ${String(run.id ?? "unknown")}`,
    `title: ${String(run.workflowTitle ?? workflow.title ?? "Workflow")}`,
    `status: ${String(run.status ?? "unknown")}`,
  ];
  if (run.currentStepId) lines.push(`currentStep: ${String(run.currentStepId)}`);

  const steps = Array.isArray(workflow.steps) ? (workflow.steps as Array<Record<string, unknown>>) : [];
  if (steps.length > 0) {
    lines.push("steps:");
    for (const step of steps) {
      const title = typeof step.title === "string" ? step.title : "Untitled step";
      const id = typeof step.id === "string" ? step.id : "unknown";
      const status = typeof step.status === "string" ? step.status : "unknown";
      lines.push(`  - ${title} [${id}] (${status})`);
      if (typeof step.notes === "string" && step.notes.trim()) {
        lines.push(`    notes: ${step.notes}`);
      }
    }
  }
  return lines.join("\n");
}

export function formatWorkflowNextPlain(result: Record<string, unknown>): string | null {
  const base = formatWorkflowStatusPlain(result);
  const step =
    typeof result.step === "object" && result.step !== null ? (result.step as Record<string, unknown>) : undefined;
  if (!step) return base;

  const lines = base ? [base, "", "next:"] : ["next:"];
  lines.push(`  ${String(step.title ?? "Untitled step")} [${String(step.id ?? "unknown")}]`);
  if (typeof step.instructions === "string" && step.instructions.trim()) {
    const instrLines = step.instructions.trim().split("\n");
    lines.push(`  instructions: ${instrLines[0]}`);
    for (const instrLine of instrLines.slice(1)) lines.push(`    ${instrLine}`);
  }
  const completion = Array.isArray(step.completionCriteria) ? step.completionCriteria : [];
  if (completion.length > 0) {
    lines.push("  completion:");
    for (const criterion of completion) {
      lines.push(`    - ${String(criterion)}`);
    }
  }

  // T2-3: surface run-id as labeled field
  const run =
    typeof result.run === "object" && result.run !== null ? (result.run as Record<string, unknown>) : undefined;
  const runId = typeof run?.id === "string" ? run.id : null;
  const stepId = typeof step?.id === "string" ? step.id : null;
  if (runId) {
    lines.push("");
    lines.push(`runId: ${runId}`);
  }

  // T1-6: complete command
  if (runId && stepId) {
    lines.push("");
    lines.push("COMPLETE THIS STEP:");
    lines.push(`  akm workflow complete '${runId}' --step '${stepId}'`);
  } else if (runId) {
    lines.push("");
    lines.push("COMPLETE THIS STEP:");
    lines.push(`  akm workflow complete '${runId}' --step '<step-id>'`);
  }

  return lines.join("\n");
}

export function formatSearchPlain(r: Record<string, unknown>, detail: DetailLevel): string {
  const hits = (r.hits as Record<string, unknown>[]) ?? [];
  const registryHits = (r.registryHits as Record<string, unknown>[]) ?? [];
  const allHits = [...hits, ...registryHits];

  if (allHits.length === 0) {
    const warnings = Array.isArray(r.warnings) ? (r.warnings as unknown[]) : [];
    const hasSetupWarning = warnings.some(
      (w) => String(w).toLowerCase().includes("no stash") || String(w).toLowerCase().includes("not configured"),
    );
    if (hasSetupWarning) {
      return "No stash configured. Run `akm init` to create your working stash, then `akm index` to build the search index.";
    }
    const base = r.tip ? String(r.tip) : "No matches found.";
    return `${base}\nTry:\n  akm search '<broader-term>'          # fewer keywords\n  akm list                             # see all configured sources\n  akm curate '<query>'                 # let akm select the best match`;
  }

  const lines: string[] = [];

  for (const hit of allHits) {
    const type = hit.type ?? "unknown";
    const name = hit.name ?? "unnamed";
    const score = hit.score != null ? ` (score: ${hit.score})` : "";
    const desc = hit.description ? `  ${hit.description}` : "";

    lines.push(`${type}: ${name}${score}`);
    if (desc) lines.push(desc);

    if (hit.id) lines.push(`  id: ${String(hit.id)}`);
    if (hit.ref) lines.push(`  ref: ${String(hit.ref)}`);
    if (hit.origin !== undefined) lines.push(`  origin: ${String(hit.origin)}`);
    if (Array.isArray(hit.keys) && hit.keys.length > 0) lines.push(`  keys: ${hit.keys.join(", ")}`);
    if (hit.size) lines.push(`  size: ${String(hit.size)}`);
    if (hit.action) lines.push(`  action: ${String(hit.action)}`);
    if (hit.run) lines.push(`  run: ${String(hit.run)}`);
    if (Array.isArray(hit.tags) && hit.tags.length > 0) lines.push(`  tags: ${hit.tags.join(", ")}`);
    // Optional v1 spec §4.2 quality marker (e.g. "curated" / "proposed").
    if (typeof hit.quality === "string" && hit.quality) lines.push(`  quality: ${hit.quality}`);
    // Surface optional hit-level warnings (v1 spec §4.2). The legacy
    // `curated` boolean was removed in v1.
    if (Array.isArray(hit.warnings) && hit.warnings.length > 0) {
      lines.push(`  warnings: ${(hit.warnings as string[]).join("; ")}`);
    }
    const graph =
      typeof hit.graph === "object" && hit.graph !== null ? (hit.graph as Record<string, unknown>) : undefined;
    if (graph) {
      const entities = Array.isArray(graph.entities) ? (graph.entities as Array<Record<string, unknown>>) : [];
      if (entities.length > 0) {
        const matched = entities
          .filter((entity) => String(entity.kind ?? "") === "matched")
          .map((entity) => String(entity.name ?? "?"));
        const neighbors = entities
          .filter((entity) => String(entity.kind ?? "") !== "matched")
          .map((entity) => String(entity.name ?? "?"));
        lines.push(
          `  graph: ${[
            matched.length > 0 ? `query match=${matched.join(", ")}` : undefined,
            neighbors.length > 0 ? `neighbors=${neighbors.join(", ")}` : undefined,
          ]
            .filter(Boolean)
            .join("; ")}`,
        );
      }
    }

    if (detail === "full") {
      if (hit.path) lines.push(`  path: ${String(hit.path)}`);
      if (hit.editable != null) lines.push(`  editable: ${String(hit.editable)}`);
      if (hit.editHint) lines.push(`  editHint: ${String(hit.editHint)}`);
      const whyMatched = hit.whyMatched as string[] | undefined;
      if (whyMatched && whyMatched.length > 0) {
        lines.push(`  whyMatched: ${whyMatched.join(", ")}`);
      }
    }

    lines.push(""); // blank line between hits
  }

  if (detail === "full" && r.timing) {
    const timing = r.timing as Record<string, unknown>;
    const parts: string[] = [];
    if (timing.totalMs != null) parts.push(`total: ${timing.totalMs}ms`);
    if (timing.rankMs != null) parts.push(`rank: ${timing.rankMs}ms`);
    if (timing.embedMs != null) parts.push(`embed: ${timing.embedMs}ms`);
    if (parts.length > 0) lines.push(`timing: ${parts.join(", ")}`);
  }

  // REC-02: When stash hits exist, tell the agent the next required step so it
  // doesn't skip `akm show` and write from training memory instead.
  if (hits.length >= 1) {
    // Prefer skill/command/agent type hits for the "Next:" ref — knowledge docs are
    // supplementary context, not the authoritative schema agents should load first.
    const preferredHit = hits.find((h) => h.type === "skill" || h.type === "command" || h.type === "agent") ?? hits[0];
    const topRef = typeof preferredHit.ref === "string" ? preferredHit.ref : null;
    const hasWorkflowHit = hits.some((h) => h.type === "workflow");
    if (topRef) {
      if (hasWorkflowHit) {
        const workflowRef = hits.find((h) => h.type === "workflow");
        const wfRef = workflowRef && typeof workflowRef.ref === "string" ? workflowRef.ref : topRef;
        lines.push(`Next: akm show '${topRef}'  |  To start a workflow: akm workflow next '${wfRef}'`);
        lines.push(
          "After running workflow next: follow each step and run `akm workflow complete <run-id> --step <step-id>` when done.",
        );
      } else {
        lines.push(`Next: akm show '${topRef}'`);
        lines.push(
          "After reading the asset: check whether a workflow applies before editing — if so, use `akm workflow next` instead.",
        );
      }
    }
  }

  return lines.join("\n").trimEnd();
}

export function formatWikiListPlain(r: Record<string, unknown>): string {
  const wikis = Array.isArray(r.wikis) ? (r.wikis as Array<Record<string, unknown>>) : [];
  if (wikis.length === 0)
    return "No wikis. Create one with `akm wiki create <name>` or register one with `akm wiki register <name> <path-or-repo>`.";
  const lines = ["NAME\tPAGES\tRAWS\tLAST-MODIFIED"];
  for (const w of wikis) {
    const name = typeof w.name === "string" ? w.name : "?";
    const pages = typeof w.pages === "number" ? w.pages : 0;
    const raws = typeof w.raws === "number" ? w.raws : 0;
    const modified = typeof w.lastModified === "string" ? w.lastModified : "-";
    lines.push(`${name}\t${pages}\t${raws}\t${modified}`);
  }
  return lines.join("\n");
}

export function formatWikiShowPlain(r: Record<string, unknown>): string {
  const lines: string[] = [];
  if (r.name) lines.push(`# wiki: ${String(r.name)}`);
  if (r.path) lines.push(`path: ${String(r.path)}`);
  if (r.description) lines.push(`description: ${String(r.description)}`);
  if (typeof r.pages === "number") lines.push(`pages: ${r.pages}`);
  if (typeof r.raws === "number") lines.push(`raws: ${r.raws}`);
  if (r.lastModified) lines.push(`lastModified: ${String(r.lastModified)}`);
  const recentLog = Array.isArray(r.recentLog) ? (r.recentLog as string[]) : [];
  if (recentLog.length > 0) {
    lines.push("", "recent log:");
    for (const entry of recentLog) {
      lines.push(entry);
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

export function formatWikiCreatePlain(r: Record<string, unknown>): string {
  const created = Array.isArray(r.created) ? (r.created as string[]) : [];
  const skipped = Array.isArray(r.skipped) ? (r.skipped as string[]) : [];
  const lines = [`Created wiki ${String(r.ref ?? r.name)} at ${String(r.path ?? "?")}`];
  if (created.length > 0) lines.push(`  created: ${created.length} file(s)`);
  if (skipped.length > 0) lines.push(`  skipped: ${skipped.length} existing file(s)`);
  return lines.join("\n");
}

export function formatWikiRemovePlain(r: Record<string, unknown>): string {
  const preserved = r.preservedRaw === true;
  const removed = Array.isArray(r.removed) ? (r.removed as string[]).length : 0;
  const base = `Removed wiki ${String(r.name ?? "?")} (${removed} path(s))`;
  return preserved ? `${base}; raw/ preserved at ${String(r.rawPath ?? "raw/")}` : base;
}

export function formatWikiPagesPlain(r: Record<string, unknown>): string {
  const pages = Array.isArray(r.pages) ? (r.pages as Array<Record<string, unknown>>) : [];
  if (pages.length === 0) return `No pages in wiki:${String(r.wiki ?? "?")}.`;
  const lines: string[] = [];
  for (const p of pages) {
    const ref = String(p.ref ?? "?");
    const kind = typeof p.pageKind === "string" ? ` [${p.pageKind}]` : "";
    const desc = typeof p.description === "string" && p.description ? ` — ${p.description}` : "";
    lines.push(`${ref}${kind}${desc}`);
  }
  return lines.join("\n");
}

export function formatWikiStashPlain(r: Record<string, unknown>): string {
  const slug = String(r.slug ?? "?");
  const pathValue = String(r.path ?? "?");
  return `Stashed ${slug} → ${pathValue}`;
}

export function formatWikiLintPlain(r: Record<string, unknown>): string {
  const findings = Array.isArray(r.findings) ? (r.findings as Array<Record<string, unknown>>) : [];
  const pagesScanned = typeof r.pagesScanned === "number" ? r.pagesScanned : 0;
  const rawsScanned = typeof r.rawsScanned === "number" ? r.rawsScanned : 0;
  const header = `${findings.length} finding(s) in wiki:${String(r.wiki ?? "?")} (${pagesScanned} page(s), ${rawsScanned} raw(s))`;
  if (findings.length === 0) return `${header} — clean.`;
  const lines = [header];
  for (const f of findings) {
    const kind = String(f.kind ?? "?");
    const message = String(f.message ?? "");
    lines.push(`- [${kind}] ${message}`);
  }
  return lines.join("\n");
}

export function formatWikiIngestPlain(r: Record<string, unknown>): string {
  if (typeof r.workflow === "string") return r.workflow;
  return JSON.stringify(r, null, 2);
}

export function formatCuratePlain(r: Record<string, unknown>, detail: DetailLevel): string {
  const query = typeof r.query === "string" ? r.query : "";
  const summary = typeof r.summary === "string" ? r.summary : "";
  const items = Array.isArray(r.items) ? (r.items as Record<string, unknown>[]) : [];

  const lines: string[] = [`Curated results for "${query}"`];
  if (summary) lines.push(summary);
  if (items.length === 0) {
    if (r.tip) lines.push(String(r.tip));
    return lines.join("\n");
  }

  for (const item of items) {
    const type = typeof item.type === "string" ? item.type : "unknown";
    const name = typeof item.name === "string" ? item.name : "unnamed";
    lines.push("");
    lines.push(`[${type}] ${name}`);
    if (item.description) lines.push(`  ${String(item.description)}`);
    if (item.preview) lines.push(`  preview: ${String(item.preview)}`);
    if (item.ref) lines.push(`  ref: ${String(item.ref)}`);
    if (item.id) lines.push(`  id: ${String(item.id)}`);
    if (Array.isArray(item.keys) && item.keys.length > 0) {
      lines.push(`  keys: ${item.keys.join(", ")}`);
    }
    if (Array.isArray(item.parameters) && item.parameters.length > 0) {
      lines.push(`  parameters: ${item.parameters.join(", ")}`);
    }
    if (item.run) lines.push(`  run: ${String(item.run)}`);
    if (item.followUp) lines.push(`  show: ${String(item.followUp)}`);
    if (detail !== "brief" && item.reason) lines.push(`  why: ${String(item.reason)}`);
  }

  const warnings = Array.isArray(r.warnings) ? r.warnings : [];
  if (warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of warnings) {
      lines.push(`- ${String(warning)}`);
    }
  }

  lines.push("");
  lines.push("Next steps:");
  lines.push("  1. Run `akm show <ref>` for the best result above to read the full schema.");
  lines.push("  2. Edit the workspace file using the schema field names and your task-specific values.");
  lines.push("  3. Run `akm feedback <ref> --positive` when the task succeeds.");
  lines.push("To search further: akm search '<query>'");

  return lines.join("\n");
}

export function formatInitPlain(r: Record<string, unknown>): string {
  let out = `Stash initialized at ${r.stashDir ?? "unknown"}`;
  if (r.configPath) out += `\nConfig saved to ${r.configPath}`;
  return out;
}

export function formatIndexPlain(r: Record<string, unknown>): string {
  const indexResult = r as Partial<IndexResponse>;
  let out = `Indexed ${indexResult.totalEntries ?? 0} entries from ${indexResult.directoriesScanned ?? 0} directories (mode: ${indexResult.mode ?? "unknown"})`;
  const warnings = indexResult.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    out += `\nWarnings (${warnings.length}):`;
    for (const message of warnings) out += `\n  - ${String(message)}`;
  }
  const verification = indexResult.verification;
  if (verification?.ok === false && verification.message) {
    out += `\nVerification: ${String(verification.message)}`;
  }
  return out;
}

export function formatListPlain(r: Record<string, unknown>): string {
  const sources = Array.isArray(r.sources) ? (r.sources as Record<string, unknown>[]) : [];
  if (sources.length === 0) return "No sources configured. Use `akm add` to add a source.";
  const lines: string[] = [];
  for (const src of sources) {
    const kind = typeof src.kind === "string" ? src.kind : "unknown";
    const name = typeof src.name === "string" ? src.name : "unnamed";
    const ver = typeof src.version === "string" ? ` v${src.version}` : "";
    const prov = typeof src.provider === "string" ? ` (${src.provider})` : "";
    const flags: string[] = [];
    if (typeof src.wiki === "string") flags.push(`wiki:${src.wiki}`);
    if (src.updatable === true) flags.push("updatable");
    if (src.writable === true) flags.push("writable");
    const flagText = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
    lines.push(`[${kind}] ${name}${ver}${prov}${flagText}`);
  }
  lines.push("");
  lines.push("To search: akm search '<query>'  |  To view an asset: akm show <ref>");
  return lines.join("\n");
}

export function formatAddPlain(r: Record<string, unknown>): string {
  const index = r.index as Record<string, unknown> | undefined;
  const scanned = index?.directoriesScanned ?? 0;
  const total = index?.totalEntries ?? 0;
  const lines = [`Installed ${r.ref} (${scanned} directories scanned, ${total} total assets indexed)`];
  const warnings = index?.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    lines.push(`Warnings (${warnings.length}):`);
    for (const message of warnings) lines.push(`  - ${String(message)}`);
  }
  return lines.join("\n");
}

export function formatRemovePlain(r: Record<string, unknown>): string {
  const target = r.target ?? r.ref ?? "";
  const ok = r.ok !== false ? "OK" : "FAILED";
  return `remove: ${target} ${ok}`;
}

export function formatUpdatePlain(r: Record<string, unknown>): string {
  const processed = r.processed as Array<Record<string, unknown>> | undefined;
  if (!processed?.length) return `update: nothing to update`;
  const lines = processed.map((item) => {
    const changed = item.changed as Record<string, unknown> | undefined;
    const installed = item.installed as Record<string, unknown> | undefined;
    const previous = item.previous as Record<string, unknown> | undefined;
    if (changed?.any) {
      const prev = previous?.resolvedVersion ?? "unknown";
      const next = installed?.resolvedVersion ?? "unknown";
      return `update: ${item.id} v${prev} → v${next}`;
    }
    return `update: ${item.id} (unchanged)`;
  });
  return lines.join("\n");
}

export function formatUpgradePlain(r: Record<string, unknown>): string | null {
  if (r.upgraded === true) {
    return `akm upgraded: v${r.currentVersion} → v${r.newVersion}`;
  }
  if (r.updateAvailable === true) {
    return `akm v${r.currentVersion} → v${r.latestVersion} available (run 'akm upgrade' to install)`;
  }
  if (r.updateAvailable === false && r.latestVersion) {
    return `akm v${r.currentVersion} is already the latest version`;
  }
  if (r.message) return String(r.message);
  return null;
}

export function formatClonePlain(r: Record<string, unknown>): string {
  const dst = (r.destination as Record<string, unknown>)?.path ?? "unknown";
  const remote = r.remoteFetched ? " (fetched from remote)" : "";
  const over = r.overwritten ? " (overwritten)" : "";
  return `Cloned${remote} → ${dst}${over}`;
}

export function formatWorkflowCreatePlain(r: Record<string, unknown>): string | null {
  if (r.ref && r.path) {
    return `Created ${String(r.ref)} at ${String(r.path)}`;
  }
  return null;
}

export function formatWorkflowResumePlain(r: Record<string, unknown>): string {
  return formatWorkflowStatusPlain(r) ?? `Resumed workflow run ${String(r.id ?? r.runId ?? "?")}`;
}

function formatRelatedLabel(hit: Record<string, unknown>): string {
  const ref = typeof hit.ref === "string" ? hit.ref : undefined;
  if (ref) return ref;
  const pathValue = typeof hit.path === "string" ? hit.path : "?";
  return pathValue.split("/").pop() ?? pathValue;
}
