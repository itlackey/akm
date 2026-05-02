#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { defineCommand, runMain } from "citty";
import { generateBashCompletions, installBashCompletions } from "./commands/completions";
import { getConfigValue, listConfig, setConfigValue, unsetConfigValue } from "./commands/config-cli";
import { akmCurate } from "./commands/curate";
import { akmDistill } from "./commands/distill";
import { akmEventsList, akmEventsTail } from "./commands/events";
import { akmHistory } from "./commands/history";
import { assembleInfo } from "./commands/info";
import { akmInit } from "./commands/init";
import { akmListSources, akmRemove, akmUpdate } from "./commands/installed-stashes";
import { renderMigrationHelp } from "./commands/migration-help";
import {
  akmProposalAccept,
  akmProposalDiff,
  akmProposalList,
  akmProposalReject,
  akmProposalShow,
} from "./commands/proposal";
import { akmPropose } from "./commands/propose";
import { akmReflect } from "./commands/reflect";
import { searchRegistry } from "./commands/registry-search";
import {
  buildMemoryFrontmatter,
  parseDuration,
  readMemoryContent,
  runAutoHeuristics,
  runLlmEnrich,
} from "./commands/remember";
import { akmSearch, parseScopeFilterFlags, parseSearchSource } from "./commands/search";
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
import { appendEvent } from "./core/events";
import { getCacheDir, getDbPath, getDefaultStashDir } from "./core/paths";
import { setQuiet, setVerbose, warn } from "./core/warn";
import { resolveWriteTarget, writeAssetToSource } from "./core/write-source";
import { closeDatabase, findEntryIdByRef, openDatabase } from "./indexer/db";
import { akmIndex } from "./indexer/indexer";
import { resolveSourceEntries } from "./indexer/search-source";
import { insertUsageEvent } from "./indexer/usage-events";
import { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL } from "./output/cli-hints";
import {
  getHyphenatedArg,
  getHyphenatedBoolean,
  getOutputMode,
  initOutputMode,
  type OutputMode,
  parseFlagValue,
} from "./output/context";
import { shapeForCommand } from "./output/shapes";
import { formatEventLine, formatPlain, outputJsonl } from "./output/text";
import { buildRegistryIndex, writeRegistryIndex } from "./registry/build-index";
import { resolveSourcesForOrigin } from "./registry/origin-resolve";
import { saveGitStash } from "./sources/providers/git";
import { resolveAssetPath } from "./sources/resolve";
import type { KnowledgeView, ShowDetailLevel, SourceKind } from "./sources/types";
import { pkgVersion } from "./version";
import {
  createWorkflowAsset,
  formatWorkflowErrors,
  getWorkflowTemplate,
  validateWorkflowSource,
} from "./workflows/authoring";
import {
  hasWorkflowSubcommand,
  parseWorkflowJsonObject,
  parseWorkflowStepState,
  WORKFLOW_STEP_STATES,
} from "./workflows/cli";
import {
  completeWorkflowStep,
  getNextWorkflowStep,
  getWorkflowStatus,
  listWorkflowRuns,
  resumeWorkflowRun,
  startWorkflowRun,
} from "./workflows/runs";

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
      // BUG-M4: skip the value index so `--tag --tag` (literal `--tag`
      // value) does not double-count the second `--tag` as a separate
      // flag occurrence.
      i++;
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
 * - sources/*           : Asset operations (search, show, add, clone)
 * - sources/providers/* : Runtime data source providers (filesystem, git, website, npm)
 * - registry/*          : Discovery from remote registries (npm, GitHub)
 * - installed-stashes   : Unified source operations (list, remove, update)
 */

const setupCommand = defineCommand({
  meta: {
    name: "setup",
    description:
      "Interactive configuration wizard: detects services and walks you through embeddings, LLM, registries, sources, and agent profiles. Writes config once at the end.",
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
      // Accept both historical spellings for backwards compatibility with
      // older docs/scripts that used `--stashDir`.
      const legacyDir = parseFlagValue(process.argv, "--stashDir") ?? parseFlagValue(process.argv, "--stash-dir");
      const result = await akmInit({ dir: args.dir ?? legacyDir });
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
        "Asset type filter (skill, command, agent, knowledge, workflow, script, memory, vault, wiki, lesson, or any). Use workflow to find step-by-step task assets.",
    },
    limit: { type: "string", description: "Maximum number of results" },
    source: { type: "string", description: "Search source (stash|registry|both)", default: "stash" },
    filter: {
      type: "string",
      description:
        "Scope filter (repeatable): --filter user=<id> --filter agent=<id> --filter run=<id> --filter channel=<name>. Narrows results without changing ranking.",
    },
    "include-proposed": {
      type: "boolean",
      description: 'Include entries with quality:"proposed" in the result set. Excluded by default (v1 spec §4.2).',
      default: false,
    },
    format: { type: "string", description: "Output format (json|jsonl|text|yaml)" },
    detail: { type: "string", description: "Detail level (brief|normal|full|summary|agent)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const query = (args.query ?? "").trim();
      if (!query) {
        throw new UsageError(
          'A search query is required. Usage: akm search "<query>" [--type <type>] [--limit <n>]',
          "MISSING_REQUIRED_ARGUMENT",
          "Provide a query string. Filter by type with --type skill|command|...; limit results with --limit N.",
        );
      }
      const type = args.type as string | undefined;
      const limitRaw = args.limit ? parseInt(args.limit, 10) : undefined;
      if (limitRaw !== undefined && Number.isNaN(limitRaw)) {
        throw new UsageError(`Invalid --limit value: "${args.limit}". Must be a positive integer.`);
      }
      const limit = limitRaw;
      const source = parseSearchSource(args.source);
      // Repeatable; citty exposes only the last `--filter` value, so read all
      // occurrences directly from argv (same pattern as `--tag`).
      const filterTokens = parseAllFlagValues("--filter");
      const filters = parseScopeFilterFlags(filterTokens, "--filter");
      const includeProposed = (args as Record<string, unknown>)["include-proposed"] === true;
      const result = await akmSearch({ query, type, limit, source, filters, includeProposed });
      output("search", result);
    });
  },
});

const curateCommand = defineCommand({
  meta: { name: "curate", description: "Curate the best matching assets for a task or prompt" },
  args: {
    // Optional in citty so run() is invoked when omitted; we re-validate
    // below to surface a structured UsageError (exit 2) instead of citty's
    // default help-banner exit-0.
    query: { type: "positional", description: "Task or prompt to curate assets for", required: false },
    type: {
      type: "string",
      description:
        "Asset type filter (skill, command, agent, knowledge, workflow, script, memory, vault, wiki, lesson, or any). Use workflow to curate step-by-step task assets.",
    },
    limit: { type: "string", description: "Maximum number of curated results", default: "4" },
    source: { type: "string", description: "Search source (stash|registry|both)", default: "stash" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      if (!args.query || !String(args.query).trim()) {
        throw new UsageError(
          'A curate query is required. Usage: akm curate "<task or prompt>" [--type <type>] [--limit <n>]',
          "MISSING_REQUIRED_ARGUMENT",
          'Describe the task you want assets for, e.g. `akm curate "deploy to prod"`.',
        );
      }
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
    "allow-insecure": {
      type: "boolean",
      description: "Allow a plain HTTP source URL (otherwise rejected for non-localhost hosts)",
      default: false,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const ref = args.ref.trim();
      const allowInsecure = getHyphenatedBoolean(args, "allow-insecure");

      // URL with --provider → stash source (remote or git provider)
      if (args.provider) {
        if (shouldWarnOnPlainHttp(ref)) {
          if (!allowInsecure) {
            throw new UsageError(
              "Source URL uses plain HTTP (not HTTPS). An on-path attacker could substitute a malicious payload. " +
                "Use https:// or pass --allow-insecure if you have explicitly accepted the risk.",
              "INVALID_FLAG_VALUE",
              "Re-run with `--allow-insecure` only after confirming the URL is trusted.",
            );
          }
          warn(
            "Warning: source URL uses plain HTTP (not HTTPS). --allow-insecure was set; an on-path attacker could substitute a malicious payload.",
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
        appendEvent({
          eventType: "add",
          metadata: { target: ref, provider: args.provider, name: args.name ?? null, writable: args.writable === true },
        });
        output("add", result);
        return;
      }

      if (shouldWarnOnPlainHttp(ref)) {
        if (!allowInsecure) {
          throw new UsageError(
            "Source URL uses plain HTTP (not HTTPS). An on-path attacker could substitute a malicious payload. " +
              "Use https:// or pass --allow-insecure if you have explicitly accepted the risk.",
            "INVALID_FLAG_VALUE",
            "Re-run with `--allow-insecure` only after confirming the URL is trusted.",
          );
        }
        warn(
          "Warning: source URL uses plain HTTP (not HTTPS). --allow-insecure was set; an on-path attacker could substitute a malicious payload.",
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
        appendEvent({
          eventType: "add",
          metadata: { target: ref, type: "wiki", name: args.name ?? null, writable: args.writable === true },
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
      appendEvent({
        eventType: "add",
        metadata: {
          target: ref,
          name: args.name ?? null,
          overrideType: args.type ?? null,
          writable: args.writable === true,
        },
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
      appendEvent({
        eventType: "remove",
        metadata: {
          target: args.target,
          ref: typeof result.removed?.ref === "string" ? result.removed.ref : null,
          id: typeof result.removed?.id === "string" ? result.removed.id : null,
        },
      });
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
      appendEvent({
        eventType: "update",
        metadata: {
          target: args.target ?? null,
          all: args.all === true,
          force: args.force === true,
          processed: Array.isArray((result as { processed?: unknown[] }).processed)
            ? (result as { processed: unknown[] }).processed.length
            : 0,
        },
      });
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
    "skip-post-upgrade": {
      type: "boolean",
      description:
        "Skip the post-upgrade `akm index` rebuild (config auto-migration still runs on next `akm` invocation)",
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
      const skipPostUpgrade = getHyphenatedBoolean(args, "skip-post-upgrade");
      const result = await performUpgrade(check, { force: args.force, skipChecksum, skipPostUpgrade });
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
    ref: {
      type: "positional",
      description:
        'Asset ref ([origin//]type:name) optionally followed by a view mode. View modes: `toc` (table of contents), `section "Heading"` (extract one section), `lines <start> <end>` (line range), `frontmatter` (YAML metadata only), `full` (raw file). Example: `akm show knowledge:guide.md section "Auth"`.',
      required: true,
    },
    format: { type: "string", description: "Output format (json|jsonl|text|yaml)" },
    detail: { type: "string", description: "Detail level (brief|normal|full|summary|agent)" },
    scope: {
      type: "string",
      description:
        "Scope filter (repeatable): --scope user=<id> --scope agent=<id> --scope run=<id> --scope channel=<name>. Narrows resolution to assets whose frontmatter scope matches.",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      try {
        parseAssetRef(args.ref);
      } catch (error) {
        if (error instanceof UsageError && error.code === "MISSING_REQUIRED_ARGUMENT") {
          throw new UsageError(error.message, "INVALID_FLAG_VALUE", error.hint());
        }
        throw error;
      }
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
      const explicitDetail = parseFlagValue(process.argv, "--detail");
      const showDetail: ShowDetailLevel | undefined =
        explicitDetail === "brief" ? "brief" : cliDetail === "summary" ? "summary" : undefined;
      // `--scope` is repeatable — citty only exposes the last value, so read
      // every occurrence directly from argv (same pattern as `--filter`).
      const scopeTokens = parseAllFlagValues("--scope");
      const scope = parseScopeFilterFlags(scopeTokens, "--scope");
      const result = await akmShowUnified({ ref: args.ref, view, detail: showDetail, scope });
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
      appendEvent({
        eventType: "save",
        metadata: {
          name: effectiveName ?? null,
          message: args.message ?? null,
          ok: (result as { ok?: boolean }).ok !== false,
        },
      });
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
        out: { type: "string", description: "Output path for the generated index" },
        manual: { type: "string", description: "Manual entries JSON file" },
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
    description:
      "Record positive or negative feedback for any indexed stash asset.\n\n" +
      "Positive feedback boosts an asset's EMA utility score, making it rank higher\n" +
      "in future searches without requiring a full reindex.\n\n" +
      "Negative feedback records a negative signal in usage_events and events.jsonl.\n" +
      "It does NOT immediately lower the asset's ranking — the EMA utility score is\n" +
      "updated the next time `akm index` runs (incremental or full). Run `akm index`\n" +
      "after recording negative feedback to have it reflected in search results.",
  },
  args: {
    // Optional in citty so run() is invoked even when omitted; we re-validate
    // and throw a structured UsageError below so exit code is 2 (USAGE) rather
    // than citty's default 0 (help banner).
    ref: { type: "positional", description: "Asset ref (type:name)", required: false },
    positive: { type: "boolean", description: "Record positive feedback (boosts ranking immediately)", default: false },
    negative: {
      type: "boolean",
      description:
        "Record negative feedback (suppresses ranking after next `akm index`). " +
        "Reindexing is required for the signal to affect search results.",
      default: false,
    },
    note: { type: "string", description: "Optional note to attach to the feedback" },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const ref = (args.ref ?? "").trim();
      if (!ref) {
        throw new UsageError(
          "Asset ref is required. Usage: akm feedback <ref> --positive|--negative",
          "MISSING_REQUIRED_ARGUMENT",
          "Pass a ref like `skill:deploy` and either --positive or --negative.",
        );
      }
      parseAssetRef(ref);
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
        const entryId = findEntryIdByRef(db, ref);
        if (entryId === undefined) {
          throw new UsageError(`Ref "${ref}" is not in the current index. Run "akm index" and try again.`);
        }
        // Persist the feedback signal into usage_events. For positive signals,
        // the EMA utility score is updated immediately on the next read path.
        // For negative signals, the score is adjusted the next time `akm index`
        // runs — the signal is durable in the DB but does NOT suppress ranking
        // in search results until after reindexing.
        insertUsageEvent(db, {
          event_type: "feedback",
          entry_ref: ref,
          entry_id: entryId,
          signal,
          metadata,
        });
      } finally {
        closeDatabase(db);
      }

      appendEvent({
        eventType: "feedback",
        ref,
        metadata: { signal, ...(args.note ? { note: args.note } : {}) },
      });
      output("feedback", { ok: true, ref, signal, note: args.note ?? null });
    });
  },
});

const historyCommand = defineCommand({
  meta: {
    name: "history",
    description:
      "Show mutation/usage history for a single asset (--ref) or stash-wide.\n\n" +
      "Event sources:\n" +
      "  usage_events (default): search, show, and feedback events from the local index.\n" +
      "  events.jsonl (--include-proposals): proposal lifecycle events (promoted, rejected)\n" +
      "    emitted by `akm proposal accept` / `akm proposal reject`.\n\n" +
      "Results from all active sources are merged and sorted chronologically.",
  },
  args: {
    ref: { type: "string", description: "Asset ref (type:name). Omit for stash-wide history." },
    since: { type: "string", description: "ISO timestamp or epoch ms — only events on/after this time" },
    "include-proposals": {
      type: "boolean",
      description:
        "Also include proposal lifecycle events (promoted, rejected) from events.jsonl. " +
        "Default: false (usage_events only).",
      default: false,
    },
    format: { type: "string", description: "Output format (json|jsonl|text|yaml)" },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const result = await akmHistory({
        ref: args.ref,
        since: args.since,
        includeProposals: args["include-proposals"],
      });
      output("history", result);
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
      // If the target looks like a UUID-style run id (no `:` and matches the
      // run-id shape), short-circuit with a structured WORKFLOW_NOT_FOUND
      // error before parseAssetRef gets to throw an unhelpful ref-parse error.
      if (looksLikeWorkflowRunId(args.target)) {
        const { listWorkflowRuns: listRuns } = await import("./workflows/runs.js");
        const { runs: existingRuns } = listRuns({});
        if (!existingRuns.some((r) => r.id === args.target)) {
          throw new NotFoundError(
            `Workflow run "${args.target}" not found.`,
            "WORKFLOW_NOT_FOUND",
            "Run `akm workflow list --active` to see runs.",
          );
        }
      }
      const result = await getNextWorkflowStep(args.target, parsedParams);
      output("workflow-next", result);
    });
  },
});

/**
 * Heuristic: a workflow run id is a UUID-shaped or hex-id-shaped string with
 * no `:` separator (refs always contain a colon: `workflow:<name>` or
 * `<origin>//workflow:<name>`). When this matches we can give a much better
 * error than parseAssetRef's "Invalid asset type" failure.
 */
function looksLikeWorkflowRunId(target: string): boolean {
  if (target.includes(":")) return false;
  if (target.includes("/")) return false;
  // UUID v4-ish: 8-4-4-4-12 hex digits separated by dashes.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) return true;
  // Bare hex/alphanumeric run ids of >=8 chars (covers shortened ids).
  if (/^[0-9a-z][0-9a-z_-]{7,}$/i.test(target) && /[0-9]/.test(target)) return true;
  return false;
}

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
  async run({ args }) {
    return runWithJsonErrors(async () => {
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
      // Index the newly-written workflow so `akm workflow start` can resolve
      // a workflowEntryId without requiring an explicit `akm index` call
      // first. Uses the same incremental index path that `akm add` uses.
      await akmIndex({ stashDir: result.stashDir });
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

const workflowValidateCommand = defineCommand({
  meta: {
    name: "validate",
    description: "Validate a workflow markdown file or ref and print any errors",
  },
  args: {
    target: {
      type: "positional",
      description: "Workflow ref (workflow:<name>) or filesystem path to a workflow .md",
      required: true,
    },
  },
  async run({ args }) {
    return runWithJsonErrors(async () => {
      const filePath = await resolveWorkflowFilePath(args.target);
      const { parse } = validateWorkflowSource(filePath);
      if (parse.ok) {
        output("workflow-validate", {
          ok: true,
          path: filePath,
          title: parse.document.title,
          stepCount: parse.document.steps.length,
        });
        return;
      }
      throw new UsageError(formatWorkflowErrors(filePath, parse.errors));
    });
  },
});

async function resolveWorkflowFilePath(target: string): Promise<string> {
  if (!target.startsWith("workflow:")) return target;
  const parsed = parseAssetRef(target);
  if (parsed.type !== "workflow") {
    throw new UsageError(`Expected a workflow ref (workflow:<name>), got "${target}".`);
  }
  const config = loadConfig();
  const allSources = resolveSourceEntries(undefined, config);
  const searchSources = resolveSourcesForOrigin(parsed.origin, allSources);
  for (const source of searchSources) {
    try {
      return await resolveAssetPath(source.path, "workflow", parsed.name);
    } catch {
      /* try next source */
    }
  }
  throw new UsageError(`Workflow not found for ref: workflow:${parsed.name}`);
}

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
    validate: workflowValidateCommand,
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
    description: {
      type: "string",
      description: "Short description written to frontmatter (persisted as the memory's description field)",
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
    user: {
      type: "string",
      description: "Scope this memory to a user id (persisted as `scope_user` frontmatter)",
    },
    agent: {
      type: "string",
      description: "Scope this memory to an agent id (persisted as `scope_agent` frontmatter)",
    },
    run: {
      type: "string",
      description: "Scope this memory to a run id (persisted as `scope_run` frontmatter)",
    },
    channel: {
      type: "string",
      description: "Scope this memory to a channel name (persisted as `scope_channel` frontmatter)",
    },
  },
  async run({ args }) {
    return runWithJsonErrors(async () => {
      const body = readMemoryContent(resolveRememberContentArg(args.content));

      // Determine if the user has requested any structured metadata mode.
      // Collect all --tag occurrences directly from process.argv because citty
      // only exposes the last value for repeated string flags.
      const rawTags = parseAllFlagValues("--tag");

      // Collect scope flags. Scope alone counts as structured metadata so we
      // emit frontmatter, but it does NOT trigger the "tags required" check —
      // memory + scope (no tags) is a valid combination for multi-tenant use.
      const scopeFields: { user?: string; agent?: string; run?: string; channel?: string } = {};
      if (typeof args.user === "string" && args.user.trim()) scopeFields.user = args.user.trim();
      if (typeof args.agent === "string" && args.agent.trim()) scopeFields.agent = args.agent.trim();
      if (typeof args.run === "string" && args.run.trim()) scopeFields.run = args.run.trim();
      if (typeof args.channel === "string" && args.channel.trim()) scopeFields.channel = args.channel.trim();
      const hasScope = Object.keys(scopeFields).length > 0;

      const hasTagRequiringArgs =
        rawTags.length > 0 || !!args.expires || !!args.source || !!args.description || args.enrich;
      const hasStructuredArgs = hasTagRequiringArgs || hasScope || args.auto;

      if (!hasStructuredArgs) {
        const result = await writeMarkdownAsset({
          type: "memory",
          content: body,
          name: args.name,
          fallbackPrefix: "memory",
          force: args.force,
          target: args.target,
        });
        appendEvent({
          eventType: "remember",
          ref: result.ref,
          metadata: { path: result.path, force: args.force === true },
        });
        output("remember", { ok: true, ...result });
        return;
      }

      // ── Accumulate metadata from all three modes ──────────────────────────

      // Start with CLI args (Mode 1: always)
      const tags = [...rawTags];
      // --description is persisted as-is; LLM enrichment may fill it if absent.
      let description: string | undefined = args.description || undefined;
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
      // Tags remain required when the user explicitly asked for tag-bearing
      // metadata (--tag / --enrich / --description / --source / --expires).
      // `--auto` alone is allowed even when its heuristics derive zero tags.
      // Scope-only writes (`akm remember "..." --user u1`) also skip this
      // check — scope is independent metadata and a memory with only scope is
      // valid.
      const missing: string[] = [];
      if (hasTagRequiringArgs && tags.length === 0) missing.push("tags");

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
        ...(hasScope ? { scope: scopeFields } : {}),
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
      appendEvent({
        eventType: "remember",
        ref: result.ref,
        metadata: {
          path: result.path,
          force: args.force === true,
          tagCount: tags.length,
          enriched: args.enrich === true,
          auto: args.auto === true,
          ...(hasScope ? { scope: scopeFields } : {}),
        },
      });
      output("remember", { ok: true, ...result });
    });
  },
});

function resolveRememberContentArg(content: string | undefined): string | undefined {
  if (content === undefined) return undefined;

  const parsedFormat = parseFlagValue(process.argv, "--format");
  if (
    parsedFormat !== undefined &&
    content === parsedFormat &&
    wasRememberFlagValueConsumedAsContent(content, parsedFormat, "--format")
  ) {
    return undefined;
  }

  const parsedDetail = parseFlagValue(process.argv, "--detail");
  if (
    parsedDetail !== undefined &&
    content === parsedDetail &&
    wasRememberFlagValueConsumedAsContent(content, parsedDetail, "--detail")
  ) {
    return undefined;
  }

  return content;
}

function wasRememberFlagValueConsumedAsContent(
  content: string,
  flagValue: string,
  flagName: "--format" | "--detail",
): boolean {
  const argv = process.argv.slice(2);
  const rememberIndex = argv.indexOf("remember");
  const tokens = rememberIndex >= 0 ? argv.slice(rememberIndex + 1) : argv;

  let flagIndex = -1;
  let flagConsumesNextToken = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === flagName) {
      flagIndex = i;
      flagConsumesNextToken = true;
      break;
    }
    if (token === `${flagName}=${flagValue}`) {
      flagIndex = i;
      break;
    }
  }

  if (flagIndex === -1) return false;
  if (tokens.slice(0, flagIndex).includes(content)) return false;

  const firstTokenAfterFlag = flagIndex + (flagConsumesNextToken ? 2 : 1);
  if (tokens.slice(firstTokenAfterFlag).includes(content)) return false;

  return true;
}

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
      appendEvent({
        eventType: "import",
        ref: result.ref,
        metadata: { source: args.source, path: result.path, force: args.force === true },
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
    detail: {
      type: "string",
      description:
        "Hints detail level — accepts only `normal` or `full`. Differs from the global --detail flag (brief|normal|full|summary|agent); other values are rejected with INVALID_DETAIL_VALUE.",
      default: "normal",
    },
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
        // Optional in citty so run() is invoked even when omitted; we
        // re-validate below to surface a structured UsageError (exit 2)
        // instead of citty's default help-banner exit-0.
        version: {
          type: "positional",
          description: "Version to review (for example 0.6.0, v0.6.0, 0.6.0-rc1, or latest)",
          required: false,
        },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          if (!args.version || !String(args.version).trim()) {
            throw new UsageError(
              "Usage: akm help migrate <version>.",
              "MISSING_REQUIRED_ARGUMENT",
              "Pass a version like `0.6.0`, `v0.6.0`, `0.6.0-rc1`, or `latest`.",
            );
          }
          process.stdout.write(renderMigrationHelp(args.version));
        });
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

function wasRefMisparsedAsFlagValue(ref: string, flag: "--format" | "--detail", flagValue: string): boolean {
  const argv = process.argv.slice(2);
  const vaultIndex = argv.indexOf("vault");
  const listIndex = vaultIndex >= 0 ? argv.indexOf("list", vaultIndex + 1) : -1;
  const tokens = listIndex >= 0 ? argv.slice(listIndex + 1) : argv;

  let flagIndex = -1;
  let flagConsumesNextToken = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === flag) {
      flagIndex = i;
      flagConsumesNextToken = true;
      break;
    }
    if (token === `${flag}=${flagValue}`) {
      flagIndex = i;
      break;
    }
  }

  if (flagIndex === -1) return false;
  // If the same token appeared before the flag, the user explicitly passed it
  // as the positional ref and it was not consumed by the output flag.
  if (tokens.slice(0, flagIndex).includes(ref)) return false;

  // Skip past either `--flag value` (2 tokens) or `--flag=value` (1 token)
  // before checking whether the ref appears elsewhere as a real positional.
  const TOKENS_AFTER_SPACE_FLAG = 2;
  const TOKENS_AFTER_EQUALS_FLAG = 1;
  const firstTokenAfterFlag = flagIndex + (flagConsumesNextToken ? TOKENS_AFTER_SPACE_FLAG : TOKENS_AFTER_EQUALS_FLAG);
  if (tokens.slice(firstTokenAfterFlag).includes(ref)) return false;

  return true;
}

function resolveVaultListRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;

  const parsedFormat = parseFlagValue(process.argv, "--format");
  if (parsedFormat !== undefined && ref === parsedFormat && wasRefMisparsedAsFlagValue(ref, "--format", parsedFormat)) {
    return undefined;
  }

  const parsedDetail = parseFlagValue(process.argv, "--detail");
  if (parsedDetail !== undefined && ref === parsedDetail && wasRefMisparsedAsFlagValue(ref, "--detail", parsedDetail)) {
    return undefined;
  }

  return ref;
}

const vaultListCommand = defineCommand({
  meta: { name: "list", description: "List vaults, or list keys (no values) inside one vault" },
  args: {
    ref: { type: "positional", description: "Optional vault ref (e.g. vault:prod or just prod)", required: false },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { listKeys, listEntries } = await import("./commands/vault.js");
      const effectiveRef = resolveVaultListRef(args.ref);

      if (effectiveRef) {
        const { name, absPath } = resolveVaultPath(effectiveRef);
        if (!fs.existsSync(absPath)) {
          throw new NotFoundError(`Vault not found: vault:${name}`);
        }
        const entries = listEntries(absPath);
        output("vault-list", { ref: `vault:${name}`, path: absPath, entries });
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
      //
      // INTENTIONAL: this site uses `os.tmpdir()` (i.e. `/tmp` on Unix)
      // rather than `${getCacheDir()}/vault/`. The temp file is written
      // mode-0600, sourced by the parent shell via `eval`, and immediately
      // `rm -f`'d on the same line of the emitted snippet. `/tmp` is the
      // conventional location for short-lived shell-eval scratch files and
      // benefits from tmp-cleanup-on-reboot semantics, which operators
      // expect for ephemeral secret material. Moving to `~/.cache/akm/`
      // would surprise those operators and also persist the file across
      // reboots if the eval is interrupted before the inline `rm -f` runs.
      // The bench/registry-build rationale (#276/#284) — orphan dirs
      // accumulating under `/tmp` from long-running builds — does not
      // apply here: the file is single-shot, a few hundred bytes, and
      // removed by the same shell command that sources it.
      // Regression test: tests/vault-load-error.test.ts verifies the
      // emitted snippet contains both `. <path>` and `rm -f <path>`.
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
      const { listEntries } = await import("./commands/vault.js");
      const { name, absPath } = resolveVaultPath(args.ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Vault not found: vault:${name}`);
      }
      const entries = listEntries(absPath);
      output("vault-list", { ref: `vault:${name}`, path: absPath, entries });
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

// ── `akm events` ────────────────────────────────────────────────────────────
// Append-only events stream surface (#204). `list` reads `events.jsonl`
// with optional --since/--type/--ref filters; `tail` follows the file via
// a polling loop and prints each event as a single JSONL line.

const eventsListCommand = defineCommand({
  meta: { name: "list", description: "List events from the append-only events.jsonl stream" },
  args: {
    since: {
      type: "string",
      description: "ISO timestamp / epoch ms, OR `@offset:<bytes>` for a durable byte-cursor (resume across processes)",
    },
    type: { type: "string", description: "Filter by event type (add, remove, remember, feedback, ...)" },
    ref: { type: "string", description: "Filter by asset ref (type:name)" },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const result = akmEventsList({ since: args.since, type: args.type, ref: args.ref });
      output("events-list", result);
    });
  },
});

const eventsTailCommand = defineCommand({
  meta: { name: "tail", description: "Follow the append-only events.jsonl stream (polling)" },
  args: {
    since: {
      type: "string",
      description: "ISO timestamp / epoch ms, OR `@offset:<bytes>` for a durable byte-cursor (resume across processes)",
    },
    type: { type: "string", description: "Filter by event type" },
    ref: { type: "string", description: "Filter by asset ref (type:name)" },
    "interval-ms": { type: "string", description: "Polling interval in ms (default: 75)" },
    "max-duration-ms": { type: "string", description: "Stop after this many ms (default: never)" },
    "max-events": { type: "string", description: "Stop after observing this many events" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const intervalMs = parsePositiveInt(getHyphenatedArg<string>(args, "interval-ms"), "--interval-ms");
      const maxDurationMs = parsePositiveInt(getHyphenatedArg<string>(args, "max-duration-ms"), "--max-duration-ms");
      const maxEvents = parsePositiveInt(getHyphenatedArg<string>(args, "max-events"), "--max-events");
      const mode = getOutputMode();
      // In streaming text mode we want each event to print as soon as it
      // arrives. The polling loop emits via `onEvent`; the final result is
      // also rendered through the standard output() pipeline so JSON
      // consumers always get the canonical envelope.
      const stream = mode.format === "text" || mode.format === "jsonl";
      const result = await akmEventsTail({
        since: args.since,
        type: args.type,
        ref: args.ref,
        intervalMs,
        maxDurationMs,
        maxEvents,
        onEvent: stream
          ? (event) => {
              if (mode.format === "jsonl") {
                console.log(JSON.stringify(event));
              } else {
                console.log(formatEventLine(event as unknown as Record<string, unknown>));
              }
            }
          : undefined,
      });
      // Emit the canonical envelope last (JSON/YAML modes rely on this;
      // streaming modes already printed each event but we still emit a
      // trailer so callers can persist the resumable cursor).
      if (!stream) {
        output("events-tail", result);
      } else if (mode.format === "jsonl") {
        // Final discriminated trailer row so jsonl consumers can resume.
        const trailer = {
          _kind: "trailer",
          schemaVersion: 1,
          nextOffset: result.nextOffset,
          totalCount: result.totalCount,
          reason: result.reason,
        };
        console.log(JSON.stringify(trailer));
      } else {
        // text mode: keep stdout pristine for line-oriented parsers and
        // emit the trailer on stderr.
        process.stderr.write(
          `[events-tail] reason=${result.reason} nextOffset=${result.nextOffset} total=${result.totalCount}\n`,
        );
      }
    });
  },
});

function parsePositiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number.parseInt(trimmed, 10);
  if (Number.isNaN(value) || value <= 0) {
    throw new UsageError(`Invalid ${flag} value: "${raw}". Must be a positive integer.`, "INVALID_FLAG_VALUE");
  }
  return value;
}

const eventsCommand = defineCommand({
  meta: {
    name: "events",
    description: "Read or follow the append-only events.jsonl stream (mutations, feedback, indexing)",
  },
  subCommands: {
    list: eventsListCommand,
    tail: eventsTailCommand,
  },
});

// ── proposal substrate (#225) ────────────────────────────────────────────────

const proposalListCommand = defineCommand({
  meta: { name: "list", description: "List pending proposals (use --include-archive to see decided ones)" },
  args: {
    status: { type: "string", description: "Filter by status (pending|accepted|rejected)" },
    ref: { type: "string", description: "Filter by asset ref (type:name)" },
    "include-archive": {
      type: "boolean",
      description: "Include accepted/rejected proposals from the archive",
      default: false,
    },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const status = parseProposalStatus(args.status);
      const result = akmProposalList({
        status,
        ref: args.ref,
        includeArchive: getHyphenatedBoolean(args, "include-archive"),
      });
      output("proposal-list", result);
    });
  },
});

const proposalShowCommand = defineCommand({
  meta: { name: "show", description: "Show a proposal's metadata, payload, and validation report" },
  args: {
    id: { type: "positional", description: "Proposal id (uuid)", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const result = akmProposalShow({ id: args.id });
      output("proposal-show", result);
    });
  },
});

const proposalAcceptCommand = defineCommand({
  meta: { name: "accept", description: "Validate and promote a proposal to a real asset" },
  args: {
    id: { type: "positional", description: "Proposal id (uuid)", required: true },
    target: { type: "string", description: "Override the write target by source name" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await akmProposalAccept({ id: args.id, target: args.target });
      output("proposal-accept", result);
    });
  },
});

const proposalRejectCommand = defineCommand({
  meta: { name: "reject", description: "Archive a pending proposal with an optional reason" },
  args: {
    id: { type: "positional", description: "Proposal id (uuid)", required: true },
    reason: { type: "string", description: "Reason for rejection (recorded in the archived proposal)" },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const result = akmProposalReject({ id: args.id, reason: args.reason });
      output("proposal-reject", result);
    });
  },
});

const proposalDiffCommand = defineCommand({
  meta: { name: "diff", description: "Show the diff between an existing asset and a pending proposal" },
  args: {
    id: { type: "positional", description: "Proposal id (uuid)", required: true },
    target: { type: "string", description: "Override the write target by source name" },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const result = akmProposalDiff({ id: args.id, target: args.target });
      output("proposal-diff", result);
    });
  },
});

const proposalCommand = defineCommand({
  meta: {
    name: "proposal",
    description: "Review and promote queued asset proposals (durable storage under .akm/proposals/)",
  },
  subCommands: {
    list: proposalListCommand,
    show: proposalShowCommand,
    accept: proposalAcceptCommand,
    reject: proposalRejectCommand,
    diff: proposalDiffCommand,
  },
});

// ── distill (#228) ──────────────────────────────────────────────────────────

const distillCommand = defineCommand({
  meta: {
    name: "distill",
    description:
      "Distil feedback for an asset into a queued lesson proposal (gated on llm.features.feedback_distillation)",
  },
  args: {
    ref: { type: "positional", description: "Asset ref (type:name) to distil from", required: true },
    "source-run": {
      type: "string",
      description: "Optional run id propagated onto the queued proposal for traceability",
    },
    "exclude-feedback-from": {
      type: "string",
      description:
        "Comma-separated asset refs whose feedback events MUST be filtered out before the LLM input is built. Falls back to AKM_DISTILL_EXCLUDE_FEEDBACK_FROM when omitted.",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const excludeFlag = getHyphenatedArg(args, "exclude-feedback-from");
      const excludeEnv = process.env.AKM_DISTILL_EXCLUDE_FEEDBACK_FROM;
      // CLI flag takes precedence over the env var when both are present.
      const excludeRaw = excludeFlag ?? excludeEnv;
      const excludeFeedbackFromRefs = parseExcludeFeedbackFromRefs(excludeRaw);
      const result = await akmDistill({
        ref: args.ref,
        sourceRun: getHyphenatedArg(args, "source-run"),
        ...(excludeFeedbackFromRefs.length > 0 ? { excludeFeedbackFromRefs } : {}),
      });
      output("distill", result);
    });
  },
});

/**
 * Parse a comma-separated list of asset refs (#267 — `--exclude-feedback-from`
 * and `AKM_DISTILL_EXCLUDE_FEEDBACK_FROM`). Each entry is validated against
 * the canonical `[origin//]type:name` grammar via `parseAssetRef`; an
 * invalid entry surfaces as a UsageError → exit 2.
 */
function parseExcludeFeedbackFromRefs(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const refs = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  for (const ref of refs) {
    try {
      parseAssetRef(ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new UsageError(
        `Invalid --exclude-feedback-from ref "${ref}": ${message}`,
        "INVALID_FLAG_VALUE",
        "Each ref must match `[origin//]type:name`, e.g. skill:deploy or team//memory:auth-tips.",
      );
    }
  }
  return refs;
}

function parseProposalStatus(raw: string | undefined): "pending" | "accepted" | "rejected" | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed === "pending" || trimmed === "accepted" || trimmed === "rejected") return trimmed;
  throw new UsageError(
    `Invalid --status value: "${raw}". Expected one of: pending, accepted, rejected.`,
    "INVALID_FLAG_VALUE",
  );
}

// ── reflect / propose (agent proposal-producers, #226) ──────────────────────

const reflectCommand = defineCommand({
  meta: {
    name: "reflect",
    description: "Ask the configured agent CLI to review an asset (or recent feedback) and queue a revised proposal",
  },
  args: {
    ref: {
      type: "positional",
      description: "Asset ref (type:name) to reflect on. Optional — omit to reflect across recent feedback.",
      required: false,
    },
    task: { type: "string", description: "Optional task hint passed into the reflection prompt" },
    profile: { type: "string", description: "Override the agent profile (defaults to agent.default)" },
    "timeout-ms": { type: "string", description: "Override the agent CLI timeout in milliseconds" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const timeoutRaw = (args as Record<string, unknown>)["timeout-ms"];
      const timeoutMs =
        typeof timeoutRaw === "string" && timeoutRaw.trim() ? Number.parseInt(timeoutRaw, 10) : undefined;
      const result = await akmReflect({
        ref: typeof args.ref === "string" && args.ref.trim() ? args.ref : undefined,
        task: typeof args.task === "string" && args.task.trim() ? args.task : undefined,
        profile: typeof args.profile === "string" && args.profile.trim() ? args.profile : undefined,
        ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      });
      output("reflect", result);
      if (result.ok === false) {
        process.exit(EXIT_GENERAL);
      }
    });
  },
});

const proposeCommand = defineCommand({
  meta: {
    name: "propose",
    description: "Ask the configured agent CLI to author a brand-new asset and queue it as a proposal",
  },
  args: {
    // Optional in citty so run() is invoked when omitted; we re-validate
    // below to surface a structured UsageError (exit 2) instead of citty's
    // default help-banner exit-0.
    type: { type: "positional", description: "Asset type (skill, command, knowledge, lesson, ...)", required: false },
    name: { type: "positional", description: "Asset name (slug or path under the type dir)", required: false },
    task: { type: "string", description: "Task description for the agent (what should the asset do?)" },
    profile: { type: "string", description: "Override the agent profile (defaults to agent.default)" },
    "timeout-ms": { type: "string", description: "Override the agent CLI timeout in milliseconds" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      // citty silently shows help and exits 0 when required positionals are
      // omitted. Re-validate explicitly so the exit code is 2 (USAGE) and a
      // structured JSON error reaches scripted callers.
      if (!args.type || !args.name || !args.task) {
        throw new UsageError(
          "Usage: akm propose <type> <name> --task '<task>'.",
          "MISSING_REQUIRED_ARGUMENT",
          "Provide the asset type, name, and a --task description, e.g. `akm propose skill deploy --task 'Deploy a service'`.",
        );
      }
      const timeoutRaw = (args as Record<string, unknown>)["timeout-ms"];
      const timeoutMs =
        typeof timeoutRaw === "string" && timeoutRaw.trim() ? Number.parseInt(timeoutRaw, 10) : undefined;
      const result = await akmPropose({
        type: String(args.type),
        name: String(args.name),
        task: String(args.task ?? ""),
        profile: typeof args.profile === "string" && args.profile.trim() ? args.profile : undefined,
        ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      });
      output("propose", result);
      if (result.ok === false) {
        process.exit(EXIT_GENERAL);
      }
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
    format: { type: "string", description: "Output format (json|jsonl|text|yaml)", default: "json" },
    detail: { type: "string", description: "Detail level (brief|normal|full|summary|agent)", default: "brief" },
    quiet: { type: "boolean", alias: "q", description: "Suppress stderr warnings", default: false },
    verbose: {
      type: "boolean",
      description: "Print per-spec diagnostics to stderr (also honours AKM_VERBOSE env var)",
      default: false,
    },
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
    history: historyCommand,
    events: eventsCommand,
    proposal: proposalCommand,
    reflect: reflectCommand,
    propose: proposeCommand,
    distill: distillCommand,
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
    // Apply --verbose flag early so per-spec diagnostics (gated behind
    // `isVerbose()` in src/core/warn.ts) are restored. The `AKM_VERBOSE`
    // env var still wins regardless — see warn.ts for the precedence rule.
    if (process.argv.includes("--verbose")) {
      setVerbose(true);
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
