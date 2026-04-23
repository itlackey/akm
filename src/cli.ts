#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { defineCommand, runMain } from "citty";
import { deriveCanonicalAssetName, resolveAssetPathFromName } from "./asset-spec";
import { isWithin, resolveStashDir } from "./common";
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
import { renderMigrationHelp } from "./migration-help";
import { getCacheDir, getDbPath, getDefaultStashDir } from "./paths";
import { buildRegistryIndex, writeRegistryIndex } from "./registry-build-index";
import { searchRegistry } from "./registry-search";
import { checkForUpdate, performUpgrade } from "./self-update";
import { akmAdd } from "./stash-add";
import { akmClone } from "./stash-clone";
import { saveGitStash } from "./stash-providers/git";
import { parseAssetRef } from "./stash-ref";
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
import { createWorkflowAsset, getWorkflowTemplate } from "./workflow-authoring";
import {
  hasWorkflowSubcommand,
  parseWorkflowJsonObject,
  parseWorkflowStepState,
  WORKFLOW_STEP_STATES,
} from "./workflow-cli";
import {
  completeWorkflowStep,
  getNextWorkflowStep,
  getWorkflowStatus,
  listWorkflowRuns,
  resumeWorkflowRun,
  startWorkflowRun,
} from "./workflow-runs";

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
const MAX_CAPTURED_ASSET_SLUG_LENGTH = 64;
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
      if (r.workflowTitle) lines.push(`workflowTitle: ${String(r.workflowTitle)}`);
      if (r.agent) lines.push(`agent: ${String(r.agent)}`);
      if (Array.isArray(r.parameters) && r.parameters.length > 0) lines.push(`parameters: ${r.parameters.join(", ")}`);
      if (Array.isArray(r.workflowParameters) && r.workflowParameters.length > 0) {
        lines.push("workflowParameters:");
        for (const parameter of r.workflowParameters as Array<Record<string, unknown>>) {
          const name = typeof parameter.name === "string" ? parameter.name : "unknown";
          const description =
            typeof parameter.description === "string" && parameter.description.trim()
              ? `: ${parameter.description}`
              : "";
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
      const payloads = [r.content, r.template, r.prompt].filter((value) => value != null).map(String);
      if (Array.isArray(r.steps) && r.steps.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push("steps:");
        for (const [index, step] of (r.steps as Array<Record<string, unknown>>).entries()) {
          const title = typeof step.title === "string" ? step.title : "Untitled step";
          const id = typeof step.id === "string" ? step.id : "unknown";
          lines.push(`  ${index + 1}. ${title} [${id}]`);
          if (typeof step.instructions === "string" && step.instructions.trim()) {
            lines.push(`     instructions: ${step.instructions.replace(/\n+/g, " ").trim()}`);
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
      return lines.length > 0 ? lines.join("\n") : null;
    }
    case "search": {
      return formatSearchPlain(r, detail);
    }
    case "curate": {
      return formatCuratePlain(r, detail);
    }
    case "wiki-list": {
      return formatWikiListPlain(r);
    }
    case "wiki-show": {
      return formatWikiShowPlain(r);
    }
    case "wiki-create": {
      return formatWikiCreatePlain(r);
    }
    case "wiki-remove": {
      return formatWikiRemovePlain(r);
    }
    case "wiki-pages": {
      return formatWikiPagesPlain(r);
    }
    case "wiki-stash": {
      return formatWikiStashPlain(r);
    }
    case "wiki-lint": {
      return formatWikiLintPlain(r);
    }
    case "wiki-ingest": {
      return formatWikiIngestPlain(r);
    }
    case "workflow-start":
    case "workflow-status":
    case "workflow-complete": {
      return formatWorkflowStatusPlain(r);
    }
    case "workflow-next": {
      return formatWorkflowNextPlain(r);
    }
    case "workflow-list": {
      return formatWorkflowListPlain(r);
    }
    case "workflow-create": {
      if (r.ref && r.path) {
        return `Created ${String(r.ref)} at ${String(r.path)}`;
      }
      return null;
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
        const flags: string[] = [];
        if (typeof src.wiki === "string") flags.push(`wiki:${src.wiki}`);
        if (src.updatable === true) flags.push("updatable");
        if (src.writable === true) flags.push("writable");
        const flagText = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
        lines.push(`[${kind}] ${name}${ver}${prov}${flagText}`);
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

function formatWorkflowListPlain(result: Record<string, unknown>): string {
  const runs = Array.isArray(result.runs) ? (result.runs as Array<Record<string, unknown>>) : [];
  if (runs.length === 0) return "No workflow runs found.";

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

function formatWorkflowStatusPlain(result: Record<string, unknown>): string | null {
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

function formatWorkflowNextPlain(result: Record<string, unknown>): string | null {
  const base = formatWorkflowStatusPlain(result);
  const step =
    typeof result.step === "object" && result.step !== null ? (result.step as Record<string, unknown>) : undefined;
  if (!step) return base;

  const lines = base ? [base, "", "next:"] : ["next:"];
  lines.push(`  ${String(step.title ?? "Untitled step")} [${String(step.id ?? "unknown")}]`);
  if (typeof step.instructions === "string" && step.instructions.trim()) {
    lines.push(`  instructions: ${step.instructions.replace(/\n+/g, " ").trim()}`);
  }
  const completion = Array.isArray(step.completionCriteria) ? step.completionCriteria : [];
  if (completion.length > 0) {
    lines.push("  completion:");
    for (const criterion of completion) {
      lines.push(`    - ${String(criterion)}`);
    }
  }
  return lines.join("\n");
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

function formatWikiListPlain(r: Record<string, unknown>): string {
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

function formatWikiShowPlain(r: Record<string, unknown>): string {
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

function formatWikiCreatePlain(r: Record<string, unknown>): string {
  const created = Array.isArray(r.created) ? (r.created as string[]) : [];
  const skipped = Array.isArray(r.skipped) ? (r.skipped as string[]) : [];
  const lines = [`Created wiki ${String(r.ref ?? r.name)} at ${String(r.path ?? "?")}`];
  if (created.length > 0) lines.push(`  created: ${created.length} file(s)`);
  if (skipped.length > 0) lines.push(`  skipped: ${skipped.length} existing file(s)`);
  return lines.join("\n");
}

function formatWikiRemovePlain(r: Record<string, unknown>): string {
  const preserved = r.preservedRaw === true;
  const removed = Array.isArray(r.removed) ? (r.removed as string[]).length : 0;
  const base = `Removed wiki ${String(r.name ?? "?")} (${removed} path(s))`;
  return preserved ? `${base}; preserved ${String(r.rawPath ?? "raw/")}` : base;
}

function formatWikiPagesPlain(r: Record<string, unknown>): string {
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

function formatWikiStashPlain(r: Record<string, unknown>): string {
  const slug = String(r.slug ?? "?");
  const pathValue = String(r.path ?? "?");
  return `Stashed ${slug} → ${pathValue}`;
}

function formatWikiLintPlain(r: Record<string, unknown>): string {
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

function formatWikiIngestPlain(r: Record<string, unknown>): string {
  if (typeof r.workflow === "string") return r.workflow;
  return JSON.stringify(r, null, 2);
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
      description:
        "Asset type filter (skill, command, agent, knowledge, workflow, script, memory, vault, wiki, or any). Use workflow to find step-by-step task assets.",
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
      description:
        "Asset type filter (skill, command, agent, knowledge, workflow, script, memory, vault, wiki, or any). Use workflow to curate step-by-step task assets.",
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
    writable: {
      type: "boolean",
      description: "Mark a git stash as writable so changes can be pushed back",
      default: false,
    },
    trust: {
      type: "boolean",
      description: "Bypass install-audit blocking for this add invocation only",
      default: false,
    },
    type: {
      type: "string",
      description: "Override asset type for all files in this stash (currently supports: wiki)",
    },
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
          providerType: "git",
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
          writable: args.writable,
        });
        output("stash-add", result);
        return;
      }

      if (shouldWarnOnPlainHttp(ref)) {
        warn(
          "Warning: source URL uses plain HTTP (not HTTPS). For security, prefer https:// to protect against eavesdropping and tampering.",
        );
      }
      const websiteOptions = buildWebsiteOptions(args);

      if (args.type === "wiki") {
        const { registerWikiSource } = await import("./stash-add");
        const result = await registerWikiSource({
          ref,
          name: args.name,
          options: Object.keys(websiteOptions).length > 0 ? websiteOptions : undefined,
          trustThisInstall: args.trust,
          writable: args.writable,
        });
        output("add", result);
        return;
      }

      const result = await akmAdd({
        ref,
        name: args.name,
        overrideType: args.type,
        options: Object.keys(websiteOptions).length > 0 ? websiteOptions : undefined,
        trustThisInstall: args.trust,
        writable: args.writable,
      });
      output("add", result);
    });
  },
});

function buildWebsiteOptions(args: Record<string, unknown>): Record<string, unknown> {
  const websiteOptions: Record<string, unknown> = {};
  if (typeof args["max-pages"] === "string" && args["max-pages"].length > 0)
    websiteOptions.maxPages = args["max-pages"];
  if (typeof args["max-depth"] === "string" && args["max-depth"].length > 0)
    websiteOptions.maxDepth = args["max-depth"];
  return websiteOptions;
}

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

const saveCommand = defineCommand({
  meta: {
    name: "save",
    description:
      "Save changes in a git-backed stash: commits (and pushes when writable + remote is configured). No-op for non-git stashes.",
  },
  args: {
    name: {
      type: "positional",
      description: "Name of the git stash to save (default: primary stash directory)",
      required: false,
    },
    message: {
      type: "string",
      alias: "m",
      description: "Commit message (default: timestamp)",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      // Fix: citty can consume `--format json` (space-separated) as the
      // positional `name` argument (e.g. `akm save --format json` parses
      // name="json"). Detect the mis-parse by checking argv order — only
      // treat the positional as consumed by --format when --format appears
      // before any standalone occurrence of the same value in the save
      // subcommand's argv slice. This preserves legitimate invocations
      // like `akm save json --format json`.
      const parsedFormat = parseFlagValue("--format");
      const effectiveName =
        args.name !== undefined &&
        parsedFormat !== undefined &&
        args.name === parsedFormat &&
        wasFormatValueConsumedAsName(args.name, parsedFormat)
          ? undefined
          : args.name;

      let writable: boolean | undefined;
      if (!effectiveName) {
        // Primary stash — honour the root-level writable flag from config.
        const cfg = loadConfig();
        writable = cfg.writable === true ? true : undefined;
      }

      const result = saveGitStash(effectiveName, args.message, writable);
      output("save", result);
    });
  },
});

/**
 * Detect whether `--format <value>` was consumed by citty as the optional
 * `name` positional of `akm save`. Returns true only when `--format` appears
 * in the save subcommand's argv slice AND the candidate name does NOT
 * appear as a standalone positional elsewhere (before or after the flag).
 *
 * This keeps `akm save json --format json` routing `json` as the stash name,
 * while `akm save --format json` (no separate positional) is treated as a
 * primary-stash save.
 */
function wasFormatValueConsumedAsName(name: string, formatValue: string): boolean {
  const argv = process.argv.slice(2);
  const saveIndex = argv.indexOf("save");
  const tokens = saveIndex >= 0 ? argv.slice(saveIndex + 1) : argv;

  let formatIndex = -1;
  let formatConsumesNextToken = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--format") {
      formatIndex = i;
      formatConsumesNextToken = true;
      break;
    }
    if (token === `--format=${formatValue}`) {
      formatIndex = i;
      break;
    }
  }

  if (formatIndex === -1) return false;

  // If the name appears as a standalone token before --format, it's the
  // real positional and --format did not consume it.
  if (tokens.slice(0, formatIndex).includes(name)) return false;

  // If --format has a space-separated value, skip past the value token
  // when scanning after the flag; otherwise start right after the flag.
  const firstTokenAfterFormat = formatIndex + (formatConsumesNextToken ? 2 : 1);
  if (tokens.slice(firstTokenAfterFormat).includes(name)) return false;

  return true;
}

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

function tryReadStdinText(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  const input = fs.readFileSync(0, "utf8");
  return input.length > 0 ? input : undefined;
}

function normalizeMarkdownAssetName(name: string | undefined, fallback: string): string {
  const trimmed = (name ?? fallback)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.md$/i, "");
  if (!trimmed) throw new UsageError("Asset name cannot be empty.");
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new UsageError("Asset name must be a relative path without '.' or '..' segments.");
  }
  return trimmed;
}

function slugifyAssetName(value: string, fallbackPrefix: string): string {
  const slug = value
    .toLowerCase()
    .replace(/^[#>\-\s]+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CAPTURED_ASSET_SLUG_LENGTH);
  return slug || `${fallbackPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function inferAssetName(content: string, fallbackPrefix: string, preferred?: string): string {
  const firstNonEmptyLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const basis = preferred?.trim() || firstNonEmptyLine || fallbackPrefix;
  return slugifyAssetName(basis, fallbackPrefix);
}

function readMemoryContent(contentArg: string | undefined): string {
  const content = contentArg ?? tryReadStdinText();
  if (!content?.trim()) {
    throw new UsageError("Memory content is required. Pass quoted text or pipe markdown into stdin.");
  }
  return content;
}

function readKnowledgeContent(source: string): { content: string; preferredName?: string } {
  if (source === "-") {
    const content = tryReadStdinText();
    if (!content?.trim()) {
      throw new UsageError("No stdin content received. Pipe a document into stdin or pass a file path.");
    }
    return { content };
  }

  const resolvedSource = path.resolve(source);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedSource);
  } catch {
    throw new UsageError(`Knowledge source not found: "${source}". Pass a readable file path or "-" for stdin.`);
  }
  if (!stat.isFile()) {
    throw new UsageError(`Knowledge source must be a file: "${source}".`);
  }
  return {
    content: fs.readFileSync(resolvedSource, "utf8"),
    preferredName: path.basename(resolvedSource, path.extname(resolvedSource)),
  };
}

function writeMarkdownAsset(options: {
  type: "knowledge" | "memory";
  content: string;
  name?: string;
  fallbackPrefix: string;
  preferredName?: string;
  force?: boolean;
}): { ref: string; path: string; stashDir: string } {
  const stashDir = resolveStashDir();
  const typeRoot = path.join(stashDir, options.type === "knowledge" ? "knowledge" : "memories");
  fs.mkdirSync(typeRoot, { recursive: true });

  const normalizedName = normalizeMarkdownAssetName(
    options.name,
    inferAssetName(options.content, options.fallbackPrefix, options.preferredName),
  );
  const assetPath = resolveAssetPathFromName(options.type, typeRoot, normalizedName);
  if (!isWithin(assetPath, typeRoot)) {
    throw new UsageError(`Resolved ${options.type} path escapes the stash: "${normalizedName}"`);
  }
  if (fs.existsSync(assetPath) && !options.force) {
    throw new UsageError(
      `${options.type === "knowledge" ? "Knowledge" : "Memory"} "${normalizedName}" already exists. Re-run with --force to overwrite it.`,
    );
  }

  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  fs.writeFileSync(assetPath, options.content.endsWith("\n") ? options.content : `${options.content}\n`, "utf8");
  return {
    ref: `${options.type}:${normalizedName}`,
    path: assetPath,
    stashDir,
  };
}

const workflowStartCommand = defineCommand({
  meta: {
    name: "start",
    description: "Start a new workflow run",
  },
  args: {
    ref: { type: "positional", description: "Workflow ref (workflow:<name>)", required: true },
    params: { type: "string", description: "Workflow parameters as a JSON object" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await startWorkflowRun(args.ref, parseWorkflowJsonObject(args.params, "--params"));
      output("workflow-start", result);
    });
  },
});

const workflowNextCommand = defineCommand({
  meta: {
    name: "next",
    description: "Show the next actionable workflow step, auto-starting a run when passed a workflow ref",
  },
  args: {
    target: { type: "positional", description: "Workflow run id or workflow ref", required: true },
    params: { type: "string", description: "Workflow parameters as a JSON object (only for auto-started runs)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const parsedParams = args.params ? parseWorkflowJsonObject(args.params, "--params") : undefined;
      const result = await getNextWorkflowStep(args.target, parsedParams);
      output("workflow-next", result);
    });
  },
});

const workflowCompleteCommand = defineCommand({
  meta: {
    name: "complete",
    description: "Update a workflow step state and persist notes/evidence",
  },
  args: {
    runId: { type: "positional", description: "Workflow run id", required: true },
    step: { type: "string", description: "Workflow step id", required: true },
    state: {
      type: "string",
      description: `Step state (default: completed). One of: ${WORKFLOW_STEP_STATES.join(", ")}.`,
    },
    notes: { type: "string", description: "Notes for the completed step" },
    evidence: { type: "string", description: "Evidence JSON object for the step" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = completeWorkflowStep({
        runId: args.runId,
        stepId: args.step,
        status: parseWorkflowStepState(args.state),
        notes: args.notes,
        evidence: args.evidence ? parseWorkflowJsonObject(args.evidence, "--evidence") : undefined,
      });
      output("workflow-complete", result);
    });
  },
});

const workflowStatusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show full workflow run state for review or resume",
  },
  args: {
    target: { type: "positional", description: "Workflow run id or workflow ref (workflow:<name>)", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const target = args.target;
      // Check if target looks like a workflow ref
      const parsed = (() => {
        try {
          return parseAssetRef(target);
        } catch {
          return null;
        }
      })();
      if (parsed?.type === "workflow") {
        const ref = `${parsed.origin ? `${parsed.origin}//` : ""}workflow:${parsed.name}`;
        const { runs } = listWorkflowRuns({ workflowRef: ref });
        if (runs.length === 0) {
          throw new NotFoundError(`No workflow runs found for ${ref}`);
        }
        const mostRecent = runs[0];
        if (!mostRecent) throw new NotFoundError(`No workflow runs found for ${ref}`);
        const result = getWorkflowStatus(mostRecent.id);
        output("workflow-status", result);
      } else {
        const result = getWorkflowStatus(target);
        output("workflow-status", result);
      }
    });
  },
});

const workflowListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List workflow runs",
  },
  args: {
    ref: { type: "string", description: "Filter to one workflow ref" },
    active: { type: "boolean", description: "Only show active runs", default: false },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const result = listWorkflowRuns({ workflowRef: args.ref, activeOnly: args.active });
      output("workflow-list", result);
    });
  },
});

const workflowCreateCommand = defineCommand({
  meta: {
    name: "create",
    description: "Create a workflow markdown document in the working stash",
  },
  args: {
    name: { type: "positional", description: "Workflow name", required: true },
    from: { type: "string", description: "Import and validate markdown from an existing file" },
    force: {
      type: "boolean",
      description: "Overwrite an existing workflow (requires --from or --reset)",
      default: false,
    },
    reset: {
      type: "boolean",
      description: "Explicitly replace an existing workflow with a fresh template (use with --force)",
      default: false,
    },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const namePattern = /^[a-z0-9][a-z0-9._/-]*$/;
      if (!namePattern.test(args.name)) {
        throw new UsageError(
          "Workflow name must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens, dots, underscores, and slashes.",
        );
      }
      if (args.force && !args.from && !args.reset) {
        throw new UsageError(
          "Refusing to overwrite with template: pass --from <file> to replace content, or --reset to explicitly replace with a fresh template.",
        );
      }
      const result = createWorkflowAsset({
        name: args.name,
        from: args.from,
        force: args.force,
      });
      output("workflow-create", { ok: true, ...result });
    });
  },
});

const workflowTemplateCommand = defineCommand({
  meta: {
    name: "template",
    description: "Print a valid workflow markdown template",
  },
  run() {
    process.stdout.write(getWorkflowTemplate());
  },
});

const workflowResumeCommand = defineCommand({
  meta: {
    name: "resume",
    description: "Resume a blocked or failed workflow run, flipping it back to active",
  },
  args: {
    runId: { type: "positional", description: "Workflow run id", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const result = resumeWorkflowRun(args.runId);
      output("workflow-run", result);
    });
  },
});

const workflowCommand = defineCommand({
  meta: {
    name: "workflow",
    description: "Author, inspect, and execute step-by-step workflow assets",
  },
  subCommands: {
    start: workflowStartCommand,
    next: workflowNextCommand,
    complete: workflowCompleteCommand,
    status: workflowStatusCommand,
    list: workflowListCommand,
    create: workflowCreateCommand,
    template: workflowTemplateCommand,
    resume: workflowResumeCommand,
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      if (hasWorkflowSubcommand(args)) return;
      output("workflow-list", listWorkflowRuns({ activeOnly: true }));
    });
  },
});

const rememberCommand = defineCommand({
  meta: {
    name: "remember",
    description: "Record a memory in the default stash",
  },
  args: {
    content: {
      type: "positional",
      description: "Memory content. Omit to read markdown from stdin.",
      required: false,
    },
    name: {
      type: "string",
      description: "Memory name (defaults to a slug from the content)",
    },
    force: {
      type: "boolean",
      description: "Overwrite an existing memory with the same name",
      default: false,
    },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const result = writeMarkdownAsset({
        type: "memory",
        content: readMemoryContent(args.content),
        name: args.name,
        fallbackPrefix: "memory",
        force: args.force,
      });
      output("remember", { ok: true, ...result });
    });
  },
});

const importKnowledgeCommand = defineCommand({
  meta: {
    name: "import",
    description: "Import a knowledge document into the default stash",
  },
  args: {
    source: {
      type: "positional",
      description: 'Source file path, or "-" to read from stdin',
      required: true,
    },
    name: {
      type: "string",
      description: "Knowledge name (defaults to the source filename or content slug)",
    },
    force: {
      type: "boolean",
      description: "Overwrite an existing knowledge document with the same name",
      default: false,
    },
  },
  async run({ args }) {
    return runWithJsonErrors(async () => {
      const { content, preferredName } = readKnowledgeContent(args.source);
      const result = writeMarkdownAsset({
        type: "knowledge",
        content,
        name: args.name,
        fallbackPrefix: "knowledge",
        preferredName,
        force: args.force,
      });
      output("import", { ok: true, source: args.source, ...result });
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

const helpCommand = defineCommand({
  meta: {
    name: "help",
    description: "Print focused help topics such as migration guidance for a release",
  },
  subCommands: {
    migrate: defineCommand({
      meta: {
        name: "migrate",
        description: "Print release notes and migration guidance for a version",
      },
      args: {
        version: {
          type: "positional",
          description: "Version to review (for example 0.5.0, v0.5.0, or latest)",
          required: true,
        },
      },
      run({ args }) {
        process.stdout.write(renderMigrationHelp(args.version));
      },
    }),
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
    // Materialize the skills.sh registry explicitly if absent.
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

// ── vault ───────────────────────────────────────────────────────────────────
//
// `akm vault` manages secrets stored in `.env` files under the vaults/
// asset directory. Values are NEVER written to stdout. `vault load` is
// the only value-emitting path: it parses the vault with dotenv, writes
// a safely-escaped shell script to a mode-0600 temp file, and emits only
// `. <temp>; rm -f <temp>` on stdout for `eval`. The shell reads values
// from the temp file — they never transit through akm's stdout.

function resolveVaultPath(ref: string): { name: string; absPath: string } {
  const stashDir = resolveStashDir({ readOnly: true });
  const parsed = parseAssetRef(ref.includes(":") ? ref : `vault:${ref}`);
  if (parsed.type !== "vault") {
    throw new UsageError(`Expected a vault ref (vault:<name>); got "${ref}".`);
  }
  const typeRoot = path.join(stashDir, "vaults");
  const absPath = resolveAssetPathFromName("vault", typeRoot, parsed.name);
  return { name: parsed.name, absPath };
}

/**
 * Walk `vaults/` recursively and return one entry per `.env` file, using the
 * vault asset spec's canonical-name logic so listing matches what the
 * matcher/asset-spec actually resolves (e.g. `vaults/team/prod.env` →
 * `vault:team/prod`, `vaults/team/.env` → `vault:team/default`).
 */
function listVaultsRecursive(
  listKeysFn: (vaultPath: string) => { keys: string[] },
): Array<{ ref: string; path: string; keyCount: number }> {
  const stashDir = resolveStashDir({ readOnly: true });
  const vaultsDir = path.join(stashDir, "vaults");
  const result: Array<{ ref: string; path: string; keyCount: number }> = [];
  if (!fs.existsSync(vaultsDir)) return result;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name !== ".env" && !entry.name.endsWith(".env")) continue;
      const canonical = deriveCanonicalAssetName("vault", vaultsDir, full);
      if (!canonical) continue;
      const { keys } = listKeysFn(full);
      result.push({ ref: `vault:${canonical}`, path: full, keyCount: keys.length });
    }
  };
  walk(vaultsDir);
  return result;
}

const vaultListCommand = defineCommand({
  meta: { name: "list", description: "List vaults, or list keys (no values) inside one vault" },
  args: {
    ref: { type: "positional", description: "Optional vault ref (e.g. vault:prod or just prod)", required: false },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { listKeys } = await import("./vault.js");
      if (args.ref) {
        const { name, absPath } = resolveVaultPath(args.ref);
        if (!fs.existsSync(absPath)) {
          throw new NotFoundError(`Vault not found: vault:${name}`);
        }
        const { keys, comments } = listKeys(absPath);
        output("vault-list", { ref: `vault:${name}`, path: absPath, keys, comments });
        return;
      }
      const vaults = listVaultsRecursive(listKeys);
      output("vault-list", { vaults });
    });
  },
});

const vaultCreateCommand = defineCommand({
  meta: { name: "create", description: "Create an empty vault file (no-op if it already exists)" },
  args: {
    name: { type: "positional", description: "Vault name (e.g. prod) — file becomes <name>.env", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { createVault } = await import("./vault.js");
      const { name, absPath } = resolveVaultPath(args.name);
      createVault(absPath);
      output("vault-create", { ref: `vault:${name}`, path: absPath });
    });
  },
});

const vaultSetCommand = defineCommand({
  meta: {
    name: "set",
    description:
      'Set a key in a vault. Value is written to disk and never echoed back. Accepts KEY=VALUE combined form or separate KEY VALUE args. Optionally attach a comment with --comment "description".',
  },
  args: {
    ref: { type: "positional", description: "Vault ref (e.g. vault:prod or just prod)", required: true },
    key: { type: "positional", description: "Key name (e.g. DB_URL) or KEY=VALUE combined form", required: true },
    value: {
      type: "positional",
      description: "Value to store (omit when using KEY=VALUE combined form)",
      required: false,
    },
    comment: { type: "string", description: "Optional comment written above the key line", required: false },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { setKey } = await import("./vault.js");
      const { name, absPath } = resolveVaultPath(args.ref);

      let realKey: string;
      let realValue: string;

      if ((args.value === undefined || args.value === "") && args.key.includes("=")) {
        const eqIdx = args.key.indexOf("=");
        realKey = args.key.slice(0, eqIdx);
        realValue = args.key.slice(eqIdx + 1);
      } else {
        realKey = args.key;
        realValue = args.value ?? "";
      }

      setKey(absPath, realKey, realValue, args.comment);
      output("vault-set", { ref: `vault:${name}`, key: realKey, path: absPath });
    });
  },
});

const vaultUnsetCommand = defineCommand({
  meta: { name: "unset", description: "Remove a key from a vault" },
  args: {
    ref: { type: "positional", description: "Vault ref", required: true },
    key: { type: "positional", description: "Key name to remove", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { unsetKey } = await import("./vault.js");
      const { name, absPath } = resolveVaultPath(args.ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Vault not found: vault:${name}`);
      }
      const removed = unsetKey(absPath, args.key);
      output("vault-unset", { ref: `vault:${name}`, key: args.key, removed, path: absPath });
    });
  },
});

const vaultLoadCommand = defineCommand({
  meta: {
    name: "load",
    description:
      'Emit a shell snippet that loads vault values into the current shell. Use: eval "$(akm vault load vault:<name>)". Values are parsed by dotenv, written to a mode-0600 temp file with safe single-quote escaping, then sourced and removed. No values appear on akm\'s stdout, and no shell expansion happens on raw vault content.',
  },
  args: {
    ref: { type: "positional", description: "Vault ref", required: true },
  },
  async run({ args }) {
    return runWithJsonErrors(async () => {
      // This command deliberately bypasses output()/JSON shaping. Its stdout
      // is a shell snippet intended for `eval`, not structured output.
      const { name, absPath } = resolveVaultPath(args.ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Vault not found: vault:${name}`);
      }

      const { buildShellExportScript } = await import("./vault.js");
      const crypto = await import("node:crypto");
      const os = await import("node:os");

      // Parse via dotenv (no expansion, no code execution) and build a
      // script of literal `export KEY='value'` lines with `'\''` escaping.
      // Sourcing this is safe even if the raw vault file contained shell
      // metacharacters like $, backticks, or $(...).
      const script = buildShellExportScript(absPath);

      // Write to a mode-0600 temp file the shell can source.
      const tmpPath = path.join(os.tmpdir(), `akm-vault-${crypto.randomBytes(12).toString("hex")}.sh`);
      fs.writeFileSync(tmpPath, script, { mode: 0o600, encoding: "utf8" });
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch {
        /* best-effort on platforms without chmod */
      }

      const quotedTmp = `'${tmpPath.replace(/'/g, "'\\''")}'`;
      // Emit: source the temp file, then remove it — values reach bash only
      // via the temp file (mode 0600), never via akm's stdout.
      process.stdout.write(`. ${quotedTmp}; rm -f ${quotedTmp}\n`);
    });
  },
});

const vaultShowCommand = defineCommand({
  meta: { name: "show", description: "Show keys (no values) inside a vault — alias for `vault list <ref>`" },
  args: {
    ref: { type: "positional", description: "Vault ref (e.g. vault:prod or just prod)", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { listKeys } = await import("./vault.js");
      const { name, absPath } = resolveVaultPath(args.ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Vault not found: vault:${name}`);
      }
      const { keys, comments } = listKeys(absPath);
      output("vault-list", { ref: `vault:${name}`, path: absPath, keys, comments });
    });
  },
});

const vaultCommand = defineCommand({
  meta: {
    name: "vault",
    description:
      "Manage secret vaults (.env files). Lists keys + comments only — values never returned in structured output.",
  },
  subCommands: {
    list: vaultListCommand,
    show: vaultShowCommand,
    create: vaultCreateCommand,
    set: vaultSetCommand,
    unset: vaultUnsetCommand,
    load: vaultLoadCommand,
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      if (hasVaultSubcommand(args)) return;
      // Default action: list all vaults
      const { listKeys } = await import("./vault.js");
      output("vault-list", { vaults: listVaultsRecursive(listKeys) });
    });
  },
});

// ── Wiki subcommands ─────────────────────────────────────────────────────────

const wikiCreateCommand = defineCommand({
  meta: { name: "create", description: "Scaffold a new wiki under <stashDir>/wikis/<name>/" },
  args: {
    name: { type: "positional", description: "Wiki name (lowercase, digits, hyphens)", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { createWiki } = await import("./wiki.js");
      const stashDir = resolveStashDir();
      const result = createWiki(stashDir, args.name);
      output("wiki-create", result);
    });
  },
});

const wikiRegisterCommand = defineCommand({
  meta: {
    name: "register",
    description:
      "Register an existing directory or repo as a first-class wiki without copying or mutating it; refreshes source and wiki search state immediately",
  },
  args: {
    name: { type: "positional", description: "Wiki name (lowercase, digits, hyphens)", required: true },
    ref: { type: "positional", description: "Path or repo ref for the external wiki source", required: true },
    writable: {
      type: "boolean",
      description: "Mark a git-backed source as writable so changes can be pushed back",
      default: false,
    },
    trust: {
      type: "boolean",
      description: "Bypass install-audit blocking for this registration only",
      default: false,
    },
    "max-pages": { type: "string", description: "Maximum pages to crawl for website sources (default: 50)" },
    "max-depth": { type: "string", description: "Maximum crawl depth for website sources (default: 3)" },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { registerWikiSource } = await import("./stash-add");
      const result = await registerWikiSource({
        ref: args.ref.trim(),
        name: args.name,
        options: Object.keys(buildWebsiteOptions(args)).length > 0 ? buildWebsiteOptions(args) : undefined,
        trustThisInstall: args.trust,
        writable: args.writable,
      });
      output("wiki-register", result);
    });
  },
});

const wikiListCommand = defineCommand({
  meta: { name: "list", description: "List wikis with page/raw counts and last-modified timestamps" },
  run() {
    return runWithJsonErrors(async () => {
      const { listWikis } = await import("./wiki.js");
      const stashDir = resolveStashDir();
      const wikis = listWikis(stashDir);
      output("wiki-list", { wikis });
    });
  },
});

const wikiShowCommand = defineCommand({
  meta: { name: "show", description: "Show a wiki's path, description, counts, and last 3 log entries" },
  args: {
    name: { type: "positional", description: "Wiki name", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { showWiki } = await import("./wiki.js");
      const stashDir = resolveStashDir();
      const result = showWiki(stashDir, args.name);
      output("wiki-show", result);
    });
  },
});

const wikiRemoveCommand = defineCommand({
  meta: {
    name: "remove",
    description:
      "Remove a wiki and refresh the index. Preserves raw/ by default; pass --with-sources to also delete raw/",
  },
  args: {
    name: { type: "positional", description: "Wiki name", required: true },
    force: {
      type: "boolean",
      description: "Remove without prompting (required in non-interactive shells)",
      default: false,
    },
    "with-sources": {
      type: "boolean",
      description: "Also delete the raw/ directory (immutable ingested sources)",
      default: false,
    },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      if (!args.force) {
        throw new UsageError("Refusing to remove without --force. Pass `--force` to confirm.");
      }
      const withSources = Boolean((args as Record<string, unknown>)["with-sources"]);
      const { removeWiki } = await import("./wiki.js");
      const { akmIndex } = await import("./indexer");
      const stashDir = resolveStashDir();
      const result = removeWiki(stashDir, args.name, { withSources });
      await akmIndex({ stashDir });
      output("wiki-remove", result);
    });
  },
});

const wikiPagesCommand = defineCommand({
  meta: {
    name: "pages",
    description: "List wiki pages (ref + frontmatter description), excluding schema/index/log/raw",
  },
  args: {
    name: { type: "positional", description: "Wiki name", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { listPages } = await import("./wiki.js");
      const stashDir = resolveStashDir();
      const pages = listPages(stashDir, args.name);
      output("wiki-pages", { wiki: args.name, pages });
    });
  },
});

const wikiSearchCommand = defineCommand({
  meta: {
    name: "search",
    description:
      "Search wiki pages within a single wiki (scoped wrapper over `akm search --type wiki`; excludes raw/schema/index/log and returns canonical wiki refs)",
  },
  args: {
    name: { type: "positional", description: "Wiki name", required: true },
    query: { type: "positional", description: "Search query", required: true },
    limit: { type: "string", description: "Max hits (default 20)", required: false },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { resolveWikiSource, searchInWiki } = await import("./wiki.js");
      const stashDir = resolveStashDir();
      resolveWikiSource(stashDir, args.name);
      const parsedLimit = args.limit ? Number(args.limit) : undefined;
      const limit =
        typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;
      const response = await searchInWiki({ stashDir, wikiName: args.name, query: args.query, limit });
      output("search", response);
    });
  },
});

const wikiStashCommand = defineCommand({
  meta: {
    name: "stash",
    description:
      "Copy a source into wikis/<name>/raw/<slug>.md with frontmatter. Source may be a file path or '-' for stdin.",
  },
  args: {
    name: { type: "positional", description: "Wiki name", required: true },
    source: { type: "positional", description: "Source file path, or '-' to read from stdin", required: true },
    as: { type: "string", description: "Preferred slug base (defaults to source filename or first-line slug)" },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { stashRaw } = await import("./wiki.js");
      const { content, preferredName } = readKnowledgeContent(args.source);
      const stashDir = resolveStashDir();
      const result = stashRaw({
        stashDir,
        wikiName: args.name,
        content,
        preferredName: args.as ?? preferredName,
        explicitSlug: args.as !== undefined,
      });
      output("wiki-stash", { ok: true, wiki: args.name, source: args.source, ...result });
    });
  },
});

const wikiLintCommand = defineCommand({
  meta: {
    name: "lint",
    description: "Structural lint for a wiki: orphans, broken xrefs, missing descriptions, uncited raws, stale index",
  },
  args: {
    name: { type: "positional", description: "Wiki name", required: true },
  },
  async run({ args }) {
    let findingCount = 0;
    await runWithJsonErrors(async () => {
      const { lintWiki } = await import("./wiki.js");
      const stashDir = resolveStashDir();
      const report = lintWiki(stashDir, args.name);
      output("wiki-lint", report);
      findingCount = report.findings.length;
    });
    if (findingCount > 0) process.exit(1); // EXIT_GENERAL
  },
});

const wikiIngestCommand = defineCommand({
  meta: {
    name: "ingest",
    description: "Print the ingest workflow for this wiki. Does not perform the ingest; instructs the agent to.",
  },
  args: {
    name: { type: "positional", description: "Wiki name", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { buildIngestWorkflow } = await import("./wiki.js");
      const stashDir = resolveStashDir();
      const result = buildIngestWorkflow(stashDir, args.name);
      output("wiki-ingest", result);
    });
  },
});

const wikiCommand = defineCommand({
  meta: {
    name: "wiki",
    description:
      "Manage multiple markdown wikis (Karpathy-style). akm surfaces (lifecycle, raw/, lint, index); the agent writes pages.",
  },
  subCommands: {
    create: wikiCreateCommand,
    register: wikiRegisterCommand,
    list: wikiListCommand,
    show: wikiShowCommand,
    remove: wikiRemoveCommand,
    pages: wikiPagesCommand,
    search: wikiSearchCommand,
    stash: wikiStashCommand,
    lint: wikiLintCommand,
    ingest: wikiIngestCommand,
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      if (hasWikiSubcommand(args)) return;
      // Default action: list wikis
      const { listWikis } = await import("./wiki.js");
      output("wiki-list", { wikis: listWikis(resolveStashDir()) });
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
    format: { type: "string", description: "Output format (json|jsonl|text|yaml)" },
    detail: { type: "string", description: "Detail level (brief|normal|full|summary)" },
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
    workflow: workflowCommand,
    remember: rememberCommand,
    import: importKnowledgeCommand,
    save: saveCommand,
    clone: cloneCommand,
    registry: registryCommand,
    config: configCommand,
    enable: enableCommand,
    disable: disableCommand,
    feedback: feedbackCommand,
    help: helpCommand,
    hints: hintsCommand,
    completions: completionsCommand,
    vault: vaultCommand,
    wiki: wikiCommand,
  },
});

const CONFIG_SUBCOMMAND_SET = new Set(["path", "list", "get", "set", "unset"]);
const VAULT_SUBCOMMAND_SET = new Set(["list", "show", "create", "set", "unset", "load"]);
const WIKI_SUBCOMMAND_SET = new Set(["create", "list", "show", "remove", "pages", "search", "stash", "lint", "ingest"]);
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

function hasVaultSubcommand(args: Record<string, unknown>): boolean {
  const command = Array.isArray(args._) ? args._[0] : undefined;
  return typeof command === "string" && VAULT_SUBCOMMAND_SET.has(command);
}

function hasWikiSubcommand(args: Record<string, unknown>): boolean {
  const command = Array.isArray(args._) ? args._[0] : undefined;
  return typeof command === "string" && WIKI_SUBCOMMAND_SET.has(command);
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
    const docsPath = path.resolve(import.meta.dir ?? __dirname, `../docs/agents/${filename}`);
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

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, workflows, wikis, and memories via \`akm\`. Search your sources first before writing something from scratch.

## Quick Reference

\`\`\`sh
akm search "<query>"                          # Search all sources
akm curate "<task>"                          # Curate the best matches for a task
akm search "<query>" --type workflow          # Filter to workflow assets
akm search "<query>" --source both            # Also search registries
akm show <ref>                                # View asset details
akm workflow next <ref>                       # Start or resume a workflow
akm remember "Deployment needs VPN access"    # Record a memory in your stash
akm import ./notes/release-checklist.md       # Import a knowledge doc into your stash
akm wiki list                                 # List available wikis
akm wiki ingest <name>                        # Print the ingest workflow for a wiki
akm feedback <ref> --positive|--negative      # Record whether an asset helped
akm add <ref>                                 # Add a source (npm, GitHub, git, local dir)
akm clone <ref>                               # Copy an asset to the working stash (optional --dest arg to clone to specific location)
akm save                                      # Commit (and push if writable remote) changes in the primary stash
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
| workflow | Parsed steps plus workflow-specific execution commands |
| memory | Recalled context (read the content for background information) |
| vault | Key names only; use vault commands to inspect or load values safely |
| wiki | A page in a multi-wiki knowledge base. For any wiki task, start with \`akm wiki list\`, then \`akm wiki ingest <name>\` for the workflow. Run \`akm wiki -h\` for the full surface. |

When an asset meaningfully helps or fails, record that with \`akm feedback\` so
future search ranking can learn from real usage.

Run \`akm -h\` for the full command reference.
`;

const EMBEDDED_HINTS_FULL = `# akm CLI — Full Reference

You have access to a searchable library of scripts, skills, commands, agents, knowledge documents, workflows, wikis, and memories via \`akm\`. Search your sources first before writing something from scratch.

## Search

\`\`\`sh
akm search "<query>"                          # Search all sources
akm curate "<task>"                          # Curate the best matches for a task
akm search "<query>" --type workflow          # Filter by asset type
akm search "<query>" --source both            # Also search registries
akm search "<query>" --source registry        # Search registries only
akm search "<query>" --limit 10               # Limit results
akm search "<query>" --detail full            # Include scores, paths, timing
\`\`\`

| Flag | Values | Default |
| --- | --- | --- |
| \`--type\` | \`skill\`, \`command\`, \`agent\`, \`knowledge\`, \`workflow\`, \`script\`, \`memory\`, \`vault\`, \`wiki\`, \`any\` | \`any\` |
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
akm curate "review architecture" --type workflow # Restrict to one asset type
\`\`\`

## Show

Display an asset by ref. Knowledge assets support view modes as positional arguments.

\`\`\`sh
akm show script:deploy.sh                     # Show script (returns run command)
akm show skill:code-review                    # Show skill (returns full content)
akm show command:release                      # Show command (returns template)
akm show agent:architect                      # Show agent (returns system prompt)
akm show workflow:ship-release                # Show parsed workflow steps
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
| workflow | \`workflowTitle\`, \`workflowParameters\`, \`steps\` |
| memory | \`content\` (recalled context) |
| vault | \`keys\`, \`comments\` |
| wiki | \`content\` (same view modes as knowledge). For any wiki task, run \`akm wiki list\` then \`akm wiki ingest <name>\` for the workflow. |

## Capture Knowledge While You Work

\`\`\`sh
akm remember "Deployment needs VPN access"     # Record a memory in your stash
akm remember --name release-retro < notes.md   # Save multiline memory from stdin
akm import ./docs/auth-flow.md                 # Import a file as knowledge
akm import - --name scratch-notes < notes.md   # Import stdin as a knowledge doc
akm workflow create ship-release               # Create a workflow asset in the stash
akm workflow next workflow:ship-release        # Start or resume the next workflow step
akm feedback skill:code-review --positive      # Record that an asset helped
akm feedback agent:reviewer --negative         # Record that an asset missed the mark
\`\`\`

Use \`akm feedback\` whenever an asset materially helps or fails so future search
ranking can learn from actual usage.

## Wikis

Multi-wiki knowledge bases (Karpathy-style). A stash-owned wiki lives at
\`<stashDir>/wikis/<name>/\`; external directories or repos can also be registered
as first-class wikis. akm owns lifecycle + raw-slug + lint + index regeneration
for stash-owned wikis; page edits use your native Read/Write/Edit tools.

\`\`\`sh
akm wiki list                                  # List wikis (name, pages, raws, last-modified)
akm wiki create research                       # Scaffold a new wiki
akm wiki register ics-docs ~/code/ics-documentation # Register an external wiki
akm wiki show research                         # Path, description, counts, last 3 log entries
akm wiki pages research                        # Page refs + descriptions (excludes schema/index/log/raw)
akm wiki search research "attention"           # Scoped search (equivalent to --type wiki --wiki research)
akm wiki stash research ./paper.md             # Copy source into raw/<slug>.md (never overwrites)
echo "..." | akm wiki stash research -         # stdin form
akm wiki lint research                         # Structural checks: orphans, broken xrefs, uncited raws, stale index
akm wiki ingest research                       # Print the ingest workflow for this wiki (no action)
akm wiki remove research --force               # Delete pages/schema/index/log; preserves raw/
akm wiki remove research --force --with-sources # Full nuke, including raw/
\`\`\`

**For any wiki task, start with \`akm wiki list\`, then \`akm wiki ingest <name>\`
to get the step-by-step workflow.** Wiki pages are also addressable as
\`wiki:<name>/<page-path>\` and show up in stash-wide \`akm search\` as
\`type: wiki\`. Files under \`raw/\` and the wiki root infrastructure files
\`schema.md\`, \`index.md\`, and \`log.md\` are not indexed and do not appear in
search results. No \`--llm\` anywhere — akm never reasons about page content.

## Vaults

Encrypted-at-rest key/value stores for secrets. Each vault is a \`.env\`-format
file at \`<stashDir>/vaults/<name>.env\`.

\`\`\`sh
akm vault create prod                         # Create a new vault
akm vault set prod DB_URL postgres://...      # Set a key (or KEY=VALUE combined form)
akm vault set prod DB_URL=postgres://...      # Combined KEY=VALUE form also works
akm vault unset prod DB_URL                   # Remove a key
akm vault list vault:prod                     # List key names (no values)
akm vault show vault:prod                     # Same as list (alias)
akm vault load vault:prod                     # Print export statements to source
\`\`\`

## Workflows

Step-based workflows stored as \`<stashDir>/workflows/<name>.md\`.

\`\`\`sh
akm workflow template                         # Print a starter workflow template
akm workflow create ship-release             # Scaffold a new workflow asset
akm workflow start workflow:ship-release     # Start a new run
akm workflow next workflow:ship-release      # Advance to the next step (or auto-start)
akm workflow complete <run-id>               # Mark a step complete and advance
akm workflow status <run-id>                 # Show current run status
akm workflow resume <run-id>                 # Resume a blocked or failed run
akm workflow list                            # List all workflow runs
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

## Save

Commit local changes in a git-backed stash. Behaviour adapts automatically:

- **Not a git repo** — no-op (silent skip)
- **Git repo, no remote** — stage and commit only (the default stash always falls here)
- **Git repo, has remote, not writable** — stage and commit only
- **Git repo, has remote, \`writable: true\`** — stage, commit, and push

\`\`\`sh
akm save                                      # Save primary stash (timestamp message)
akm save -m "Add deploy skill"               # Save with explicit message
akm save my-skills                            # Save a named writable git stash
akm save my-skills -m "Update patterns"      # Save named stash with message
\`\`\`

The \`--writable\` flag on \`akm add\` opts a remote git stash into push-on-save:

\`\`\`sh
akm add git@github.com:org/skills.git --provider git --name my-skills --writable
\`\`\`

## Add & Manage Sources

\`\`\`sh
akm add <ref>                                 # Add a source
akm add @scope/kit                            # From npm (managed)
akm add owner/repo                            # From GitHub (managed)
akm add ./path/to/local/kit                   # Local directory
akm add git@github.com:org/repo.git --provider git --name my-skills --writable
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
akm upgrade                                   # Upgrade akm using its install method
akm upgrade --check                           # Check for updates
akm help migrate 0.5.0                        # Print migration notes for a release
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
