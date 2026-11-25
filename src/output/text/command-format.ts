// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Plain-text renderers for the remaining leaf `akm` commands: info/config/
 * feedback/remember/import/save/enable/disable, registry, env, wiki,
 * events/history and search/curate. The stash-lifecycle verbs live in
 * `lifecycle-format.ts`.
 *
 * Unlike `show`/`workflow`/`proposal` (each a stateful,
 * multi-branch renderer with its own module), these are flat
 * field-extraction formatters with no shared state.
 */

import { formatRegistryUrl } from "../../core/registry-url";
import type { DetailLevel } from "../context";
import { formatClonePlain } from "./lifecycle-format";
import { renderTargetsTable } from "./targets-table";

/** Render the current `InfoResponse` shape. */
export function formatInfoPlain(r: Record<string, unknown>): string {
  const lines: string[] = [];
  if (r.version) lines.push(`version: ${String(r.version)}`);
  // Only present in infoCommand's own last-resort fallback (stash-cli.ts),
  // when assembleInfo() itself threw — every field below it belongs to the
  // normal shape and is absent there.
  if (typeof r.error === "string") lines.push(`error: ${r.error}`);
  if (r.bundleDir) lines.push(`bundleDir: ${String(r.bundleDir)}`);
  if (r.defaultBundle !== undefined) {
    lines.push(`defaultBundle: ${r.defaultBundle === null ? "(none)" : String(r.defaultBundle)}`);
  }
  if (typeof r.configError === "string") lines.push(`configError: ${r.configError}`);
  if (typeof r.bundleDirError === "string") lines.push(`bundleDirError: ${r.bundleDirError}`);
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
  if (Array.isArray(r.connectionsAndHarnesses)) lines.push(...renderTargetsTable(r.connectionsAndHarnesses));
  const learning = r.learning as Record<string, unknown> | undefined;
  if (learning) {
    lines.push(
      `learning: ${learning.on ? "on" : "off"}${typeof learning.harness === "string" ? ` (harness: ${learning.harness})` : ""}, improve task ${learning.scheduled ? "scheduled" : "not scheduled"}`,
    );
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

export function formatConfigPlain(r: unknown): string {
  // `config get` of a scalar key returns the bare value: print it alone, and nothing for an unset key.
  if (r === null || r === undefined) return "";
  if (typeof r !== "object") return String(r);
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
  walk(r as Record<string, unknown>, "");
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
  if (r.destination !== undefined) return formatClonePlain(r).replace(/^Cloned/, "Imported");
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

export function formatEnvListPlain(r: Record<string, unknown>): string {
  // Multi-env listing: { envs: [{ ref, path, keys }, ...] }
  const envs = Array.isArray(r.envs) ? (r.envs as Array<Record<string, unknown>>) : [];
  if (envs.length === 0) {
    return "No env files. Create one with `akm env create env/<name>`, then edit the .env file directly.";
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
    if (hit.installRef) lines.push(`  installRef: ${String(hit.installRef)}`);
    if (hit.run) lines.push(`  run: ${String(hit.run)}`);
    if (Array.isArray(hit.tags) && hit.tags.length > 0) lines.push(`  tags: ${hit.tags.join(", ")}`);
    // Optional quality marker (e.g. "curated" / "proposed").
    if (typeof hit.quality === "string" && hit.quality) lines.push(`  quality: ${hit.quality}`);
    if (typeof hit.observed === "string") lines.push(`  observed: ${hit.observed}`);
    if (typeof hit.updated === "string") lines.push(`  updated: ${hit.updated}`);
    // Surface optional hit-level warnings.
    if (Array.isArray(hit.warnings) && hit.warnings.length > 0) {
      lines.push(`  warnings: ${(hit.warnings as string[]).join("; ")}`);
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

  // When stash hits exist, tell the agent the next required step so it
  // doesn't skip `akm show` and write from training memory instead.
  if (hits.length >= 1) {
    // Prefer skill/command/agent type hits for the "Next:" ref — knowledge docs are
    // supplementary context, not the authoritative schema agents should load first.
    const preferredHit = hits.find((h) => h.type === "skill" || h.type === "command" || h.type === "agent") ?? hits[0]!;
    const topRef = typeof preferredHit.ref === "string" ? preferredHit.ref : null;
    if (topRef) lines.push(`Next: akm show '${topRef}'`);
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
  lines.push("  1. Run `akm show <ref>` to read the best result above.");
  lines.push("  2. Run `akm feedback <ref> --positive` when the task succeeds.");
  lines.push("To search further: akm search '<query>'");

  return lines.join("\n");
}
