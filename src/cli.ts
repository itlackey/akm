#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { defineCommand, runMain } from "citty";
import { resolveStashDir } from "./common";
import { getConfigPath, loadConfig, saveConfig } from "./config";
import { getConfigValue, listConfig, setConfigValue, unsetConfigValue } from "./config-cli";
import { ConfigError, NotFoundError, UsageError } from "./errors";
import { agentikitIndex } from "./indexer";
import { agentikitInit } from "./init";
import { getCacheDir, getDbPath, getDefaultStashDir } from "./paths";
import { checkForUpdate, performUpgrade } from "./self-update";
import { agentikitAdd } from "./stash-add";
import { agentikitClone } from "./stash-clone";
import { agentikitList, agentikitRemove, agentikitUpdate } from "./stash-registry";
import { agentikitSearch } from "./stash-search";
import { agentikitShow } from "./stash-show";
import { resolveStashSources } from "./stash-source";
import type { KnowledgeView, SearchSource } from "./stash-types";
import { setQuiet, warn } from "./warn";

// Version: prefer compile-time define, then package.json, then fallback
const pkgVersion: string = (() => {
  // Injected at compile time via `bun build --define`
  if (typeof AKM_VERSION !== "undefined") return AKM_VERSION;
  try {
    const pkgPath = path.resolve(import.meta.dir ?? __dirname, "../package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    }
  } catch {
    // swallow — running as compiled binary without package.json
  }
  return "0.0.0-dev";
})();

// Declared by `bun build --define` at compile time; unused at dev time.
declare const AKM_VERSION: string;

type OutputFormat = "json" | "yaml" | "text";
type DetailLevel = "brief" | "normal" | "full";

interface OutputMode {
  format: OutputFormat;
  detail: DetailLevel;
}

const OUTPUT_FORMATS: OutputFormat[] = ["json", "yaml", "text"];
const DETAIL_LEVELS: DetailLevel[] = ["brief", "normal", "full"];
const BRIEF_DESCRIPTION_LIMIT = 160;

/** Bun >= 1.2 exposes Bun.YAML; declared locally until bun-types ships it */
interface BunWithYAML {
  YAML: { stringify(value: unknown): string };
}

function hasBunYAML(b: typeof Bun): b is typeof Bun & BunWithYAML {
  // biome-ignore lint/suspicious/noExplicitAny: type guard for runtime feature detection
  return typeof (b as any).YAML?.stringify === "function";
}

/** Try Bun.YAML.stringify; fall back to JSON if the API is unavailable */
function yamlStringify(obj: unknown): string {
  if (hasBunYAML(Bun)) {
    return Bun.YAML.stringify(obj);
  }
  warn("YAML output not available, using JSON");
  return JSON.stringify(obj, null, 2);
}

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

function resolveOutputMode(): OutputMode {
  const config = loadConfig();
  const format = parseOutputFormat(parseFlagValue("--format")) ?? config.output?.format ?? "json";
  const detail = parseDetailLevel(parseFlagValue("--detail")) ?? config.output?.detail ?? "brief";
  return { format, detail };
}

function output(command: string, result: unknown): void {
  const mode = resolveOutputMode();
  const shaped = shapeForCommand(command, result, mode.detail);

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

function shapeForCommand(command: string, result: unknown, detail: DetailLevel): unknown {
  switch (command) {
    case "search":
      return shapeSearchOutput(result as Record<string, unknown>, detail);
    case "show":
      return shapeShowOutput(result as Record<string, unknown>, detail);
    default:
      return result;
  }
}

function shapeSearchOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const hits = Array.isArray(result.hits) ? (result.hits as Record<string, unknown>[]) : [];
  const shapedHits = hits.map((hit) => shapeSearchHit(hit, detail));

  if (detail === "full") {
    return {
      schemaVersion: result.schemaVersion,
      stashDir: result.stashDir,
      source: result.source,
      hits: shapedHits,
      ...(result.tip ? { tip: result.tip } : {}),
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(result.timing ? { timing: result.timing } : {}),
    };
  }

  return {
    hits: shapedHits,
    ...(result.tip ? { tip: result.tip } : {}),
    ...(Array.isArray(result.warnings) && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };
}

function shapeSearchHit(hit: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  // Keep local and registry hit models separate internally so search and
  // ranking logic can carry source-specific metadata. Normalize the external
  // contract here so default CLI output stays compact and consistent.
  if (hit.type === "registry") {
    const brief = withTruncatedDescription(pickFields(hit, ["type", "name", "id", "description", "action", "curated"]));
    if (detail === "brief") return brief;
    if (detail === "normal") return pickFields(hit, ["type", "name", "id", "description", "tags", "action", "curated"]);
    return hit;
  }

  const brief = withTruncatedDescription(pickFields(hit, ["type", "name", "description", "action"]));
  if (detail === "brief") return brief;
  if (detail === "normal") {
    return pickFields(hit, ["type", "name", "ref", "origin", "description", "tags", "size", "action", "run"]);
  }
  return hit;
}

function withTruncatedDescription(hit: Record<string, unknown>): Record<string, unknown> {
  if (typeof hit.description !== "string") return hit;
  return {
    ...hit,
    description: truncateDescription(hit.description, BRIEF_DESCRIPTION_LIMIT),
  };
}

function truncateDescription(description: string, limit: number): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;

  const truncated = normalized.slice(0, limit - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  const safe = lastSpace >= Math.floor(limit * 0.6) ? truncated.slice(0, lastSpace) : truncated;
  return `${safe.trimEnd()}...`;
}

function shapeShowOutput(result: Record<string, unknown>, detail: DetailLevel): Record<string, unknown> {
  const base = pickFields(result, [
    "type",
    "name",
    "origin",
    "action",
    "description",
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
      return `Indexed ${r.totalEntries ?? 0} entries from ${r.directoriesScanned ?? 0} directories (mode: ${r.mode ?? "unknown"})`;
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
    case "add": {
      const index = r.index as Record<string, unknown> | undefined;
      const scanned = index?.directoriesScanned ?? 0;
      const total = index?.totalEntries ?? 0;
      return `Installed ${r.ref} (${scanned} directories scanned, ${total} total assets indexed)`;
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

  if (hits.length === 0) {
    return r.tip ? String(r.tip) : "No results found.";
  }

  const lines: string[] = [];

  for (const hit of hits) {
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

const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize Agent-i-Kit's working stash directory and persist stashDir in config",
  },
  args: {
    dir: { type: "string", description: "Custom stash directory path (default: ~/akm)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitInit({ dir: args.dir });
      output("init", result);
    });
  },
});

const indexCommand = defineCommand({
  meta: { name: "index", description: "Build search index (incremental by default; --full forces full reindex)" },
  args: {
    full: { type: "boolean", description: "Force full reindex", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitIndex({ full: args.full });
      output("index", result);
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
        "Asset type filter (skill|command|agent|knowledge|script|any). 'tool' is accepted as alias for 'script'.",
    },
    limit: { type: "string", description: "Maximum number of results" },
    source: { type: "string", description: "Search source (local|registry|both)", default: "local" },
    format: { type: "string", description: "Output format (json|text|yaml)" },
    detail: { type: "string", description: "Detail level (brief|normal|full)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const type = args.type as "tool" | "skill" | "command" | "agent" | "knowledge" | "script" | "any" | undefined;
      const limit = args.limit ? parseInt(args.limit, 10) : undefined;
      const source = parseSearchSource(args.source);
      const result = await agentikitSearch({ query: args.query, type, limit, source });
      output("search", result);
    });
  },
});

const addCommand = defineCommand({
  meta: { name: "add", description: "Install a kit from npm, GitHub, any git host, or a local directory" },
  args: {
    ref: {
      type: "positional",
      description: "Registry ref (npm package, owner/repo, git URL, or local directory)",
      required: true,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitAdd({ ref: args.ref });
      output("add", result);
    });
  },
});

const listCommand = defineCommand({
  meta: { name: "list", description: "List installed registry packages from config" },
  async run() {
    await runWithJsonErrors(async () => {
      const result = await agentikitList();
      output("list", result);
    });
  },
});

const removeCommand = defineCommand({
  meta: { name: "remove", description: "Remove an installed registry package by id or ref" },
  args: {
    target: { type: "positional", description: "Installed target (id or ref)", required: true },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitRemove({ target: args.target });
      output("remove", result);
    });
  },
});

const updateCommand = defineCommand({
  meta: { name: "update", description: "Update one or all installed registry packages" },
  args: {
    target: { type: "positional", description: "Installed target (id or ref)", required: false },
    all: { type: "boolean", description: "Update all installed entries", default: false },
    force: { type: "boolean", description: "Force fresh download even if version is unchanged", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitUpdate({ target: args.target, all: args.all, force: args.force });
      output("update", result);
    });
  },
});

const upgradeCommand = defineCommand({
  meta: { name: "upgrade", description: "Upgrade akm to the latest release" },
  args: {
    check: { type: "boolean", description: "Check for updates without installing", default: false },
    force: { type: "boolean", description: "Force upgrade even if on latest", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const check = await checkForUpdate(pkgVersion);
      if (args.check) {
        output("upgrade", check);
        return;
      }
      const result = await performUpgrade(check, { force: args.force });
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
    format: { type: "string", description: "Output format (json|text|yaml)" },
    detail: { type: "string", description: "Detail level (brief|normal|full)" },
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
      const result = await agentikitShow({ ref: args.ref, view });
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
          const updated = setConfigValue(loadConfig(), args.key, args.value);
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
          const updated = unsetConfigValue(loadConfig(), args.key);
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
    description: "Clone an asset from any stash source into the working stash or a custom destination",
  },
  args: {
    ref: { type: "positional", description: "Asset ref (e.g. @installed:pkg/tool:script.sh)", required: true },
    name: { type: "string", description: "New name for the cloned asset" },
    force: { type: "boolean", description: "Overwrite if asset already exists in working stash", default: false },
    dest: { type: "string", description: "Destination directory (default: working stash)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await agentikitClone({
        sourceRef: args.ref,
        newName: args.name,
        force: args.force,
        dest: args.dest,
      });
      output("clone", result);
    });
  },
});

const sourcesCommand = defineCommand({
  meta: { name: "sources", description: "List all stash search paths and their status" },
  run() {
    return runWithJsonErrors(() => {
      const sources = resolveStashSources();
      output("sources", { sources });
    });
  },
});

const main = defineCommand({
  meta: {
    name: "akm",
    version: pkgVersion,
    description: "CLI tool to search, open, and manage assets from Agent-i-Kit stash.",
  },
  args: {
    format: { type: "string", description: "Output format (json|text|yaml)" },
    detail: { type: "string", description: "Detail level (brief|normal|full)" },
    quiet: { type: "boolean", alias: "q", description: "Suppress stderr warnings", default: false },
  },
  subCommands: {
    init: initCommand,
    index: indexCommand,
    add: addCommand,
    list: listCommand,
    remove: removeCommand,
    update: updateCommand,
    upgrade: upgradeCommand,
    search: searchCommand,
    show: showCommand,
    clone: cloneCommand,
    sources: sourcesCommand,
    config: configCommand,
  },
});

const SEARCH_SOURCES: SearchSource[] = ["local", "registry", "both"];
const CONFIG_SUBCOMMAND_SET = new Set(["path", "list", "get", "set", "unset"]);
const SHOW_VIEW_MODES = new Set(["toc", "frontmatter", "full", "section", "lines"]);

// citty reads process.argv directly and does not accept a custom argv array,
// so we must replace process.argv with the normalized version before runMain.
process.argv = normalizeShowArgv(process.argv);
runMain(main);

function parseSearchSource(value: string): SearchSource {
  if ((SEARCH_SOURCES as string[]).includes(value)) return value as SearchSource;
  throw new UsageError(`Invalid value for --source: ${value}. Expected one of: ${SEARCH_SOURCES.join("|")}`);
}

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
  if (message.includes("No installed registry entry matched target"))
    return "Run `akm list` to view installed ids/refs, then retry with one of those values.";
  if (message.includes("remote package fetched but asset not found"))
    return "The remote package was fetched but doesn't contain the requested asset. Check the asset name and type.";
  if (message.includes("Invalid value for --source")) return "Pick one of: local, registry, both.";
  if (message.includes("Invalid value for --format")) return "Pick one of: json, text, yaml.";
  if (message.includes("Invalid value for --detail")) return "Pick one of: brief, normal, full.";
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
    if (arg === "--quiet" || arg === "-q") {
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
