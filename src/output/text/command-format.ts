// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text renderers for the remaining leaf `akm` commands: info/config/
 * feedback/remember/import/save/enable/disable, registry, env, wiki,
 * events/history, search/curate, and the stash-lifecycle verbs (init,
 * index, list, add, remove, update, upgrade, clone).
 *
 * Split out of `helpers.ts` (formerly 1418 lines / 59 fns) as its own
 * sibling module: unlike `show`/`workflow`/`proposal` (each a stateful,
 * multi-branch renderer with its own module), these are flat
 * field-extraction formatters with no shared state beyond
 * `formatRegistrySearchPlain` delegating to `formatSearchPlain` in this
 * same file.
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
    if (Array.isArray(item.supportRefs) && item.supportRefs.length > 0) {
      for (const support of item.supportRefs as Array<Record<string, unknown>>) {
        if (!support.ref) continue;
        const label = typeof support.type === "string" ? `[${support.type}] ` : "";
        const why = typeof support.reason === "string" ? ` — ${support.reason}` : "";
        lines.push(`  support: ${label}${String(support.ref)}${why}`);
      }
    }
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
  // When --dir scaffolded a secondary stash but the default was deliberately
  // left untouched, tell the user instead of silently repointing their default.
  if (r.defaultStashUpdated === false && typeof r.previousStashDir === "string" && r.previousStashDir) {
    out += `\nYour default stash is unchanged (${r.previousStashDir}). Re-run with --set-default to make ${r.stashDir} the default.`;
  } else if (r.configPath) {
    out += `\nConfig saved to ${r.configPath}`;
  }
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
  const timing = indexResult.timing;
  if (timing) {
    out +=
      `\nTiming: total ${timing.totalMs}ms` +
      `, preflight ${timing.preflightMs}ms` +
      `, walk ${timing.walkMs}ms` +
      `, llm ${timing.llmMs}ms` +
      `, embeddings ${timing.embedMs}ms` +
      `, fts ${timing.ftsMs}ms` +
      `, finalize ${timing.finalizeMs}ms` +
      `, clean ${timing.cleanMs}ms` +
      `, end-to-end ${timing.endToEndMs}ms`;
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
