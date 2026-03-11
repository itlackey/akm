#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { defineCommand, runMain } from "citty";
import { resolveStashDir } from "./common";
import { getConfigPath, loadConfig, saveConfig } from "./config";
import {
  getConfigValue,
  listConfig,
  parseConfigValue,
  setConfigValue,
  unsetConfigValue,
} from "./config-cli";
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
import type { KnowledgeView, SearchSource, SearchUsageMode } from "./stash-types";
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

/** Check whether --json flag is present in argv */
function isJsonMode(): boolean {
  return process.argv.includes("--json");
}

/** Check whether --verbose / -v flag is present in argv */
function isVerboseMode(): boolean {
  return process.argv.includes("--verbose") || process.argv.includes("-v");
}

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

/** Output result: JSON if --json flag set, otherwise YAML (default) */
function output(command: string, result: unknown): void {
  const verbose = isVerboseMode();
  if (isJsonMode()) {
    const cleaned = command === "search" ? stripVerboseSearchFields(result, verbose) : result;
    console.log(JSON.stringify(cleaned, null, 2));
    return;
  }
  // Some commands output plain text messages rather than structured data
  const plain = formatPlain(command, result, verbose);
  if (plain != null) {
    console.log(plain);
    return;
  }
  console.log(yamlStringify(result));
}

/**
 * Return a plain-text string for commands that are better as short messages,
 * or null to fall through to YAML output.
 */
function formatPlain(command: string, result: unknown, verbose = false): string | null {
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
      if (r.content != null) return String(r.content);
      if (r.run != null) return String(r.run);
      if (r.prompt != null) return String(r.prompt);
      return null; // fall through to YAML
    }
    case "search": {
      return formatSearchPlain(r, verbose);
    }
    case "add": {
      const installed = r.installed as Record<string, unknown> | undefined;
      const indexed = installed?.indexed ?? r.indexed ?? 0;
      return `Installed ${r.ref} (${indexed} assets indexed)`;
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

/**
 * Strip verbose-only fields from search results when not in verbose/json mode.
 * Returns a cleaned copy; the original is not modified.
 */
function stripVerboseSearchFields(result: unknown, verbose: boolean): unknown {
  if (verbose) return result;
  const r = result as Record<string, unknown>;
  const { timing, ...rest } = r;
  const hits = (rest.hits as Record<string, unknown>[]) ?? [];
  rest.hits = hits.map((hit) => {
    const { whyMatched, editable, editHint, hitSource, ...cleanHit } = hit;
    return cleanHit;
  });
  return rest;
}

/**
 * Format search results as plain text.
 * Default mode: type, name, description, score, run command.
 * Verbose mode: adds hitSource, whyMatched, editable, editHint, timing.
 */
function formatSearchPlain(r: Record<string, unknown>, verbose: boolean): string {
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

    if (hit.run) lines.push(`  run: ${hit.run}`);
    if (hit.openRef) lines.push(`  ref: ${hit.openRef}`);
    if (hit.installCmd) lines.push(`  install: ${hit.installCmd}`);

    if (verbose) {
      if (hit.hitSource) lines.push(`  source: ${hit.hitSource}`);
      if (hit.editable != null) lines.push(`  editable: ${hit.editable}`);
      if (hit.editHint) lines.push(`  editHint: ${hit.editHint}`);
      const whyMatched = hit.whyMatched as string[] | undefined;
      if (whyMatched && whyMatched.length > 0) {
        lines.push(`  whyMatched: ${whyMatched.join(", ")}`);
      }
    }

    lines.push(""); // blank line between hits
  }

  if (verbose && r.timing) {
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
    dir: { type: "string", description: "Custom stash directory path (default: ~/agentikit)" },
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
    query: { type: "positional", description: "Search query", required: false, default: "" },
    type: { type: "string", description: "Asset type filter (tool|skill|command|agent|knowledge|script|any)" },
    limit: { type: "string", description: "Maximum number of results" },
    usage: { type: "string", description: "Usage metadata mode (none|both|item|guide)", default: "both" },
    source: { type: "string", description: "Search source (local|registry|both)", default: "local" },
    verbose: { type: "boolean", alias: "v", description: "Show detailed match information", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const type = args.type as "tool" | "skill" | "command" | "agent" | "knowledge" | "script" | "any" | undefined;
      const limit = args.limit ? parseInt(args.limit, 10) : undefined;
      const usage = parseSearchUsageMode(args.usage);
      const source = parseSearchSource(args.source);
      const result = await agentikitSearch({ query: args.query, type, limit, usage, source });
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
  meta: { name: "show", description: "Show a stash asset by ref (e.g. agent:bunjs-typescript-coder.md)" },
  args: {
    ref: { type: "positional", description: "Asset ref (type:name)", required: true },
    view: { type: "string", description: "Knowledge view mode (full|toc|frontmatter|section|lines)" },
    heading: { type: "string", description: "Section heading (for --view section)" },
    start: { type: "string", description: "Start line (for --view lines)" },
    end: { type: "string", description: "End line (for --view lines)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      let view: KnowledgeView | undefined;
      if (args.view) {
        switch (args.view) {
          case "section":
            view = { mode: "section", heading: args.heading ?? "" };
            break;
          case "lines":
            view = {
              mode: "lines",
              start: Number(args.start ?? "1"),
              end: args.end ? parseInt(args.end, 10) : Number.MAX_SAFE_INTEGER,
            };
            break;
          case "toc":
          case "frontmatter":
          case "full":
            view = { mode: args.view };
            break;
          default:
            throw new UsageError(
              `Unknown view mode: ${args.view}. Expected one of: full|toc|frontmatter|section|lines`,
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
    get: { type: "string", description: "Get a configuration value by key" },
    unset: { type: "string", description: "Unset an optional configuration key or whole embedding/llm section" },
    set: { type: "string", description: "Back-compat alias for updating a key (key=value format)" },
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
              stashDir = getDefaultStashDir() + " (not initialized)";
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
      if (args.get) {
        output("config", getConfigValue(loadConfig(), args.get));
        return;
      }
      if (args.unset) {
        const updated = unsetConfigValue(loadConfig(), args.unset);
        saveConfig(updated);
        output("config", listConfig(updated));
        return;
      }
      if (args.set) {
        const eqIndex = args.set.indexOf("=");
        if (eqIndex === -1) {
          throw new UsageError("--set expects key=value format");
        }
        const key = args.set.slice(0, eqIndex);
        const value = args.set.slice(eqIndex + 1);
        const partial = parseConfigValue(key, value);
        const config = { ...loadConfig(), ...partial };
        saveConfig(config);
        output("config", listConfig(config));
      } else {
        output("config", listConfig(loadConfig()));
      }
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
    json: { type: "boolean", description: "Output in JSON format", default: false },
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

const SEARCH_USAGE_MODES: SearchUsageMode[] = ["none", "both", "item", "guide"];
const SEARCH_SOURCES: SearchSource[] = ["local", "registry", "both"];
const CONFIG_SUBCOMMAND_SET = new Set(["path", "list", "get", "set", "unset"]);

// citty reads process.argv directly and does not accept a custom argv array,
// so we must replace process.argv with the normalized version before runMain.
process.argv = normalizeConfigArgv(process.argv);
runMain(main);

function parseSearchUsageMode(value: string): SearchUsageMode {
  if ((SEARCH_USAGE_MODES as string[]).includes(value)) return value as SearchUsageMode;
  throw new UsageError(`Invalid value for --usage: ${value}. Expected one of: ${SEARCH_USAGE_MODES.join("|")}`);
}

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
  if (message.includes("Invalid value for --usage")) return "Pick one of: none, both, item, guide.";
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
 * Normalize argv before citty parses it so git-style config forms like
 * `akm config llm.maxTokens 512` and `akm config --get llm.maxTokens`
 * are normalized into the existing config subcommands.
 *
 * Returns a new array; the input is never modified.
 */
function normalizeConfigArgv(argv: string[]): string[] {
  // Global flags (like --json, --quiet) should not be treated as config subcommand arguments.
  // We strip them from the analysis portion, normalize, then re-append them.
  const GLOBAL_FLAGS = new Set(["--json", "--quiet", "-q", "--verbose", "-v"]);
  const globalFlags = argv.slice(3).filter((a) => GLOBAL_FLAGS.has(a));
  const configArgs = argv.slice(3).filter((a) => !GLOBAL_FLAGS.has(a));

  const [command, argAfterCommand, argAfterKey, ...rest] = [argv[2], ...configArgs];
  if (command !== "config") return argv;
  if (!argAfterCommand) return argv;

  const prefix = argv.slice(0, 3);
  const buildResult = (...newArgs: string[]) => [...prefix, ...newArgs, ...globalFlags];

  if (argAfterCommand === "--list") {
    return buildResult("list");
  }
  if (argAfterCommand === "--get" && argAfterKey) {
    return buildResult("get", argAfterKey, ...rest);
  }
  if (argAfterCommand === "--unset" && argAfterKey) {
    return buildResult("unset", argAfterKey, ...rest);
  }
  if (argAfterCommand.startsWith("-")) return argv;
  if (CONFIG_SUBCOMMAND_SET.has(argAfterCommand)) return argv;

  // A single arg after `config` behaves like `git config <key>` and reads the value.
  if (argAfterKey === undefined) {
    return buildResult("get", argAfterCommand);
  }

  return buildResult("set", argAfterCommand, argAfterKey, ...rest);
}
