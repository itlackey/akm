#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { defineCommand, runMain } from "citty";
import { resolveStashDir } from "./common";
import { generateBashCompletions, installBashCompletions } from "./completions";
import type { RegistryConfigEntry } from "./config";
import { DEFAULT_CONFIG, getConfigPath, loadConfig, loadUserConfig, saveConfig } from "./config";
import { getConfigValue, listConfig, setConfigValue, unsetConfigValue } from "./config-cli";
import { closeDatabase, openDatabase } from "./db";
import { ConfigError, NotFoundError, UsageError } from "./errors";
import { akmIndex, type IndexResponse } from "./indexer";
import { assembleInfo } from "./info";
import { akmInit } from "./init";
import { formatInstallAuditSummary } from "./install-audit";
import { akmListSources, akmRemove, akmUpdate } from "./installed-kits";
import { getCacheDir, getDbPath, getDefaultStashDir } from "./paths";
import { buildRegistryIndex, writeRegistryIndex } from "./registry-build-index";
import { searchRegistry } from "./registry-search";
import { checkForUpdate, performUpgrade } from "./self-update";
import { akmAdd } from "./stash-add";
import { akmClone } from "./stash-clone";
import { akmSearch, parseSearchSource } from "./stash-search";
import { akmShowUnified } from "./stash-show";
import { addStash } from "./stash-source-manage";
import type {
  KnowledgeView,
  RegistrySearchResultHit,
  SearchResponse,
  ShowDetailLevel,
  ShowResponse,
  SourceKind,
  StashSearchHit,
} from "./stash-types";
import { insertUsageEvent } from "./usage-events";
import { pkgVersion } from "./version";
import { setQuiet, warn } from "./warn";

type OutputFormat = "json" | "yaml" | "text" | "jsonl";
type DetailLevel = "brief" | "normal" | "full" | "summary";

interface OutputMode {
  format: OutputFormat;
  detail: DetailLevel;
  forAgent: boolean;
}

const OUTPUT_FORMATS: OutputFormat[] = ["json", "yaml", "text", "jsonl"];
const DETAIL_LEVELS: DetailLevel[] = ["brief", "normal", "full", "summary"];
const NORMAL_DESCRIPTION_LIMIT = 250;
const CONTEXT_HUB_ALIAS_REF = "context-hub";
const CONTEXT_HUB_ALIAS_URL = "https://github.com/andrewyng/context-hub";
const SKILLS_SH_NAME = "skills.sh";
const SKILLS_SH_URL = "https://skills.sh";
const SKILLS_SH_PROVIDER = "skills-sh";

import { stringify as yamlStringify } from "yaml";

function parseOutputFormat(value: string | undefined): OutputFormat | undefined {
  if (!value) return undefined;
  if ((OUTPUT_FORMATS as string[]).includes(value)) return value as OutputFormat;
  throw new UsageError(`Invalid value for --format: ${value}. Expected one of: ${OUTPUT_FORMATS.join("|")}`);
}

function parseDetailLevel(value: string | undefined): DetailLevel | undefined {
  if (!value) return undefined;
  if ((DETAIL_LEVELS as string[]).includes(value)) return value as DetailLevel;
  throw new UsageError(`Invalid value for --detail: ${value}. Expected one of: ${DETAIL_LEVELS.join("|")}`);
}

function parseFlagValue(flag: string): string | undefined {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === flag) return process.argv[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

// Uses process.argv directly because the global output() function (called by all
// commands) needs this flag but doesn't have access to citty's parsed args.
function hasBooleanFlag(flag: string): boolean {
  return process.argv.some((arg) => arg === flag || arg === `${flag}=true`);
}

function resolveOutputMode(): OutputMode {
  const config = loadConfig();
  const format = parseOutputFormat(parseFlagValue("--format")) ?? config.output?.format ?? "json";
  const detail = parseDetailLevel(parseFlagValue("--detail")) ?? config.output?.detail ?? "brief";
  const forAgent = hasBooleanFlag("--for-agent");
  return { format, detail, forAgent };
}

function output(command: string, result: unknown): void {
  const mode = resolveOutputMode();
  const shaped = shapeForCommand(command, result, mode.detail, mode.forAgent);

  if (mode.format === "jsonl") {
    outputJsonl(command, shaped);
    return;
  }

  switch (mode.format) {
    case "json":
      console.log(JSON.stringify(shaped, null, 2));
      return;
    case "yaml":
      console.log(yamlStringify(shaped));
      return;
    case "text": {
      const plain = formatPlain(command, shaped, mode.detail);
      console.log(plain ?? JSON.stringify(shaped, null, 2));
      return;
    }
  }
}

function outputJsonl(command: string, shaped: unknown): void {
  if (command === "search" || command === "registry-search") {
    const r = shaped as Record<string, unknown>;
    const hits = Array.isArray(r.hits) ? (r.hits as Record<string, unknown>[]) : [];
    for (const hit of hits) {
      console.log(JSON.stringify(hit));
    }
    const registryHits = Array.isArray(r.registryHits) ? (r.registryHits as Record<string, unknown>[]) : [];
    for (const hit of registryHits) {
      console.log(JSON.stringify(hit));
    }
    return;
  }
  // For non-search commands, output the whole object as a single JSONL line
  console.log(JSON.stringify(shaped));
}

function shapeForCommand(command: string, result: unknown, detail: DetailLevel, forAgent = false): unknown {
  switch (command) {
    case "search":
      return shapeSearchOutput(result as Record<string, unknown>, detail, forAgent);
    case "registry-search":
      return shapeRegistrySearchOutput(result as Record<string, unknown>, detail);
    case "show":
      return shapeShowOutput(result as Record<string, unknown>, detail, forAgent);
    default:
      return result;
  }
}

function shapeSearchOutput(
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

function shapeRegistrySearchOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const hits = Array.isArray(result.hits) ? (result.hits as Record<string, unknown>[]) : [];
  const assetHits = Array.isArray(result.assetHits) ? (result.assetHits as Record<string, unknown>[]) : [];

  // Shape kit hits as registry type
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

function shapeAssetHit(hit: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  if (detail === "brief") return pickFields(hit, ["assetName", "assetType", "action", "estimatedTokens"]);
  if (detail === "normal") {
    return capDescription(
      pickFields(hit, ["assetName", "assetType", "description", "kit", "action", "estimatedTokens"]),
      NORMAL_DESCRIPTION_LIMIT,
    );
  }
  return hit;
}

function shapeSearchHit(hit: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  if (hit.type === "registry") {
    if (detail === "brief") return pickFields(hit, ["name", "action"]);
    if (detail === "normal") {
      return capDescription(pickFields(hit, ["name", "description", "action", "curated"]), NORMAL_DESCRIPTION_LIMIT);
    }
    return hit;
  }

  // Stash hit (local or remote)
  if (detail === "brief") return pickFields(hit, ["type", "name", "action", "estimatedTokens"]);
  if (detail === "normal") {
    return capDescription(
      pickFields(hit, ["type", "name", "description", "action", "score", "estimatedTokens"]),
      NORMAL_DESCRIPTION_LIMIT,
    );
  }
  return hit;
}

/** Agent-optimized search hit: only fields an LLM agent needs to decide and act */
function shapeSearchHitForAgent(hit: Record<string, unknown>): Record<string, unknown> {
  const picked = pickFields(hit, ["name", "ref", "type", "description", "action", "score", "estimatedTokens"]);
  return capDescription(picked, NORMAL_DESCRIPTION_LIMIT);
}

function capDescription(hit: Record<string, unknown>, limit: number): Record<string, unknown> {
  if (typeof hit.description !== "string") return hit;
  return { ...hit, description: truncateDescription(hit.description, limit) };
}

function truncateDescription(description: string, limit: number): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;

  const truncated = normalized.slice(0, limit - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  const safe = lastSpace >= Math.floor(limit * 0.6) ? truncated.slice(0, lastSpace) : truncated;
  return `${safe.trimEnd()}...`;
}

function shapeShowOutput(
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
    ]);
  }
  if (detail === "summary") {
    return pickFields(result, ["type", "name", "description", "tags", "parameters", "action", "run", "origin"]);
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
    "run",
    "setup",
    "cwd",
  ]);

  if (detail !== "full") {
    return base;
  }

  return {
    schemaVersion: 1,
    ...base,
    ...pickFields(result, ["path", "editable", "editHint"]),
  };
}

function pickFields(source: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (source[field] !== undefined) {
      result[field] = source[field];
    }
  }
  return result;
}

/**
 * Return a plain-text string for commands that are better as short messages,
 * or null to fall through to YAML output.
 */
function formatPlain(command: string, result: unknown, detail: DetailLevel): string | null {
  const r = result as Record<string, unknown>;

  switch (command) {
    case "init": {
      let out = `Stash initialized at ${r.stashDir ?? "unknown"}`;
      if (r.configPath) out += `\nConfig saved to ${r.configPath}`;
      return out;
    }
    case "index": {
      const indexResult = result as Partial<IndexResponse>;
      let out = `Indexed ${indexResult.totalEntries ?? 0} entries from ${indexResult.directoriesScanned ?? 0} directories (mode: ${indexResult.mode ?? "unknown"})`;
      const verification = indexResult.verification;
      if (verification?.ok === false && verification.message) {
        out += `\nVerification: ${String(verification.message)}`;
      }
      return out;
    }
    case "show": {
      const lines: string[] = [];
      if (r.type || r.name) {
        lines.push(`# ${String(r.type ?? "asset")}: ${String(r.name ?? "unknown")}`);
      }
      if (r.origin !== undefined) lines.push(`# origin: ${String(r.origin)}`);
      if (r.action) lines.push(`# ${String(r.action)}`);
      if (r.description) lines.push(`description: ${String(r.description)}`);
      if (r.agent) lines.push(`agent: ${String(r.agent)}`);
      if (Array.isArray(r.parameters) && r.parameters.length > 0) lines.push(`parameters: ${r.parameters.join(", ")}`);
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
      const payloads = [r.content, r.template, r.prompt].filter((value) => value != null).map(String);
      if (payloads.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push(...payloads);
      }
      return lines.length > 0 ? lines.join("\n") : null;
    }
    case "search": {
      return formatSearchPlain(r, detail);
    }
    case "curate": {
      return formatCuratePlain(r, detail);
    }
    case "list": {
      const sources = Array.isArray(r.sources) ? (r.sources as Record<string, unknown>[]) : [];
      if (sources.length === 0) return "No sources configured. Use `akm add` to add a source.";
      const lines: string[] = [];
      for (const src of sources) {
        const kind = typeof src.kind === "string" ? src.kind : "unknown";
        const name = typeof src.name === "string" ? src.name : "unnamed";
        const ver = typeof src.version === "string" ? ` v${src.version}` : "";
        const prov = typeof src.provider === "string" ? ` (${src.provider})` : "";
        lines.push(`[${kind}] ${name}${ver}${prov}`);
      }
      return lines.join("\n");
    }
    case "add": {
      const index = r.index as Record<string, unknown> | undefined;
      const scanned = index?.directoriesScanned ?? 0;
      const total = index?.totalEntries ?? 0;
      const lines = [`Installed ${r.ref} (${scanned} directories scanned, ${total} total assets indexed)`];
      const installed = r.installed as Record<string, unknown> | undefined;
      const audit = installed?.audit;
      if (audit && typeof audit === "object") {
        lines.push(formatInstallAuditSummary(audit as Parameters<typeof formatInstallAuditSummary>[0]));
      }
      return lines.join("\n");
    }
    case "remove": {
      const target = r.target ?? r.ref ?? "";
      const ok = r.ok !== false ? "OK" : "FAILED";
      return `remove: ${target} ${ok}`;
    }
    case "update": {
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
    case "upgrade": {
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
    case "clone": {
      const dst = (r.destination as Record<string, unknown>)?.path ?? "unknown";
      const remote = r.remoteFetched ? " (fetched from remote)" : "";
      const over = r.overwritten ? " (overwritten)" : "";
      return `Cloned${remote} → ${dst}${over}`;
    }
    default:
      return null; // fall through to YAML
  }
}

function formatSearchPlain(r: Record<string, unknown>, detail: DetailLevel): string {
  const hits = (r.hits as Record<string, unknown>[]) ?? [];
  const registryHits = (r.registryHits as Record<string, unknown>[]) ?? [];
  const allHits = [...hits, ...registryHits];

  if (allHits.length === 0) {
    return r.tip ? String(r.tip) : "No results found.";
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
    if (hit.size) lines.push(`  size: ${String(hit.size)}`);
    if (hit.action) lines.push(`  action: ${String(hit.action)}`);
    if (hit.run) lines.push(`  run: ${String(hit.run)}`);
    if (Array.isArray(hit.tags) && hit.tags.length > 0) lines.push(`  tags: ${hit.tags.join(", ")}`);
    if (hit.curated !== undefined) lines.push(`  curated: ${String(hit.curated)}`);

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

  return lines.join("\n").trimEnd();
}

function formatCuratePlain(r: Record<string, unknown>, detail: DetailLevel): string {
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

  return lines.join("\n");
}

type CuratedStashItem = {
  source: "stash";
  type: string;
  name: string;
  ref: string;
  description?: string;
  preview?: string;
  parameters?: string[];
  run?: string;
  followUp: string;
  reason: string;
  score?: number;
};

type CuratedRegistryItem = {
  source: "registry";
  type: "registry";
  name: string;
  id: string;
  description?: string;
  followUp: string;
  reason: string;
  score?: number;
};

type CuratedItem = CuratedStashItem | CuratedRegistryItem;

const CURATE_FALLBACK_FILTER_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "how",
  "i",
  "in",
  "of",
  "or",
  "the",
  "to",
  "with",
]);
const CURATED_TYPE_FALLBACK_ORDER = ["skill", "command", "script", "knowledge", "agent", "memory"];
const CURATED_TYPE_FALLBACK_INDEX = new Map(CURATED_TYPE_FALLBACK_ORDER.map((type, index) => [type, index]));
const MIN_CURATE_FALLBACK_TOKEN_LENGTH = 3;
const MAX_CURATE_FALLBACK_KEYWORDS = 6;
const CURATE_SEARCH_LIMIT_MULTIPLIER = 4;
const MIN_CURATE_SEARCH_LIMIT = 12;

async function curateSearchResults(
  query: string,
  result: SearchResponse,
  limit: number,
  selectedType?: string,
): Promise<{
  query: string;
  summary: string;
  items: CuratedItem[];
  warnings?: string[];
  tip?: string;
}> {
  const stashHits = result.hits.filter((hit): hit is StashSearchHit => hit.type !== "registry");
  const registryHits = result.registryHits ?? [];

  let selectedStashHits: StashSearchHit[];
  if (selectedType && selectedType !== "any") {
    selectedStashHits = stashHits.slice(0, limit);
  } else {
    const bestByType = new Map<string, StashSearchHit>();
    for (const hit of stashHits) {
      if (!bestByType.has(hit.type)) bestByType.set(hit.type, hit);
    }
    const orderedTypes = orderCuratedTypes(query, Array.from(bestByType.keys()));
    selectedStashHits = orderedTypes
      .map((type) => bestByType.get(type))
      .filter((hit): hit is StashSearchHit => Boolean(hit));
  }

  const selectedRegistryHits =
    selectedStashHits.length >= limit ? [] : registryHits.slice(0, Math.min(2, limit - selectedStashHits.length));

  const items = [
    ...(await Promise.all(selectedStashHits.slice(0, limit).map((hit) => enrichCuratedStashHit(query, hit)))),
    ...selectedRegistryHits.map((hit) => buildCuratedRegistryItem(query, hit)),
  ].slice(0, limit);

  return {
    query,
    summary: buildCurateSummary(query, items),
    items,
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    ...(result.tip ? { tip: result.tip } : {}),
  };
}

function orderCuratedTypes(query: string, types: string[]): string[] {
  const lower = query.toLowerCase();
  const boosts = new Map<string, number>();
  const addBoost = (type: string, amount: number) => boosts.set(type, (boosts.get(type) ?? 0) + amount);

  if (/(run|script|bash|shell|cli|execute|automation|deploy|build|test|lint)/.test(lower)) {
    addBoost("script", 6);
    addBoost("command", 4);
  }
  if (/(guide|docs?|readme|reference|how|explain|learn|why)/.test(lower)) {
    addBoost("knowledge", 6);
    addBoost("skill", 4);
  }
  if (/(agent|assistant|planner|review|analy[sz]e|architect|prompt)/.test(lower)) {
    addBoost("agent", 6);
    addBoost("skill", 3);
  }
  if (/(config|template|release|generate|command)/.test(lower)) {
    addBoost("command", 5);
  }
  if (/(memory|context|recall|remember)/.test(lower)) {
    addBoost("memory", 6);
  }

  return [...types].sort((a, b) => {
    const boostDiff = (boosts.get(b) ?? 0) - (boosts.get(a) ?? 0);
    if (boostDiff !== 0) return boostDiff;
    return (
      (CURATED_TYPE_FALLBACK_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (CURATED_TYPE_FALLBACK_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

async function enrichCuratedStashHit(query: string, hit: StashSearchHit): Promise<CuratedStashItem> {
  let shown: ShowResponse | undefined;
  try {
    shown = await akmShowUnified({ ref: hit.ref });
  } catch {
    shown = undefined;
  }

  const description = shown?.description ?? hit.description;
  const preview = buildCuratedPreview(shown, hit);
  return {
    source: "stash",
    type: shown?.type ?? hit.type,
    name: shown?.name ?? hit.name,
    ref: hit.ref,
    ...(description ? { description } : {}),
    ...(preview ? { preview } : {}),
    ...(shown?.parameters?.length ? { parameters: shown.parameters } : {}),
    ...(shown?.run ? { run: shown.run } : {}),
    followUp: `akm show ${hit.ref}`,
    reason: buildCuratedReason(query, shown?.type ?? hit.type),
    ...(hit.score !== undefined ? { score: hit.score } : {}),
  };
}

function buildCuratedRegistryItem(query: string, hit: RegistrySearchResultHit): CuratedRegistryItem {
  return {
    source: "registry",
    type: "registry",
    name: hit.name,
    id: hit.id,
    ...(hit.description ? { description: hit.description } : {}),
    followUp: hit.action ?? `akm add ${hit.id}`,
    reason: `Useful external source to explore for ${query}.`,
    ...(hit.score !== undefined ? { score: hit.score } : {}),
  };
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

function buildCuratedPreview(shown: ShowResponse | undefined, hit: StashSearchHit): string | undefined {
  if (shown?.run) return truncateDescription(`run ${shown.run}`, 160);
  const payload = firstNonEmpty([shown?.template, shown?.prompt, shown?.content, hit.description])
    ?.replace(/\s+/g, " ")
    .trim();
  return payload ? truncateDescription(payload, 160) : undefined;
}

function buildCuratedReason(query: string, type: string): string {
  switch (type) {
    case "script":
      return `Best runnable script match for "${query}".`;
    case "command":
      return `Best reusable command/template match for "${query}".`;
    case "knowledge":
      return `Best reference document match for "${query}".`;
    case "skill":
      return `Best instructions/workflow match for "${query}".`;
    case "agent":
      return `Best specialized agent prompt match for "${query}".`;
    case "memory":
      return `Best saved context match for "${query}".`;
    default:
      return `Best ${type} match for "${query}".`;
  }
}

function buildCurateSummary(query: string, items: CuratedItem[]): string {
  if (items.length === 0) {
    return `No curated assets were selected for "${query}".`;
  }
  const labels = items.map((item) => `${item.type}:${item.name}`);
  return `Selected ${items.length} high-signal result${items.length === 1 ? "" : "s"}: ${labels.join(", ")}.`;
}

function hasSearchResults(result: SearchResponse): boolean {
  return result.hits.length > 0 || (result.registryHits?.length ?? 0) > 0;
}

/**
 * Extract a small set of fallback keywords when a prompt-style curate query
 * returns no hits as a whole phrase.
 *
 * We keep up to MAX_CURATE_FALLBACK_KEYWORDS distinct keywords and drop short
 * or common filler words so follow-up searches stay inexpensive while focusing
 * on higher-signal terms.
 */
function deriveCurateFallbackQueries(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .map((token) => token.trim())
        // Keep longer tokens so fallback stays focused on higher-signal terms
        // and avoids broad one- and two-letter matches that overwhelm curation.
        .filter(
          (token) => token.length >= MIN_CURATE_FALLBACK_TOKEN_LENGTH && !CURATE_FALLBACK_FILTER_WORDS.has(token),
        ),
    ),
  ).slice(0, MAX_CURATE_FALLBACK_KEYWORDS);
}

function mergeCurateSearchResponses(base: SearchResponse, extras: SearchResponse[]): SearchResponse {
  const hitsByRef = new Map<string, StashSearchHit>();
  for (const hit of base.hits.filter((entry): entry is StashSearchHit => entry.type !== "registry")) {
    hitsByRef.set(hit.ref, hit);
  }
  for (const result of extras) {
    for (const hit of result.hits.filter((entry): entry is StashSearchHit => entry.type !== "registry")) {
      const existing = hitsByRef.get(hit.ref);
      if (!existing || (hit.score ?? 0) > (existing.score ?? 0)) {
        hitsByRef.set(hit.ref, hit);
      }
    }
  }

  const registryById = new Map<string, RegistrySearchResultHit>();
  for (const hit of base.registryHits ?? []) {
    registryById.set(hit.id, hit);
  }
  for (const result of extras) {
    for (const hit of result.registryHits ?? []) {
      const existing = registryById.get(hit.id);
      if (!existing || (hit.score ?? 0) > (existing.score ?? 0)) {
        registryById.set(hit.id, hit);
      }
    }
  }

  const warnings = Array.from(
    new Set([...(base.warnings ?? []), ...extras.flatMap((result) => result.warnings ?? [])]),
  );
  const mergedHits = [...hitsByRef.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const mergedRegistryHits = [...registryById.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  return {
    ...base,
    hits: mergedHits,
    ...(mergedRegistryHits.length > 0 ? { registryHits: mergedRegistryHits } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(mergedHits.length > 0 || mergedRegistryHits.length > 0 ? { tip: undefined } : {}),
  };
}

async function searchForCuration(input: {
  query: string;
  type?: string;
  limit: number;
  source: ReturnType<typeof parseSearchSource>;
}): Promise<SearchResponse> {
  const initial = await akmSearch(input);
  if (hasSearchResults(initial)) return initial;

  const fallbackQueries = deriveCurateFallbackQueries(input.query);
  if (fallbackQueries.length <= 1) return initial;

  const fallbackResults = await Promise.all(
    fallbackQueries.map((token) =>
      akmSearch({
        query: token,
        type: input.type,
        limit: input.limit,
        source: input.source,
      }),
    ),
  );
  return mergeCurateSearchResponses(initial, fallbackResults);
}

/**
 * Module Naming:
 * - stash-*          : Asset operations (search, show, add, clone)
 * - stash-provider-* : Runtime data source providers (filesystem, openviking)
 * - registry-*       : Discovery from remote registries (npm, GitHub)
 * - installed-kits   : Unified source operations (list, remove, update)
 */

const setupCommand = defineCommand({
  meta: {
    name: "setup",
    description: "Interactive configuration wizard for embeddings, LLM, registries, and stash sources",
  },
  async run() {
    await runWithJsonErrors(async () => {
      const { runSetupWizard } = await import("./setup");
      await runSetupWizard();
    });
  },
});

const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize akm's working stash directory and persist stashDir in config",
  },
  args: {
    dir: { type: "string", description: "Custom stash directory path (default: ~/akm)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await akmInit({ dir: args.dir });
      output("init", result);
    });
  },
});

const indexCommand = defineCommand({
  meta: { name: "index", description: "Build search index (incremental by default; --full forces full reindex)" },
  args: {
    full: { type: "boolean", description: "Force full reindex", default: false },
    verbose: { type: "boolean", description: "Print indexing summary and phase progress to stderr", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await akmIndex({
        full: args.full,
        onProgress: args.verbose ? ({ message }) => console.error(`[index] ${message}`) : undefined,
      });
      output("index", result);
    });
  },
});

const infoCommand = defineCommand({
  meta: { name: "info", description: "Show system capabilities, configuration, and index stats as JSON" },
  run() {
    return runWithJsonErrors(() => {
      const result = assembleInfo();
      output("info", result);
    });
  },
});

const searchCommand = defineCommand({
  meta: { name: "search", description: "Search the stash" },
  args: {
    query: { type: "positional", description: "Search query (omit to list all assets)", required: false, default: "" },
    type: {
      type: "string",
      description: "Asset type filter (e.g. skill, command, agent, knowledge, script, memory, or any).",
    },
    limit: { type: "string", description: "Maximum number of results" },
    source: { type: "string", description: "Search source (stash|registry|both)", default: "stash" },
    format: { type: "string", description: "Output format (json|jsonl|text|yaml)" },
    detail: { type: "string", description: "Detail level (brief|normal|full|summary)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const type = args.type as string | undefined;
      const limitRaw = args.limit ? parseInt(args.limit, 10) : undefined;
      if (limitRaw !== undefined && Number.isNaN(limitRaw)) {
        throw new UsageError(`Invalid --limit value: "${args.limit}". Must be a positive integer.`);
      }
      const limit = limitRaw;
      const source = parseSearchSource(args.source);
      const result = await akmSearch({ query: args.query, type, limit, source });
      output("search", result);
    });
  },
});

const curateCommand = defineCommand({
  meta: { name: "curate", description: "Curate the best matching assets for a task or prompt" },
  args: {
    query: { type: "positional", description: "Task or prompt to curate assets for", required: true },
    type: {
      type: "string",
      description: "Asset type filter (e.g. skill, command, agent, knowledge, script, memory, or any).",
    },
    limit: { type: "string", description: "Maximum number of curated results", default: "4" },
    source: { type: "string", description: "Search source (stash|registry|both)", default: "stash" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const type = args.type as string | undefined;
      const limitRaw = args.limit ? parseInt(args.limit, 10) : undefined;
      if (limitRaw !== undefined && Number.isNaN(limitRaw)) {
        throw new UsageError(`Invalid --limit value: "${args.limit}". Must be a positive integer.`);
      }
      const limit = limitRaw && limitRaw > 0 ? limitRaw : 4;
      const source = parseSearchSource(args.source ?? "stash");
      const searchResult = await searchForCuration({
        query: args.query,
        type,
        // Search deeper than the final curated count so we can pick one strong
        // match per type and still have room for fallback retries.
        limit: Math.max(limit * CURATE_SEARCH_LIMIT_MULTIPLIER, MIN_CURATE_SEARCH_LIMIT),
        source,
      });
      const curated = await curateSearchResults(args.query, searchResult, limit, type);
      output("curate", curated);
    });
  },
});

const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Add a source (local directory, website, npm package, GitHub repo, git URL, or remote provider)",
  },
  args: {
    ref: {
      type: "positional",
      description: "Path, URL, or registry ref (website URL, npm package, owner/repo, git URL, or local directory)",
      required: true,
    },
    provider: { type: "string", description: "Provider type (e.g. openviking). Required for URL sources." },
    options: { type: "string", description: 'Provider options as JSON (e.g. \'{"apiKey":"key"}\').' },
    name: { type: "string", description: "Human-friendly name for the source" },
    "max-pages": { type: "string", description: "Maximum pages to crawl for website sources (default: 50)" },
    "max-depth": { type: "string", description: "Maximum crawl depth for website sources (default: 3)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const ref = args.ref.trim();

      // Context-hub convenience alias
      if (ref === CONTEXT_HUB_ALIAS_REF) {
        const result = addStash({
          target: CONTEXT_HUB_ALIAS_URL,
          providerType: "context-hub",
          name: "context-hub",
        });
        output("stash-add", result);
        return;
      }

      // URL with --provider → stash source (remote or git provider)
      if (args.provider) {
        if (shouldWarnOnPlainHttp(ref)) {
          warn(
            "Warning: source URL uses plain HTTP (not HTTPS). For security, prefer https:// to protect against eavesdropping and tampering.",
          );
        }
        let parsedOptions: Record<string, unknown> | undefined;
        if (args.options) {
          try {
            const parsed = JSON.parse(args.options);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
              throw new UsageError("--options must be a JSON object");
            }
            parsedOptions = parsed;
          } catch (err) {
            if (err instanceof UsageError) throw err;
            throw new UsageError("--options must be valid JSON");
          }
        }
        const result = addStash({
          target: ref,
          name: args.name,
          providerType: args.provider,
          options: parsedOptions,
        });
        output("stash-add", result);
        return;
      }

      if (shouldWarnOnPlainHttp(ref)) {
        warn(
          "Warning: source URL uses plain HTTP (not HTTPS). For security, prefer https:// to protect against eavesdropping and tampering.",
        );
      }
      const websiteOptions: Record<string, unknown> = {};
      if (args["max-pages"]) websiteOptions.maxPages = args["max-pages"];
      if (args["max-depth"]) websiteOptions.maxDepth = args["max-depth"];

      const result = await akmAdd({
        ref,
        name: args.name,
        options: Object.keys(websiteOptions).length > 0 ? websiteOptions : undefined,
      });
      output("add", result);
    });
  },
});

const VALID_SOURCE_KINDS = new Set<SourceKind>(["local", "managed", "remote"]);

function parseKindFilter(raw: string | undefined): SourceKind[] | undefined {
  if (!raw) return undefined;
  const kinds = raw.split(",").map((s) => s.trim()) as SourceKind[];
  for (const k of kinds) {
    if (!VALID_SOURCE_KINDS.has(k)) {
      throw new UsageError(`Invalid --kind value: "${k}". Expected one of: local, managed, remote`);
    }
  }
  return kinds;
}

function shouldWarnOnPlainHttp(ref: string): boolean {
  if (!ref.startsWith("http://")) return false;
  try {
    const hostname = new URL(ref).hostname.toLowerCase();
    return (
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "0.0.0.0" &&
      hostname !== "::1" &&
      hostname !== "[::1]" &&
      !hostname.endsWith(".localhost")
    );
  } catch {
    return true;
  }
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List all sources (local directories, managed packages, remote providers)" },
  args: {
    kind: { type: "string", description: "Filter by source kind (local, managed, remote). Comma-separated." },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const kind = parseKindFilter(args.kind);
      const result = await akmListSources({ kind });
      output("list", result);
    });
  },
});

const removeCommand = defineCommand({
  meta: { name: "remove", description: "Remove a source by id, ref, path, URL, or name" },
  args: {
    target: { type: "positional", description: "Source to remove (id, ref, path, URL, or name)", required: true },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await akmRemove({ target: args.target });
      output("remove", result);
    });
  },
});

const updateCommand = defineCommand({
  meta: { name: "update", description: "Update one or all managed sources" },
  args: {
    target: { type: "positional", description: "Source to update (id or ref)", required: false },
    all: { type: "boolean", description: "Update all installed entries", default: false },
    force: { type: "boolean", description: "Force fresh download even if version is unchanged", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await akmUpdate({ target: args.target, all: args.all, force: args.force });
      output("update", result);
    });
  },
});

const upgradeCommand = defineCommand({
  meta: { name: "upgrade", description: "Upgrade akm to the latest release" },
  args: {
    check: { type: "boolean", description: "Check for updates without installing", default: false },
    force: { type: "boolean", description: "Force upgrade even if on latest", default: false },
    skipChecksum: {
      type: "boolean",
      description: "Skip checksum verification (not recommended)",
      default: false,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const check = await checkForUpdate(pkgVersion);
      if (args.check) {
        output("upgrade", check);
        return;
      }
      const result = await performUpgrade(check, { force: args.force, skipChecksum: args.skipChecksum });
      output("upgrade", result);
    });
  },
});

const showCommand = defineCommand({
  meta: {
    name: "show",
    description:
      "Show a stash asset by ref (e.g. akm show knowledge:guide.md toc, akm show knowledge:guide.md section 'Auth')",
  },
  args: {
    ref: { type: "positional", description: "Asset ref (type:name)", required: true },
    format: { type: "string", description: "Output format (json|jsonl|text|yaml)" },
    detail: { type: "string", description: "Detail level (brief|normal|full|summary)" },
    akmView: { type: "string", description: "Internal positional knowledge view mode parser" },
    akmHeading: { type: "string", description: "Internal positional section heading parser" },
    akmStart: { type: "string", description: "Internal positional start-line parser" },
    akmEnd: { type: "string", description: "Internal positional end-line parser" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      let view: KnowledgeView | undefined;
      if (args.akmView) {
        switch (args.akmView) {
          case "section":
            view = { mode: "section", heading: args.akmHeading ?? "" };
            break;
          case "lines":
            view = {
              mode: "lines",
              start: Number(args.akmStart ?? "1"),
              end: args.akmEnd ? parseInt(args.akmEnd, 10) : Number.MAX_SAFE_INTEGER,
            };
            break;
          case "toc":
          case "frontmatter":
          case "full":
            view = { mode: args.akmView };
            break;
          default:
            throw new UsageError(
              `Unknown view mode: ${args.akmView}. Expected one of: full|toc|frontmatter|section|lines`,
            );
        }
      }
      // Map CLI detail level to ShowDetailLevel for the show function
      const cliDetail = resolveOutputMode().detail;
      const showDetail: ShowDetailLevel | undefined = cliDetail === "summary" ? "summary" : undefined;
      const result = await akmShowUnified({ ref: args.ref, view, detail: showDetail });
      output("show", result);
    });
  },
});

const configCommand = defineCommand({
  meta: { name: "config", description: "Show and manage configuration" },
  args: {
    list: { type: "boolean", description: "List current configuration", default: false },
  },
  subCommands: {
    path: defineCommand({
      meta: { name: "path", description: "Show paths to config, stash, cache, and index" },
      args: {
        all: { type: "boolean", description: "Show all paths (config, stash, cache, index)", default: false },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          const configPath = getConfigPath();
          if (args.all) {
            let stashDir: string;
            try {
              stashDir = resolveStashDir({ readOnly: true });
            } catch {
              stashDir = `${getDefaultStashDir()} (not initialized)`;
            }
            const cacheDir = getCacheDir();
            const result = {
              config: configPath,
              stash: stashDir,
              cache: cacheDir,
              index: getDbPath(),
            };
            output("config", result);
          } else {
            console.log(configPath);
          }
        });
      },
    }),
    list: defineCommand({
      meta: { name: "list", description: "List current configuration" },
      run() {
        return runWithJsonErrors(() => {
          output("config", listConfig(loadConfig()));
        });
      },
    }),
    get: defineCommand({
      meta: { name: "get", description: "Get a configuration value by key" },
      args: {
        key: { type: "positional", required: true, description: "Config key (for example: embedding, stashDir)" },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          output("config", getConfigValue(loadConfig(), args.key));
        });
      },
    }),
    set: defineCommand({
      meta: { name: "set", description: "Set a configuration value by key" },
      args: {
        key: { type: "positional", required: true, description: "Config key (for example: embedding, llm)" },
        value: { type: "positional", required: true, description: "Config value" },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          const updated = setConfigValue(loadUserConfig(), args.key, args.value);
          saveConfig(updated);
          output("config", listConfig(updated));
        });
      },
    }),
    unset: defineCommand({
      meta: { name: "unset", description: "Unset an optional configuration key or whole embedding/llm section" },
      args: {
        key: { type: "positional", required: true, description: "Config key to unset" },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          const updated = unsetConfigValue(loadUserConfig(), args.key);
          saveConfig(updated);
          output("config", listConfig(updated));
        });
      },
    }),
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      if (hasConfigSubcommand(args)) return;
      if (args.list) {
        output("config", listConfig(loadConfig()));
        return;
      }
      output("config", listConfig(loadConfig()));
    });
  },
});

const cloneCommand = defineCommand({
  meta: {
    name: "clone",
    description: "Clone an asset from any source into the working stash or a custom destination",
  },
  args: {
    ref: { type: "positional", description: "Asset ref (e.g. npm:@scope/pkg//script:deploy.sh)", required: true },
    name: { type: "string", description: "New name for the cloned asset" },
    force: { type: "boolean", description: "Overwrite if asset already exists in working stash", default: false },
    dest: { type: "string", description: "Destination directory (default: working stash)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await akmClone({
        sourceRef: args.ref,
        newName: args.name,
        force: args.force,
        dest: args.dest,
      });
      output("clone", result);
    });
  },
});

const registryCommand = defineCommand({
  meta: { name: "registry", description: "Manage kit registries" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List configured registries" },
      run() {
        return runWithJsonErrors(() => {
          const config = loadUserConfig();
          const registries = config.registries ?? DEFAULT_CONFIG.registries;
          output("registry-list", { registries });
        });
      },
    }),
    add: defineCommand({
      meta: { name: "add", description: "Add a registry by URL" },
      args: {
        url: { type: "positional", description: "Registry index URL", required: true },
        name: { type: "string", description: "Human-friendly name for the registry" },
        provider: { type: "string", description: "Provider type (e.g. static-index, skills-sh)" },
        options: { type: "string", description: 'Provider options as JSON (e.g. \'{"apiKey":"key"}\').' },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          if (!args.url.startsWith("http")) {
            throw new UsageError("Registry URL must start with http:// or https://");
          }
          if (args.url.startsWith("http://")) {
            warn(
              "Warning: registry URL uses plain HTTP (not HTTPS). For security, prefer https:// to protect against eavesdropping and tampering.",
            );
          }
          const config = loadUserConfig();
          const registries = [...(config.registries ?? [])];
          // Deduplicate by URL
          if (registries.some((r) => r.url === args.url)) {
            output("registry-add", { registries, added: false, message: "Registry URL already configured" });
            return;
          }
          const entry: RegistryConfigEntry = { url: args.url };
          if (args.name) entry.name = args.name;
          if (args.provider) entry.provider = args.provider;
          if (args.options) {
            try {
              entry.options = JSON.parse(args.options);
            } catch {
              throw new UsageError("--options must be valid JSON");
            }
          }
          registries.push(entry);
          saveConfig({ ...config, registries });
          output("registry-add", { registries, added: true });
        });
      },
    }),
    remove: defineCommand({
      meta: { name: "remove", description: "Remove a registry by URL or name" },
      args: {
        target: { type: "positional", description: "Registry URL or name to remove", required: true },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          const config = loadUserConfig();
          const registries = [...(config.registries ?? [])];
          const idx = registries.findIndex((r) => r.url === args.target || r.name === args.target);
          if (idx === -1) {
            output("registry-remove", { registries, removed: false, message: "No matching registry found" });
            return;
          }
          const removed = registries.splice(idx, 1)[0];
          saveConfig({ ...config, registries });
          output("registry-remove", { registries, removed: true, entry: removed });
        });
      },
    }),
    search: defineCommand({
      meta: { name: "search", description: "Search enabled registries for kits" },
      args: {
        query: { type: "positional", description: "Search query", required: true },
        limit: { type: "string", description: "Maximum number of results" },
        assets: { type: "boolean", description: "Include asset-level search results", default: false },
      },
      async run({ args }) {
        await runWithJsonErrors(async () => {
          const limitRaw = args.limit ? parseInt(args.limit, 10) : undefined;
          if (limitRaw !== undefined && Number.isNaN(limitRaw)) {
            throw new UsageError(`Invalid --limit value: "${args.limit}". Must be a positive integer.`);
          }
          const result = await searchRegistry(args.query, { limit: limitRaw, includeAssets: args.assets });
          output("registry-search", result);
        });
      },
    }),
    "build-index": defineCommand({
      meta: { name: "build-index", description: "Build a v2 registry index from discovery and manual entries" },
      args: {
        out: { type: "string", description: "Output path for the generated index", default: "index.json" },
        manual: { type: "string", description: "Manual entries JSON file", default: "manual-entries.json" },
        npmRegistry: { type: "string", description: "Override npm registry base URL" },
        githubApi: { type: "string", description: "Override GitHub API base URL" },
      },
      async run({ args }) {
        await runWithJsonErrors(async () => {
          const result = await buildRegistryIndex({
            manualEntriesPath: args.manual,
            npmRegistryBase: args.npmRegistry,
            githubApiBase: args.githubApi,
          });
          const outPath = writeRegistryIndex(result.index, args.out);
          output("registry-build-index", {
            outPath,
            version: result.index.version,
            updatedAt: result.index.updatedAt,
            totalKits: result.counts.total,
            counts: result.counts,
            manualEntriesPath: result.paths.manualEntriesPath,
          });
        });
      },
    }),
  },
});

const feedbackCommand = defineCommand({
  meta: {
    name: "feedback",
    description: "Record positive or negative feedback for a stash asset",
  },
  args: {
    ref: { type: "positional", description: "Asset ref (type:name)", required: true },
    positive: { type: "boolean", description: "Record positive feedback", default: false },
    negative: { type: "boolean", description: "Record negative feedback", default: false },
    note: { type: "string", description: "Optional note to attach to the feedback" },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const ref = args.ref.trim();
      if (!ref) {
        throw new UsageError("Asset ref is required. Usage: akm feedback <ref> --positive|--negative");
      }
      if (args.positive && args.negative) {
        throw new UsageError("Specify either --positive or --negative, not both.");
      }
      if (!args.positive && !args.negative) {
        throw new UsageError("Specify --positive or --negative.");
      }
      const signal = args.positive ? "positive" : "negative";
      const metadata = args.note ? JSON.stringify({ note: args.note }) : undefined;

      const db = openDatabase();
      try {
        insertUsageEvent(db, {
          event_type: "feedback",
          entry_ref: ref,
          signal,
          metadata,
        });
      } finally {
        closeDatabase(db);
      }

      output("feedback", { ok: true, ref, signal, note: args.note ?? null });
    });
  },
});

const hintsCommand = defineCommand({
  meta: {
    name: "hints",
    description: "Print agent instructions on how to use akm, use --detail full for a complete guide",
  },
  args: {
    detail: { type: "string", description: "Detail level (normal|full)", default: "normal" },
  },
  run({ args }) {
    const detail = args.detail === "full" ? "full" : "normal";
    process.stdout.write(loadHints(detail));
  },
});

const completionsCommand = defineCommand({
  meta: {
    name: "completions",
    description: "Generate or install shell completion script",
  },
  args: {
    install: {
      type: "boolean",
      description: "Install completions to the appropriate directory",
      default: false,
    },
    shell: {
      type: "string",
      description: "Shell type (bash)",
      default: "bash",
    },
  },
  run({ args }) {
    if (args.shell !== "bash") {
      throw new UsageError(`Unsupported shell: ${args.shell}. Only bash is supported.`);
    }
    const script = generateBashCompletions(main);
    if (args.install) {
      const dest = installBashCompletions(script);
      console.error(`Completions installed to ${dest}`);
      console.error(`Restart your shell or run:  source ${dest}`);
    } else {
      process.stdout.write(script);
    }
  },
});

function normalizeToggleTarget(target: string): "skills.sh" | "context-hub" {
  const normalized = target.trim().toLowerCase();
  if (normalized === "skills.sh" || normalized === "skills-sh") return "skills.sh";
  if (normalized === "context-hub") return "context-hub";
  throw new UsageError(`Unsupported target "${target}". Supported targets: skills.sh, context-hub`);
}

function toggleSkillsShRegistry(enabled: boolean): { changed: boolean; component: string; enabled: boolean } {
  const config = loadUserConfig();
  const registries = (config.registries ?? DEFAULT_CONFIG.registries ?? []).map((registry) => ({ ...registry }));
  const idx = registries.findIndex(
    (registry) =>
      registry.provider === SKILLS_SH_PROVIDER || registry.name === SKILLS_SH_NAME || registry.url === SKILLS_SH_URL,
  );

  if (idx >= 0) {
    const existing = registries[idx];
    const wasEnabled = existing.enabled !== false;
    existing.enabled = enabled;
    saveConfig({ ...config, registries });
    return { changed: wasEnabled !== enabled, component: SKILLS_SH_NAME, enabled };
  }

  if (!enabled) {
    // Materialize default registries explicitly if the skills.sh entry is absent.
    registries.push({ url: SKILLS_SH_URL, name: SKILLS_SH_NAME, provider: SKILLS_SH_PROVIDER, enabled: false });
    saveConfig({ ...config, registries });
    return { changed: true, component: SKILLS_SH_NAME, enabled: false };
  }

  registries.push({ url: SKILLS_SH_URL, name: SKILLS_SH_NAME, provider: SKILLS_SH_PROVIDER, enabled: true });
  saveConfig({ ...config, registries });
  return { changed: true, component: SKILLS_SH_NAME, enabled: true };
}

function toggleContextHubStash(enabled: boolean): { changed: boolean; component: string; enabled: boolean } {
  const config = loadUserConfig();
  const stashes = [...(config.stashes ?? [])];
  const idx = stashes.findIndex((stash) => stash.name === CONTEXT_HUB_ALIAS_REF || stash.url === CONTEXT_HUB_ALIAS_URL);

  if (idx >= 0) {
    const existing = stashes[idx];
    const wasEnabled = existing.enabled !== false;
    existing.enabled = enabled;
    saveConfig({ ...config, stashes });
    return { changed: wasEnabled !== enabled, component: CONTEXT_HUB_ALIAS_REF, enabled };
  }

  if (!enabled) {
    return { changed: false, component: CONTEXT_HUB_ALIAS_REF, enabled: false };
  }

  stashes.push({ type: "git", url: CONTEXT_HUB_ALIAS_URL, name: CONTEXT_HUB_ALIAS_REF, enabled: true });
  saveConfig({ ...config, stashes });
  return { changed: true, component: CONTEXT_HUB_ALIAS_REF, enabled: true };
}

function toggleComponent(
  targetRaw: string,
  enabled: boolean,
): { changed: boolean; component: string; enabled: boolean } {
  const target = normalizeToggleTarget(targetRaw);
  if (target === "skills.sh") return toggleSkillsShRegistry(enabled);
  return toggleContextHubStash(enabled);
}

const enableCommand = defineCommand({
  meta: { name: "enable", description: "Enable an optional component (skills.sh or context-hub)" },
  args: {
    target: { type: "positional", description: "Component to enable (skills.sh|context-hub)", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const result = toggleComponent(args.target, true);
      output("enable", result);
    });
  },
});

const disableCommand = defineCommand({
  meta: { name: "disable", description: "Disable an optional component (skills.sh or context-hub)" },
  args: {
    target: { type: "positional", description: "Component to disable (skills.sh|context-hub)", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const result = toggleComponent(args.target, false);
      output("disable", result);
    });
  },
});

const main = defineCommand({
  meta: {
    name: "akm",
    version: pkgVersion,
    description: "Agent Kit Manager — search, show, and manage assets from your stash.",
  },
  args: {
    format: { type: "string", description: "Output format (json|text|yaml)" },
    detail: { type: "string", description: "Detail level (brief|normal|full)" },
    quiet: { type: "boolean", alias: "q", description: "Suppress stderr warnings", default: false },
  },
  subCommands: {
    setup: setupCommand,
    init: initCommand,
    index: indexCommand,
    info: infoCommand,
    add: addCommand,
    list: listCommand,
    remove: removeCommand,
    update: updateCommand,
    upgrade: upgradeCommand,
    search: searchCommand,
    curate: curateCommand,
    show: showCommand,
    clone: cloneCommand,
    registry: registryCommand,
    config: configCommand,
    enable: enableCommand,
    disable: disableCommand,
    feedback: feedbackCommand,
    hints: hintsCommand,
    completions: completionsCommand,
  },
});

const CONFIG_SUBCOMMAND_SET = new Set(["path", "list", "get", "set", "unset"]);
const SHOW_VIEW_MODES = new Set(["toc", "frontmatter", "full", "section", "lines"]);

// citty reads process.argv directly and does not accept a custom argv array,
// so we must replace process.argv with the normalized version before runMain.
process.argv = normalizeShowArgv(process.argv);
runMain(main);

// ── Exit codes ──────────────────────────────────────────────────────────────
const EXIT_GENERAL = 1;
const EXIT_USAGE = 2;
const EXIT_CONFIG = 78;

function classifyExitCode(error: unknown): number {
  if (error instanceof UsageError) return EXIT_USAGE;
  if (error instanceof ConfigError) return EXIT_CONFIG;
  if (error instanceof NotFoundError) return EXIT_GENERAL;
  return EXIT_GENERAL;
}

async function runWithJsonErrors(fn: (() => void) | (() => Promise<void>)): Promise<void> {
  try {
    // Apply --quiet flag early so warnings inside the command are suppressed
    if (process.argv.includes("--quiet") || process.argv.includes("-q")) {
      setQuiet(true);
    }
    await fn();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = buildHint(message);
    const exitCode = classifyExitCode(error);
    console.error(JSON.stringify({ ok: false, error: message, hint }, null, 2));
    process.exit(exitCode);
  }
}

function buildHint(message: string): string | undefined {
  if (message.includes("No stash directory found"))
    return "Run `akm init` to create the default stash, or set stashDir in your config.";
  if (message.includes("Either <target> or --all is required"))
    return "Use `akm update --all` or pass a target like `akm update npm:@scope/pkg`.";
  if (message.includes("Specify either <target> or --all")) return "Use only one: a positional target or `--all`.";
  if (message.includes("No matching source"))
    return "Run `akm list` to view your sources, then retry with one of those values.";
  if (message.includes("remote package fetched but asset not found"))
    return "The remote package was fetched but doesn't contain the requested asset. Check the asset name and type.";
  if (message.includes("Invalid value for --source")) return "Pick one of: stash, registry, both.";
  if (message.includes("Invalid value for --format")) return "Pick one of: json, jsonl, text, yaml.";
  if (message.includes("Invalid value for --detail")) return "Pick one of: brief, normal, full, summary.";
  if (message.includes("expected JSON object with endpoint and model")) {
    return 'Quote JSON values in your shell, for example: akm config set embedding \'{"endpoint":"http://localhost:11434/v1/embeddings","model":"nomic-embed-text"}\'.';
  }
  return undefined;
}

function hasConfigSubcommand(args: Record<string, unknown>): boolean {
  const command = Array.isArray(args._) ? args._[0] : undefined;
  return typeof command === "string" && CONFIG_SUBCOMMAND_SET.has(command);
}

/**
 * Normalize argv so positional view-mode arguments after the asset ref
 * are rewritten into internal flags that citty can parse.
 *
 * Converts:
 *   akm show knowledge:guide.md toc          → akm show knowledge:guide.md --akmView toc
 *   akm show knowledge:guide.md section Auth → akm show knowledge:guide.md --akmView section --akmHeading Auth
 *   akm show knowledge:guide.md lines 1 50   → akm show knowledge:guide.md --akmView lines --akmStart 1 --akmEnd 50
 *
 * Legacy `--view` is intentionally unsupported.
 * Returns a new array; the input is never modified.
 */
function normalizeShowArgv(argv: string[]): string[] {
  // argv[0]=bun argv[1]=script argv[2]=subcommand argv[3]=ref argv[4..]=rest
  if (argv[2] !== "show") return argv;
  if (argv.includes("--view") || argv.includes("--heading") || argv.includes("--start") || argv.includes("--end")) {
    throw new UsageError(
      'Legacy show flags are no longer supported. Use positional syntax like `akm show knowledge:guide toc` or `akm show knowledge:guide section "Auth"`.',
    );
  }

  // Separate global flags from positional/show-specific args
  const prefix = argv.slice(0, 3); // [bun, script, show]
  const rest = argv.slice(3);

  const globalFlags: string[] = [];
  const showArgs: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--quiet" || arg === "-q" || arg === "--for-agent" || arg === "--for-agent=true") {
      globalFlags.push(arg);
      continue;
    }
    if (arg.startsWith("--format=") || arg.startsWith("--detail=")) {
      globalFlags.push(arg);
      continue;
    }
    if (arg === "--format" || arg === "--detail") {
      globalFlags.push(arg);
      if (rest[i + 1] !== undefined) {
        globalFlags.push(rest[i + 1]);
        i++;
      }
      continue;
    }
    showArgs.push(arg);
  }

  // showArgs[0] = ref, showArgs[1] = potential view mode, showArgs[2..] = view params
  const ref = showArgs[0];
  const viewMode = showArgs[1];

  if (!ref || !viewMode || !SHOW_VIEW_MODES.has(viewMode)) {
    return argv;
  }

  const result = [...prefix, ref, "--akmView", viewMode];

  if (viewMode === "section") {
    // Next arg is the heading name; pass empty string when missing so the
    // show handler can produce a clear "section not found" error.
    const heading = showArgs[2] ?? "";
    result.push("--akmHeading", heading);
  } else if (viewMode === "lines") {
    // Next two args are start and end
    const start = showArgs[2];
    const end = showArgs[3];
    if (start) result.push("--akmStart", start);
    if (end) result.push("--akmEnd", end);
  }

  result.push(...globalFlags);
  return result;
}

// ── Hints (embedded AGENTS.md) ──────────────────────────────────────────────

function loadHints(detail: "normal" | "full" = "normal"): string {
  const filename = detail === "full" ? "AGENTS.full.md" : "AGENTS.md";
  const fallback = detail === "full" ? EMBEDDED_HINTS_FULL : EMBEDDED_HINTS;

  // Try reading from the docs/ directory (works in dev and when installed via npm)
  try {
    const docsPath = path.resolve(import.meta.dir ?? __dirname, `../docs/${filename}`);
    if (fs.existsSync(docsPath)) {
      return fs.readFileSync(docsPath, "utf8");
    }
  } catch {
    // fall through
  }
  // Fallback for compiled binary — inline content
  return fallback;
}

const EMBEDDED_HINTS = `# akm CLI

You have access to a searchable library of scripts, skills, commands, agents, and knowledge documents via \`akm\`. Search your sources first before writing something from scratch.

## Quick Reference

\`\`\`sh
akm search "<query>"                          # Search all sources
akm curate "<task>"                          # Curate the best matches for a task
akm search "<query>" --type skill             # Filter by type
akm search "<query>" --source both            # Also search registries
akm show <ref>                                # View asset details
akm add <ref>                                 # Add a source (npm, GitHub, git, local dir)
akm clone <ref>                               # Copy an asset to the working stash (optional --dest arg to clone to specific location)
akm registry search "<query>"                 # Search all registries
\`\`\`

## Primary Asset Types

| Type | What \`akm show\` returns |
| --- | --- |
| script | A \`run\` command you can execute directly |
| skill | Instructions to follow (read the full content) |
| command | A prompt template with placeholders to fill in |
| agent | A system prompt with model and tool hints |
| knowledge | A reference doc (use \`toc\` or \`section "..."\` to navigate) |

Run \`akm -h\` for the full command reference.
`;

const EMBEDDED_HINTS_FULL = `# akm CLI — Full Reference

You have access to a searchable library of scripts, skills, commands, agents, and knowledge documents via \`akm\`. Search your sources first before writing something from scratch.

## Search

\`\`\`sh
akm search "<query>"                          # Search all sources
akm curate "<task>"                          # Curate the best matches for a task
akm search "<query>" --type skill             # Filter by asset type
akm search "<query>" --source both            # Also search registries
akm search "<query>" --source registry        # Search registries only
akm search "<query>" --limit 10               # Limit results
akm search "<query>" --detail full            # Include scores, paths, timing
\`\`\`

| Flag | Values | Default |
| --- | --- | --- |
| \`--type\` | \`skill\`, \`command\`, \`agent\`, \`knowledge\`, \`script\`, \`memory\`, \`any\` | \`any\` |
| \`--source\` | \`stash\`, \`registry\`, \`both\` | \`stash\` |
| \`--limit\` | number | \`20\` |
| \`--format\` | \`json\`, \`jsonl\`, \`text\`, \`yaml\` | \`json\` |
| \`--detail\` | \`brief\`, \`normal\`, \`full\`, \`summary\` | \`brief\` |
| \`--for-agent\` | boolean | \`false\` |

## Curate

Combine search + follow-up hints into a dense summary for a task or prompt.

\`\`\`sh
akm curate "plan a release"                   # Pick top matches across asset types
akm curate "deploy a Bun app" --limit 3       # Keep the summary shorter
akm curate "review architecture" --type skill # Restrict to one asset type
\`\`\`

## Show

Display an asset by ref. Knowledge assets support view modes as positional arguments.

\`\`\`sh
akm show script:deploy.sh                     # Show script (returns run command)
akm show skill:code-review                    # Show skill (returns full content)
akm show command:release                      # Show command (returns template)
akm show agent:architect                      # Show agent (returns system prompt)
akm show knowledge:guide toc                  # Table of contents
akm show knowledge:guide section "Auth"       # Specific section
akm show knowledge:guide lines 10 30          # Line range
akm show knowledge:my-doc                    # Show content (local or remote)
\`\`\`

| Type | Key fields returned |
| --- | --- |
| script | \`run\`, \`setup\`, \`cwd\` |
| skill | \`content\` (full SKILL.md) |
| command | \`template\`, \`description\`, \`parameters\` |
| agent | \`prompt\`, \`description\`, \`modelHint\`, \`toolPolicy\` |
| knowledge | \`content\` (with view modes: \`full\`, \`toc\`, \`frontmatter\`, \`section\`, \`lines\`) |
| memory | \`content\` (recalled context) |

## Add & Manage Sources

\`\`\`sh
akm add <ref>                                 # Add a source
akm add @scope/kit                            # From npm (managed)
akm add owner/repo                            # From GitHub (managed)
akm add ./path/to/local/kit                   # Local directory
akm enable skills.sh                          # Enable the skills.sh registry
akm disable skills.sh                         # Disable the skills.sh registry
akm enable context-hub                        # Add/enable the context-hub source
akm disable context-hub                       # Disable the context-hub source
akm list                                      # List all sources
akm list --kind managed                       # List managed sources only
akm remove <target>                           # Remove by id, ref, path, or name
akm update --all                              # Update all managed sources
akm update <target> --force                   # Force re-download
\`\`\`

## Clone

Copy an asset to the working stash or a custom destination for editing.

\`\`\`sh
akm clone <ref>                               # Clone to working stash
akm clone <ref> --name new-name               # Rename on clone
akm clone <ref> --dest ./project/.claude       # Clone to custom location
akm clone <ref> --force                       # Overwrite existing
akm clone "npm:@scope/pkg//script:deploy.sh"  # Clone from remote package
\`\`\`

When \`--dest\` is provided, \`akm init\` is not required first.

## Registries

\`\`\`sh
akm registry list                             # List configured registries
akm registry add <url>                        # Add a registry
akm registry add <url> --name my-team         # Add with label
akm registry add <url> --provider skills-sh   # Specify provider type
akm registry remove <url-or-name>             # Remove a registry
akm registry search "<query>"                 # Search all registries
akm registry search "<query>" --assets        # Include asset-level results
akm registry build-index                      # Build ./index.json
akm registry build-index --out dist/index.json # Build to a custom path
\`\`\`

## Configuration

\`\`\`sh
akm config list                               # Show current config
akm config get <key>                          # Read a value
akm config set <key> <value>                  # Set a value
akm config unset <key>                        # Remove a key
akm config path --all                         # Show all config paths
\`\`\`

## Other Commands

\`\`\`sh
akm init                                      # Initialize working stash
akm index                                     # Rebuild search index
akm index --full                              # Full reindex
akm list                                      # List all sources
akm upgrade                                   # Upgrade akm binary
akm upgrade --check                           # Check for updates
akm hints                                     # Print this reference
akm completions                               # Print bash completion script
akm completions --install                     # Install completions
\`\`\`

## Output Control

All commands accept \`--format\` and \`--detail\` flags:

- \`--format json\` (default) — structured JSON
- \`--format jsonl\` — one JSON object per line (streaming-friendly)
- \`--format text\` — human-readable plain text
- \`--format yaml\` — YAML output
- \`--detail brief\` (default) — compact output
- \`--detail normal\` — adds tags, refs, origins
- \`--detail full\` — includes scores, paths, timing, debug info
- \`--detail summary\` — metadata only (no content/template/prompt), under 200 tokens
- \`--for-agent\` — agent-optimized output: strips non-actionable fields (takes precedence over \`--detail\`)

Run \`akm -h\` or \`akm <command> -h\` for per-command help.
`;
