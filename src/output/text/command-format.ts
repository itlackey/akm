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

import { formatRegistryUrl } from "../../core/registry-url";
import type { IndexResponse } from "../../indexer/indexer";
import type { DetailLevel } from "../context";

/** Render the current `InfoResponse` shape. */
export function formatInfoPlain(r: Record<string, unknown>): string {
  const lines: string[] = [];
  if (r.version) lines.push(`version: ${String(r.version)}`);
  if (r.bundleDir) lines.push(`bundleDir: ${String(r.bundleDir)}`);
  if (r.defaultBundle !== undefined) {
    lines.push(`defaultBundle: ${r.defaultBundle === null ? "(none)" : String(r.defaultBundle)}`);
  }
  if (Array.isArray(r.assetTypes) && r.assetTypes.length > 0) {
    lines.push(`assetTypes: ${(r.assetTypes as unknown[]).join(", ")}`);
  }
  if (Array.isArray(r.searchModes) && r.searchModes.length > 0) {
    lines.push(`searchModes: ${(r.searchModes as unknown[]).join(", ")}`);
  }
  const semanticSearch = r.semanticSearch as Record<string, unknown> | undefined;
  if (semanticSearch) {
    lines.push("semanticSearch:");
    for (const [k, v] of Object.entries(semanticSearch)) {
      lines.push(`  ${k}: ${String(v)}`);
    }
  }
  const registries = Array.isArray(r.registries) ? (r.registries as Array<Record<string, unknown>>) : undefined;
  if (registries) {
    lines.push(`registries (${registries.length}):`);
    for (const reg of registries) {
      const name = typeof reg.name === "string" ? `${reg.name}: ` : "";
      const provider = typeof reg.provider === "string" ? ` (${reg.provider})` : "";
      const disabled = reg.enabled === false ? " [disabled]" : "";
      const url = typeof reg.url === "string" ? formatRegistryUrl(reg.url) : "?";
      lines.push(`  ${name}${url}${provider}${disabled}`);
    }
  }
  const sourceProviders = Array.isArray(r.sourceProviders)
    ? (r.sourceProviders as Array<Record<string, unknown>>)
    : undefined;
  if (sourceProviders) {
    lines.push(`sourceProviders (${sourceProviders.length}):`);
    for (const source of sourceProviders) {
      const label = source.name ?? source.path ?? source.url ?? source.type ?? "?";
      const disabled = source.enabled === false ? " [disabled]" : "";
      lines.push(`  [${String(source.type ?? "?")}] ${String(label)}${disabled}`);
    }
  }
  const indexStats = r.indexStats as Record<string, unknown> | undefined;
  if (indexStats) {
    lines.push("indexStats:");
    for (const [k, v] of Object.entries(indexStats)) {
      lines.push(`  ${k}: ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`);
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
        const rendered =
          typeof v === "string" && /^registries\.\d+\.url$/u.test(path) ? formatRegistryUrl(v) : String(v);
        lines.push(`${path}=${rendered}`);
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

export function formatSyncPlain(r: Record<string, unknown>): string {
  if (r.ok === false) {
    const reason = typeof r.reason === "string" ? r.reason : "unknown";
    return `sync: failed (${reason})`;
  }
  const name = typeof r.name === "string" ? r.name : "primary bundle";
  const committed = r.committed === true;
  const pushed = r.pushed === true;
  const parts = [`sync: ${name}`];
  parts.push(committed ? "committed" : "no changes");
  if (pushed) parts.push("pushed");
  return parts.join(" — ");
}

export function formatRegistryListPlain(r: Record<string, unknown>): string {
  const registries = Array.isArray(r.registries) ? (r.registries as Array<Record<string, unknown>>) : [];
  if (registries.length === 0) {
    return "No registries configured. Add one with `akm registry add <url>`.";
  }
  const lines: string[] = [];
  for (const reg of registries) {
    const url = typeof reg.url === "string" ? formatRegistryUrl(reg.url) : "?";
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
  const url = entry ? (typeof entry.url === "string" ? formatRegistryUrl(entry.url) : String(entry.name ?? "?")) : "?";
  return `Removed registry ${url}`;
}

export function formatRegistrySearchPlain(r: Record<string, unknown>, detail: DetailLevel): string {
  // Reuse the same renderer as `search` — both share `hits` / `registryHits`.
  return formatSearchPlain(r, detail);
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

export function formatSearchPlain(r: Record<string, unknown>, detail: DetailLevel): string {
  const hits = (r.hits as Record<string, unknown>[]) ?? [];
  const registryHits = (r.registryHits as Record<string, unknown>[]) ?? [];
  const allHits = [...hits, ...registryHits];

  if (allHits.length === 0) {
    const warnings = Array.isArray(r.warnings) ? (r.warnings as unknown[]) : [];
    const hasSetupWarning = warnings.some(
      (w) => String(w).toLowerCase().includes("no bundle") || String(w).toLowerCase().includes("not configured"),
    );
    if (hasSetupWarning) {
      return "No bundle configured. Run `akm bundle create` to create your working bundle, then `akm index` to build the search index.";
    }
    const base = r.tip ? String(r.tip) : "No matches found.";
    return `${base}\nTry:\n  akm search '<broader-term>'          # fewer keywords\n  akm bundle list                      # see all configured sources\n  akm curate '<query>'                 # let akm select the best match`;
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
    // Issue #856: which stage of the progressive AND->OR lexical ladder
    // produced this hit ("exact" | "prefix" | "relaxed").
    if (typeof hit.matchStage === "string" && hit.matchStage) lines.push(`  matchStage: ${hit.matchStage}`);
    // Surface optional hit-level warnings (v1 spec §4.2).
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
    const preferredHit = hits.find((h) => h.type === "skill" || h.type === "command" || h.type === "agent") ?? hits[0]!;
    const topRef = typeof preferredHit.ref === "string" ? preferredHit.ref : null;
    const hasWorkflowHit = hits.some((h) => h.type === "workflow");
    if (topRef) {
      if (hasWorkflowHit) {
        const workflowRef = hits.find((h) => h.type === "workflow");
        const wfRef = workflowRef && typeof workflowRef.ref === "string" ? workflowRef.ref : topRef;
        lines.push(`Next: akm show '${topRef}'  |  To execute a workflow: akm workflow run '${wfRef}'`);
        lines.push(
          "Inspect the workflow before running it; `workflow run` executes and verifies its steps automatically.",
        );
      } else {
        lines.push(`Next: akm show '${topRef}'`);
        lines.push(
          "After reading the asset: check whether a workflow applies before editing — if so, inspect it and use `akm workflow run`.",
        );
      }
    }
  }

  return lines.join("\n").trimEnd();
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
  let out = `Bundle initialized at ${r.bundleDir ?? "unknown"}`;
  // When --dir scaffolded a secondary bundle but the default was deliberately
  // left untouched, tell the user instead of silently repointing their default.
  if (r.defaultBundleUpdated === false && typeof r.previousBundleDir === "string" && r.previousBundleDir) {
    out += `\nYour default bundle is unchanged (${r.previousBundleDir}). Re-run with --set-default to make ${r.bundleDir} the default.`;
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
  const notices = Array.isArray(indexResult.notices) ? indexResult.notices : [];
  for (const notice of notices) {
    const severity = notice.severity === "info" ? "info" : "warning";
    const field = typeof notice.field === "string" ? ` field=${notice.field}` : "";
    out +=
      `\n  notice[${severity}] ${notice.code} adapter=${notice.adapter}${field}` +
      (notice.message ? `: ${notice.message}` : "");
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
  if (sources.length === 0) return "No sources configured. Use `akm bundle add` to add a source.";
  const lines: string[] = [];
  for (const src of sources) {
    const kind = typeof src.kind === "string" ? src.kind : "unknown";
    const name = typeof src.name === "string" ? src.name : "unnamed";
    const ver = typeof src.version === "string" ? ` v${src.version}` : "";
    const prov = typeof src.provider === "string" ? ` (${src.provider})` : "";
    const flags: string[] = [];
    if (src.default === true) flags.push("default");
    if (src.writable === true) flags.push("writable");
    const flagText = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
    lines.push(`[${kind}] ${name}${ver}${prov}${flagText}`);
  }
  lines.push("");
  lines.push("To search: akm search '<query>'  |  To view an asset: akm show <ref>");
  return lines.join("\n");
}

/** Render `akm models list`'s `{ rows }` as a column-aligned table (#946). */
export function formatModelsListPlain(r: Record<string, unknown>): string {
  const rows = Array.isArray(r.rows) ? (r.rows as Record<string, unknown>[]) : [];
  if (rows.length === 0) return "No model aliases configured.";
  const headers = ["ALIAS", "COLUMN", "MODEL", "SOURCE", "VIA", "ENGINE"] as const;
  const cells: string[][] = rows.map((row) => [
    String(row.alias ?? "?"),
    String(row.column ?? "?"),
    String(row.model ?? "?"),
    String(row.source ?? "?"),
    String(row.via ?? "?"),
    row.engine !== undefined ? String(row.engine) : "-",
  ]);
  const widths = headers.map((header, i) => {
    let width = header.length;
    for (const cols of cells) {
      const cell = cols[i];
      if (cell !== undefined && cell.length > width) width = cell.length;
    }
    return width;
  });
  const renderRow = (cols: readonly string[]): string =>
    cols
      .map((cell, i) => cell.padEnd(widths[i] ?? cell.length))
      .join("  ")
      .trimEnd();
  return [renderRow(headers), ...cells.map(renderRow)].join("\n");
}

/** Render a single `SourceEntry` — `akm bundle show <name>`'s detail view of one `list` row. */
export function formatBundleShowPlain(r: Record<string, unknown>): string {
  const name = typeof r.name === "string" ? r.name : "unknown";
  const kind = typeof r.kind === "string" ? r.kind : "unknown";
  const lines = [`${name} [${kind}]`];
  if (r.default === true) lines.push("  default: true");
  if (r.writable === true) lines.push("  writable: true");
  if (typeof r.version === "string") lines.push(`  version: ${r.version}`);
  if (typeof r.provider === "string") lines.push(`  provider: ${r.provider}`);
  if (typeof r.path === "string") lines.push(`  path: ${r.path}`);
  if (typeof r.ref === "string") lines.push(`  ref: ${r.ref}`);
  if (typeof r.registryId === "string") lines.push(`  registryId: ${r.registryId}`);
  lines.push(`  items: ${typeof r.itemCount === "number" ? r.itemCount : 0}`);
  const byType = r.byType as Record<string, number> | undefined;
  if (byType && Object.keys(byType).length > 0) {
    lines.push(
      `  byType: ${Object.entries(byType)
        .map(([t, n]) => `${t}=${n}`)
        .join(", ")}`,
    );
  }
  const status = r.status as { exists?: boolean } | undefined;
  if (status?.exists === false) lines.push("  status: MISSING on disk");
  return lines.join("\n");
}

export function formatAddPlain(r: Record<string, unknown>): string {
  // `akm bundle add <ref>` (source-add.ts `AddResponse`) and `akm bundle add
  // <target> --provider <kind>` (source-manage.ts `SourceAddResult`) are
  // genuinely different operations that happen to share the "add" command
  // name: the former eagerly fetches and indexes content, the latter only
  // writes a desired locator to config — nothing is synced until a later
  // `akm bundle update`. Force-fitting the declarative shape's `added`/`entry`/`message`
  // fields into the "Installed <ref> (N scanned...)" wording produced
  // "Installed undefined (0 directories scanned...)" (R-014) because it
  // implied a sync that never happened. `AddResponse` always carries an
  // `index` block (even when zero entries were scanned); `SourceAddResult`
  // never does — that is the reliable shape discriminator used below to
  // render each honestly instead of unifying them.
  if (!("index" in r)) return formatDeclarativeAddPlain(r);
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

/** Render a `SourceAddResult` (declarative `--provider` add) — see {@link formatAddPlain}. */
function formatDeclarativeAddPlain(r: Record<string, unknown>): string {
  if (r.added !== true) {
    return typeof r.message === "string" ? r.message : "add: no changes";
  }
  const entry = r.entry as Record<string, unknown> | undefined;
  const kind = typeof entry?.type === "string" ? entry.type : "source";
  const name =
    (typeof entry?.name === "string" && entry.name) ||
    (typeof entry?.path === "string" && entry.path) ||
    (typeof entry?.url === "string" && entry.url) ||
    "source";
  // A filesystem bundle reflects files already on disk — nothing to fetch,
  // just index it. Every other declarative kind (git/website/npm) is a
  // locator only; its content is not materialized until `akm bundle update`.
  if (kind === "filesystem") {
    return `Added ${name} (filesystem) — run \`akm index\` to index it.`;
  }
  return `Added ${name} (${kind}) — not yet synced; run \`akm bundle update ${name}\` to fetch it.`;
}

export function formatRemovePlain(r: Record<string, unknown>): string {
  const target = r.target ?? r.ref ?? "";
  const ok = r.ok !== false ? "OK" : "FAILED";
  return `remove: ${target} ${ok}`;
}

export function formatUpdatePlain(r: Record<string, unknown>): string {
  // R-015: `processed` alone conflated three cases into one empty array —
  // a true no-op (--all with nothing configured), a source this call flatly
  // never looked at (a plain source under --all), and a plain git/website
  // source that WAS just synced successfully but has no `UpdateResultItem`
  // shape to report (no version/lock to diff). All three rendered as the
  // same misleading "nothing to update". `plainSynced` and `skipped` (see
  // sources/types.ts) cover the other two so this can report accurately.
  const processed = r.processed as Array<Record<string, unknown>> | undefined;
  const plainSynced = r.plainSynced as Array<Record<string, unknown>> | undefined;
  const skipped = r.skipped as Array<Record<string, unknown>> | undefined;
  const lines: string[] = [];
  for (const item of processed ?? []) {
    const changed = item.changed as Record<string, unknown> | undefined;
    const installed = item.installed as Record<string, unknown> | undefined;
    const previous = item.previous as Record<string, unknown> | undefined;
    if (changed?.any) {
      const prev = previous?.resolvedVersion ?? "unknown";
      const next = installed?.resolvedVersion ?? "unknown";
      lines.push(`update: ${item.id} v${prev} → v${next}`);
    } else {
      lines.push(`update: ${item.id} (unchanged)`);
    }
  }
  for (const item of plainSynced ?? []) {
    lines.push(
      item.kind === "filesystem"
        ? `update: ${item.id} reconciled (filesystem)`
        : `update: ${item.id} synced (${item.kind})`,
    );
  }
  for (const item of skipped ?? []) {
    lines.push(`update: ${item.id} skipped — ${item.reason}`);
  }
  return lines.length > 0 ? lines.join("\n") : `update: nothing to update`;
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
