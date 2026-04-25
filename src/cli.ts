#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { defineCommand, runMain } from "citty";
import { generateBashCompletions, installBashCompletions } from "./commands/completions";
import { getConfigValue, listConfig, setConfigValue, unsetConfigValue } from "./commands/config-cli";
import { akmCurate } from "./commands/curate";
import { assembleInfo } from "./commands/info";
import { akmInit } from "./commands/init";
import { akmListSources, akmRemove, akmUpdate } from "./commands/installed-stashes";
import { renderMigrationHelp } from "./commands/migration-help";
import { searchRegistry } from "./commands/registry-search";
import {
  buildMemoryFrontmatter,
  parseDuration,
  readMemoryContent,
  runAutoHeuristics,
  runLlmEnrich,
} from "./commands/remember";
import { akmSearch, parseSearchSource } from "./commands/search";
import { checkForUpdate, performUpgrade } from "./commands/self-update";
import { akmShowUnified } from "./commands/show";
import { akmAdd } from "./commands/source-add";
import { akmClone } from "./commands/source-clone";
import { addStash } from "./commands/source-manage";
import { parseAssetRef } from "./core/asset-ref";
import { deriveCanonicalAssetName, resolveAssetPathFromName } from "./core/asset-spec";
import { isWithin, resolveStashDir, tryReadStdinText } from "./core/common";
import type { RegistryConfigEntry } from "./core/config";
import { DEFAULT_CONFIG, getConfigPath, loadConfig, loadUserConfig, saveConfig } from "./core/config";
import { ConfigError, NotFoundError, UsageError } from "./core/errors";
import { getCacheDir, getDbPath, getDefaultStashDir } from "./core/paths";
import { setQuiet, warn } from "./core/warn";
import { resolveWriteTarget, writeAssetToSource } from "./core/write-source";
import { closeDatabase, openDatabase } from "./indexer/db";
import { akmIndex } from "./indexer/indexer";
import { insertUsageEvent } from "./indexer/usage-events";
import { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL } from "./output/cli-hints";
import {
  getHyphenatedArg,
  getHyphenatedBoolean,
  getOutputMode,
  initOutputMode,
  type OutputMode,
  parseFlagValue,
} from "./output/output-context";
import { shapeForCommand } from "./output/output-shapes";
import { formatPlain, outputJsonl } from "./output/output-text";
import { buildRegistryIndex, writeRegistryIndex } from "./registry/registry-build-index";
import { saveGitStash } from "./sources/source-providers/git";
import type { KnowledgeView, ShowDetailLevel, SourceKind } from "./sources/source-types";
import { pkgVersion } from "./version";
import { createWorkflowAsset, getWorkflowTemplate } from "./workflows/workflow-authoring";
import {
  hasWorkflowSubcommand,
  parseWorkflowJsonObject,
  parseWorkflowStepState,
  WORKFLOW_STEP_STATES,
} from "./workflows/workflow-cli";
import {
  completeWorkflowStep,
  getNextWorkflowStep,
  getWorkflowStatus,
  listWorkflowRuns,
  resumeWorkflowRun,
  startWorkflowRun,
} from "./workflows/workflow-runs";

const MAX_CAPTURED_ASSET_SLUG_LENGTH = 64;
const SKILLS_SH_NAME = "skills.sh";
const SKILLS_SH_URL = "https://skills.sh";
const SKILLS_SH_PROVIDER = "skills-sh";

import { stringify as yamlStringify } from "yaml";

/**
 * Collect all occurrences of a repeatable flag from process.argv.
 * Citty's StringArgDef only exposes the last value when a flag is repeated,
 * so for repeatable CLI args (like `--tag foo --tag bar`) we read argv directly.
 * Supports both `--flag value` and `--flag=value` forms.
 */
function parseAllFlagValues(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === flag && i + 1 < process.argv.length) {
      values.push(process.argv[i + 1] as string);
    } else if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    }
  }
  return values;
}

function output(command: string, result: unknown): void {
  const mode: OutputMode = getOutputMode();
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
/**
 * Module Naming:
 * - source-*          : Asset operations (search, show, add, clone)
 * - source-provider-* : Runtime data source providers (filesystem, git, website, npm)
 * - registry-*       : Discovery from remote registries (npm, GitHub)
 * - installed-stashes   : Unified source operations (list, remove, update)
 */

const setupCommand = defineCommand({
  meta: {
    name: "setup",
    description: "Interactive configuration wizard for embeddings, LLM, registries, and stash sources",
  },
  async run() {
    await runWithJsonErrors(async () => {
      const { runSetupWizard } = await import("./setup/setup");
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
    detail: { type: "string", description: "Detail level (brief|normal|full|summary|agent)" },
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
      const curated = await akmCurate({ query: args.query, type, limit, source });
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
    provider: { type: "string", description: "Provider type (e.g. website, npm). Required for URL sources." },
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
        output("add", result);
        return;
      }

      if (shouldWarnOnPlainHttp(ref)) {
        warn(
          "Warning: source URL uses plain HTTP (not HTTPS). For security, prefer https:// to protect against eavesdropping and tampering.",
        );
      }
      const websiteOptions = buildWebsiteOptions(args);

      if (args.type === "wiki") {
        const { registerWikiSource } = await import("./commands/source-add");
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
    "skip-checksum": {
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
      const skipChecksum = getHyphenatedBoolean(args, "skip-checksum");
      const result = await performUpgrade(check, { force: args.force, skipChecksum });
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
    detail: { type: "string", description: "Detail level (brief|normal|full|summary|agent)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      // The knowledge-view positional syntax (`akm show knowledge:foo section "Auth"`)
      // is rewritten to `--akmView` / `--akmHeading` / `--akmStart` / `--akmEnd`
      // by `normalizeShowArgv` before citty parses argv. We read those values
      // directly via `parseFlagValue` so the flags don't surface as user-facing
      // options in `akm show --help`.
      const akmView = parseFlagValue(process.argv, "--akmView");
      const akmHeading = parseFlagValue(process.argv, "--akmHeading");
      const akmStart = parseFlagValue(process.argv, "--akmStart");
      const akmEnd = parseFlagValue(process.argv, "--akmEnd");
      let view: KnowledgeView | undefined;
      if (akmView) {
        switch (akmView) {
          case "section":
            view = { mode: "section", heading: akmHeading ?? "" };
            break;
          case "lines":
            view = {
              mode: "lines",
              start: Number(akmStart ?? "1"),
              end: akmEnd ? parseInt(akmEnd, 10) : Number.MAX_SAFE_INTEGER,
            };
            break;
          case "toc":
          case "frontmatter":
          case "full":
            view = { mode: akmView };
            break;
          default:
            throw new UsageError(`Unknown view mode: ${akmView}. Expected one of: full|toc|frontmatter|section|lines`);
        }
      }
      const cliDetail = getOutputMode().detail;
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
      const parsedFormat = parseFlagValue(process.argv, "--format");
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
  meta: { name: "registry", description: "Manage stash registries" },
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
        "allow-insecure": {
          type: "boolean",
          description: "Allow a plain HTTP registry URL (otherwise rejected)",
          default: false,
        },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          if (!args.url.startsWith("http")) {
            throw new UsageError("Registry URL must start with http:// or https://");
          }
          if (args.url.startsWith("http://")) {
            const allowInsecure = getHyphenatedBoolean(args, "allow-insecure");
            if (!allowInsecure) {
              throw new UsageError(
                "Registry URL uses plain HTTP (not HTTPS). An on-path attacker could substitute a malicious index. " +
                  "Use https:// or pass --allow-insecure if you have explicitly accepted the risk.",
              );
            }
            warn(
              "Warning: registry URL uses plain HTTP (not HTTPS). --allow-insecure was set; an on-path attacker could substitute a malicious index.",
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
      meta: { name: "search", description: "Search enabled registries for stashes" },
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
        "npm-registry": { type: "string", description: "Override npm registry base URL" },
        "github-api": { type: "string", description: "Override GitHub API base URL" },
      },
      async run({ args }) {
        await runWithJsonErrors(async () => {
          const result = await buildRegistryIndex({
            manualEntriesPath: args.manual,
            npmRegistryBase: getHyphenatedArg<string>(args, "npm-registry"),
            githubApiBase: getHyphenatedArg<string>(args, "github-api"),
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

async function writeMarkdownAsset(options: {
  type: "knowledge" | "memory";
  content: string;
  name?: string;
  fallbackPrefix: string;
  preferredName?: string;
  force?: boolean;
  /** Optional explicit `--target` override naming a configured source. */
  target?: string;
}): Promise<{ ref: string; path: string; stashDir: string }> {
  // Resolve write target via the v1 precedence chain (`--target` →
  // `defaultWriteTarget` → working stash). Per spec §10 step 5, this is the
  // single dispatch point — `core/write-source.ts` owns all kind-branching.
  const cfg = loadConfig();
  const { source, config } = resolveWriteTarget(cfg, options.target);

  const typeRoot = path.join(source.path, options.type === "knowledge" ? "knowledge" : "memories");
  const normalizedName = normalizeMarkdownAssetName(
    options.name,
    inferAssetName(options.content, options.fallbackPrefix, options.preferredName),
  );
  // Pre-flight: existence + force semantics. The helper itself overwrites
  // unconditionally; the CLI surfaces a friendlier UsageError before any
  // disk activity when --force is absent.
  const assetPath = resolveAssetPathFromName(options.type, typeRoot, normalizedName);
  if (!isWithin(assetPath, typeRoot)) {
    throw new UsageError(`Resolved ${options.type} path escapes the stash: "${normalizedName}"`);
  }
  if (fs.existsSync(assetPath) && !options.force) {
    throw new UsageError(
      `${options.type === "knowledge" ? "Knowledge" : "Memory"} "${normalizedName}" already exists. Re-run with --force to overwrite it.`,
      "RESOURCE_ALREADY_EXISTS",
    );
  }

  // Delegate the actual write (and optional git commit/push) to the helper.
  const result = await writeAssetToSource(
    source,
    config,
    { type: options.type, name: normalizedName },
    options.content,
  );
  return {
    ref: result.ref,
    path: result.path,
    stashDir: source.path,
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
          throw new NotFoundError(`No workflow runs found for ${ref}`, "WORKFLOW_NOT_FOUND");
        }
        const mostRecent = runs[0];
        if (!mostRecent) throw new NotFoundError(`No workflow runs found for ${ref}`, "WORKFLOW_NOT_FOUND");
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
      output("workflow-resume", result);
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
    tag: {
      type: "string",
      description: "Tag to add to the memory (repeatable: --tag foo --tag bar)",
    },
    expires: {
      type: "string",
      description: "Expiry duration shorthand (e.g. 30d, 12h, 6m). Resolved to an ISO date.",
    },
    source: {
      type: "string",
      description: "Source reference (URL, asset ref, file path, or any free-form string)",
    },
    auto: {
      type: "boolean",
      description: "Apply heuristic tagging (code, subjective, source, observed_at) from the body",
      default: false,
    },
    enrich: {
      type: "boolean",
      description: "Call the configured LLM to propose tags and description (requires LLM config)",
      default: false,
    },
    target: {
      type: "string",
      description:
        "Override the write destination. Accepts a source name from your config; falls back to defaultWriteTarget then the working stash.",
    },
  },
  async run({ args }) {
    return runWithJsonErrors(async () => {
      const body = readMemoryContent(args.content);

      // Determine if the user has requested any structured metadata mode.
      // Collect all --tag occurrences directly from process.argv because citty
      // only exposes the last value for repeated string flags.
      const rawTags = parseAllFlagValues("--tag");

      const hasStructuredArgs = rawTags.length > 0 || !!args.expires || !!args.source || args.auto || args.enrich;

      if (!hasStructuredArgs) {
        const result = await writeMarkdownAsset({
          type: "memory",
          content: body,
          name: args.name,
          fallbackPrefix: "memory",
          force: args.force,
          target: args.target,
        });
        output("remember", { ok: true, ...result });
        return;
      }

      // ── Accumulate metadata from all three modes ──────────────────────────

      // Start with CLI args (Mode 1: always)
      const tags = [...rawTags];
      let description: string | undefined;
      let source: string | undefined = args.source;
      let observed_at: string | undefined;
      let expires: string | undefined;
      let subjective: boolean | undefined;

      // Resolve --expires to an ISO date string
      if (args.expires) {
        const durationMs = parseDuration(args.expires);
        const expiresDate = new Date(Date.now() + durationMs);
        expires = expiresDate.toISOString().slice(0, 10);
      }

      // Mode 2: --auto heuristics
      if (args.auto) {
        const auto = runAutoHeuristics(body);
        for (const t of auto.tags) {
          if (!tags.includes(t)) tags.push(t);
        }
        if (!source && auto.source) source = auto.source;
        if (!observed_at && auto.observed_at) observed_at = auto.observed_at;
        if (!subjective && auto.subjective) subjective = auto.subjective;
      }

      // Mode 3: --enrich LLM (fail-soft)
      if (args.enrich) {
        const enriched = await runLlmEnrich(body);
        for (const t of enriched.tags) {
          if (!tags.includes(t)) tags.push(t);
        }
        if (!description && enriched.description) description = enriched.description;
        if (!observed_at && enriched.observed_at) observed_at = enriched.observed_at;
      }

      // ── Required-field check (before any write) ───────────────────────────
      const missing: string[] = [];
      if (tags.length === 0) missing.push("tags");

      if (missing.length > 0) {
        throw new UsageError(
          `Memory is missing required frontmatter field(s): ${missing.join(", ")}. ` +
            "Provide them via --tag <value>, --auto (heuristics), or --enrich (LLM).",
        );
      }

      // ── Build frontmatter and write ───────────────────────────────────────
      const frontmatterBlock = buildMemoryFrontmatter({
        description,
        tags,
        source,
        observed_at,
        expires,
        subjective,
      });

      const contentWithFrontmatter = `${frontmatterBlock}\n${body}`;

      const result = await writeMarkdownAsset({
        type: "memory",
        content: contentWithFrontmatter,
        name: args.name,
        fallbackPrefix: "memory",
        force: args.force,
        target: args.target,
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
    target: {
      type: "string",
      description:
        "Override the write destination. Accepts a source name from your config; falls back to defaultWriteTarget then the working stash.",
    },
  },
  async run({ args }) {
    return runWithJsonErrors(async () => {
      const { content, preferredName } = readKnowledgeContent(args.source);
      const result = await writeMarkdownAsset({
        type: "knowledge",
        content,
        name: args.name,
        fallbackPrefix: "knowledge",
        preferredName,
        force: args.force,
        target: args.target,
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
    if (args.detail !== "normal" && args.detail !== "full") {
      throw new UsageError(
        `Invalid value for --detail: ${args.detail}. Expected one of: normal|full.`,
        "INVALID_DETAIL_VALUE",
      );
    }
    process.stdout.write(loadHints(args.detail));
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
        description:
          "Print release notes and migration guidance for a version. Bundled notes live in docs/migration/release-notes/<version>.md; an unknown version lists what's available.",
      },
      args: {
        version: {
          type: "positional",
          description: "Version to review (for example 0.6.0, v0.6.0, 0.6.0-rc1, or latest)",
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

function normalizeToggleTarget(target: string): "skills.sh" {
  const normalized = target.trim().toLowerCase();
  if (normalized === "skills.sh" || normalized === "skills-sh") return "skills.sh";
  if (normalized === "context-hub") {
    throw new UsageError(
      'The "context-hub" component is no longer toggleable. Run `akm add github:andrewyng/context-hub --name context-hub` to add it as a git stash.',
    );
  }
  throw new UsageError(`Unsupported target "${target}". Supported targets: skills.sh`);
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

function toggleComponent(
  targetRaw: string,
  enabled: boolean,
): { changed: boolean; component: string; enabled: boolean } {
  const target = normalizeToggleTarget(targetRaw);
  if (target === "skills.sh") return toggleSkillsShRegistry(enabled);
  // normalizeToggleTarget throws for any unsupported target; this is unreachable.
  throw new UsageError(`Unsupported target "${targetRaw}". Supported targets: skills.sh`);
}

const enableCommand = defineCommand({
  meta: { name: "enable", description: "Enable an optional component (skills.sh)" },
  args: {
    target: { type: "positional", description: "Component to enable (skills.sh)", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const result = toggleComponent(args.target, true);
      output("enable", result);
    });
  },
});

const disableCommand = defineCommand({
  meta: { name: "disable", description: "Disable an optional component (skills.sh)" },
  args: {
    target: { type: "positional", description: "Component to disable (skills.sh)", required: true },
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
      const { listKeys } = await import("./commands/vault.js");
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
      const { createVault } = await import("./commands/vault.js");
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
      const { setKey } = await import("./commands/vault.js");
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
      const { unsetKey } = await import("./commands/vault.js");
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

      const { buildShellExportScript } = await import("./commands/vault.js");
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
      const { listKeys } = await import("./commands/vault.js");
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
      const { listKeys } = await import("./commands/vault.js");
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
      const { createWiki } = await import("./wiki/wiki.js");
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
      const { registerWikiSource } = await import("./commands/source-add");
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
      const { listWikis } = await import("./wiki/wiki.js");
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
      const { showWiki } = await import("./wiki/wiki.js");
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
      const withSources = getHyphenatedBoolean(args, "with-sources");
      const { removeWiki } = await import("./wiki/wiki.js");
      const { akmIndex } = await import("./indexer/indexer");
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
      const { listPages } = await import("./wiki/wiki.js");
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
      const { resolveWikiSource, searchInWiki } = await import("./wiki/wiki.js");
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
      const { stashRaw } = await import("./wiki/wiki.js");
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
      const { lintWiki } = await import("./wiki/wiki.js");
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
      const { buildIngestWorkflow } = await import("./wiki/wiki.js");
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
      const { listWikis } = await import("./wiki/wiki.js");
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
    detail: { type: "string", description: "Detail level (brief|normal|full|summary|agent)" },
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
const WIKI_SUBCOMMAND_SET = new Set([
  "create",
  "register",
  "list",
  "show",
  "remove",
  "pages",
  "search",
  "stash",
  "lint",
  "ingest",
]);
const SHOW_VIEW_MODES = new Set(["toc", "frontmatter", "full", "section", "lines"]);

// ── Exit codes ──────────────────────────────────────────────────────────────
const EXIT_GENERAL = 1;
const EXIT_USAGE = 2;
const EXIT_CONFIG = 78;

// citty reads process.argv directly and does not accept a custom argv array,
// so we must replace process.argv with the normalized version before runMain.
process.argv = normalizeShowArgv(process.argv);
// Resolve output mode once at startup from the (normalized) argv and persisted
// config. All subsequent output() calls read from this in-memory singleton.
// `initOutputMode` can throw a UsageError when --format/--detail values are
// invalid; surface it through the same JSON-error path the rest of the CLI uses
// rather than letting the raw exception escape with a stack trace.
try {
  initOutputMode(process.argv, loadConfig().output ?? {});
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const hint = extractHint(error);
  const exitCode = classifyExitCode(error);
  const code =
    error instanceof UsageError || error instanceof ConfigError || error instanceof NotFoundError
      ? error.code
      : undefined;
  console.error(JSON.stringify({ ok: false, error: message, ...(code ? { code } : {}), hint }, null, 2));
  process.exit(exitCode);
}
runMain(main);

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
    const hint = extractHint(error);
    const exitCode = classifyExitCode(error);
    // Surface machine-readable error code from typed errors when present so
    // scripts can branch on `.code` instead of message-string matching.
    const code =
      error instanceof UsageError || error instanceof ConfigError || error instanceof NotFoundError
        ? error.code
        : undefined;
    console.error(JSON.stringify({ ok: false, error: message, ...(code ? { code } : {}), hint }, null, 2));
    process.exit(exitCode);
  }
}

/**
 * Extract an actionable hint from an error instance. Hints live on the error
 * classes themselves (see src/errors.ts) — either supplied explicitly at the
 * throw site, or derived from the error code via the per-class default mapping.
 */
function extractHint(error: unknown): string | undefined {
  if (error instanceof Error && "hint" in error && typeof (error as { hint: unknown }).hint === "function") {
    return (error as { hint: () => string | undefined }).hint();
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
