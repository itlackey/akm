#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import { hasSubcommand, parsePositiveIntFlag } from "./cli/parse-args";
import { akmAgentDispatch } from "./commands/agent-dispatch";
import { generateBashCompletions, installBashCompletions } from "./commands/completions";
import { getConfigValue, listConfig, setConfigValue, unsetConfigValue } from "./commands/config-cli";
import { akmCurate } from "./commands/curate";
import { akmEventsList, akmEventsTail } from "./commands/events";
import { akmHistory } from "./commands/history";
import { akmImprove } from "./commands/improve";
import { assembleInfo } from "./commands/info";
import { akmInit } from "./commands/init";
import { akmListSources, akmRemove, akmUpdate } from "./commands/installed-stashes";
import { readKnowledgeInput, writeMarkdownAsset } from "./commands/knowledge";
import { akmLint } from "./commands/lint";
import { renderMigrationHelp } from "./commands/migration-help";
import {
  akmProposalAccept,
  akmProposalDiff,
  akmProposalList,
  akmProposalReject,
  akmProposalShow,
} from "./commands/proposal";
import { akmPropose } from "./commands/propose";
import { searchRegistry } from "./commands/registry-search";
import {
  buildMemoryFrontmatter,
  parseDuration,
  readMemoryContent,
  resolveRememberContentArg,
  runAutoHeuristics,
  runLlmEnrich,
} from "./commands/remember";
import { akmSearch, parseBeliefFilterMode, parseScopeFilterFlags, parseSearchSource } from "./commands/search";
import { checkForUpdate, performUpgrade } from "./commands/self-update";
import { akmShowUnified, normalizeShowArgv } from "./commands/show";
import { akmAdd } from "./commands/source-add";
import { akmClone } from "./commands/source-clone";
import { addStash } from "./commands/source-manage";
import {
  akmTasksAdd,
  akmTasksDoctor,
  akmTasksHistory,
  akmTasksList,
  akmTasksRemove,
  akmTasksRun,
  akmTasksSetEnabled,
  akmTasksShow,
  akmTasksSync,
  parseTaskRef,
} from "./commands/tasks";
import { parseAssetRef } from "./core/asset-ref";
import { deriveCanonicalAssetName, resolveAssetPathFromName } from "./core/asset-spec";
import { isHttpUrl, resolveStashDir } from "./core/common";
import type { RegistryConfigEntry } from "./core/config";
import { DEFAULT_CONFIG, loadConfig, loadUserConfig, resolveConfiguredSources, saveConfig } from "./core/config";
import { ConfigError, NotFoundError, UsageError } from "./core/errors";
import { appendEvent } from "./core/events";
import { getCacheDir, getConfigPath, getDbPath, getDefaultStashDir } from "./core/paths";
import { clearLogFile, setLogFile, setQuiet, setVerbose, warn } from "./core/warn";
import { applyFeedbackToUtilityScore, closeDatabase, findEntryIdByRef, openExistingDatabase } from "./indexer/db";
import { ensureIndex } from "./indexer/ensure-index";
import { akmIndex } from "./indexer/indexer";
import { type SearchSource as IndexSearchSource, resolveSourceEntries } from "./indexer/search-source";
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
      "Interactive configuration wizard. Configures embeddings/LLM connections (for indexing/enrichment), agent profiles (CLI agent, embedded SDK, or none), sources, and registries. Shows which features are enabled at the end. Use --config <json> or --yes for non-interactive/scripting mode.",
  },
  args: {
    config: {
      type: "string",
      description: 'Config JSON to apply non-interactively, e.g. \'{"llm":{"endpoint":"...","model":"..."}}\'',
    },
    yes: {
      type: "boolean",
      default: false,
      description: "Accept all defaults, skip all prompts. Idempotent — safe to run in CI.",
    },
    dir: {
      type: "string",
      description: "Stash directory path (overrides stashDir in config or --config JSON)",
    },
    probe: {
      type: "boolean",
      default: false,
      description: "Probe LLM/embedding endpoints after writing config to verify connectivity",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const noInit = getHyphenatedBoolean(args, "no-init");
      if (args.config) {
        // Non-interactive config mode
        const { runSetupFromConfig } = await import("./setup/setup");
        const result = await runSetupFromConfig({
          configJson: args.config,
          dir: args.dir,
          noInit,
          probe: args.probe,
        });
        output("setup", result);
      } else if (args.yes) {
        // Defaults mode — no prompts
        const { runSetupWithDefaults } = await import("./setup/setup");
        const result = await runSetupWithDefaults({
          dir: args.dir,
          noInit,
          probe: args.probe,
        });
        output("setup", result);
      } else {
        // Interactive wizard
        const { runSetupWizard } = await import("./setup/setup");
        await runSetupWizard({ dir: args.dir, noInit });
      }
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
    enrich: { type: "boolean", description: "Enable LLM inference and enrichment passes", default: false },
    verbose: { type: "boolean", description: "Print phase-by-phase indexing progress to stderr", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const outputMode = getOutputMode();
      const controller = new AbortController();
      const abort = (): void => controller.abort(new Error("index interrupted"));
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      const spin = !args.verbose && outputMode.format === "text" ? p.spinner() : null;
      if (spin) {
        spin.start(`Building search index${args.full ? " (full rebuild)" : ""}...`);
      }
      let latestMessage = "";
      try {
        const result = await akmIndex({
          full: args.full,
          enrich: args.enrich,
          onProgress: ({ message, processed, total }) => {
            latestMessage = message;
            const progressPrefix = processed !== undefined && total !== undefined ? `[${processed}/${total}] ` : "";
            if (args.verbose) {
              console.error(`[index] ${progressPrefix}${message}`);
            } else if (spin) {
              spin.stop(`${progressPrefix}${message}`);
              spin.start(`${progressPrefix}${message}`);
            }
          },
          signal: controller.signal,
        });
        if (spin) {
          spin.stop(`Indexed ${result.totalEntries} assets.`);
        }
        output("index", result);
      } catch (error) {
        if (spin) {
          spin.stop(latestMessage ? `Indexing failed after: ${latestMessage}` : "Indexing failed.");
        }
        throw error;
      } finally {
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
      }
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
    belief: {
      type: "string",
      description:
        "Memory belief filter: all|current|historical. current keeps active memory beliefs; historical keeps contradicted/superseded/archived memory beliefs.",
      default: "all",
    },
    format: { type: "string", description: "Output format (json|jsonl|text|yaml)" },
    detail: { type: "string", description: "Detail level (brief|normal|full|summary|agent)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      // An empty query enumerates all indexed assets (list mode).
      // The guard that rejected empty queries was removed; akmSearch handles
      // empty strings end-to-end via getAllEntries (DB path) and the
      // substring-search fallback's query-less branch.
      const query = (args.query ?? "").trim();
      const type = args.type as string | undefined;
      const limit = parsePositiveIntFlag(args.limit ?? undefined);
      const source = parseSearchSource(args.source);
      // Repeatable; citty exposes only the last `--filter` value, so read all
      // occurrences directly from argv (same pattern as `--tag`).
      const filterTokens = parseAllFlagValues("--filter");
      const filters = parseScopeFilterFlags(filterTokens, "--filter");
      const includeProposed = (args as Record<string, unknown>)["include-proposed"] === true;
      const belief = parseBeliefFilterMode(typeof args.belief === "string" ? args.belief : undefined);
      const result = await akmSearch({ query, type, limit, source, filters, includeProposed, belief });
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
      const limitParsed = parsePositiveIntFlag(args.limit ?? undefined);
      const limit = limitParsed && limitParsed > 0 ? limitParsed : 4;
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
      const subcommand = Array.isArray(args._) ? args._[0] : undefined;
      if (subcommand === "proposal") {
        const proposalId = Array.isArray(args._) ? args._[1] : undefined;
        if (typeof proposalId !== "string" || !proposalId.trim()) {
          throw new UsageError("Usage: akm show proposal <id>", "MISSING_REQUIRED_ARGUMENT");
        }
        const result = akmProposalShow({ id: proposalId.trim() });
        output("proposal-show", result);
        return;
      }
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
    show: defineCommand({
      meta: { name: "show", description: "Alias for `akm config list` — list current configuration" },
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
      if (hasSubcommand(args, CONFIG_SUBCOMMAND_SET)) return;
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
      if (effectiveName === undefined) {
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
          const limitRaw = parsePositiveIntFlag(args.limit ?? undefined);
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

const TAG_KEY_RE = /^[a-z_][a-z0-9_]*$/;
const MAX_FEEDBACK_TAGS = 10;

function validateFeedbackTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of raw) {
    const parts = tag.split(":");
    if (parts.length < 2 || parts[0] === "" || parts.slice(1).join("") === "") {
      throw new UsageError(
        `Invalid tag "${tag}". Tags must be in key:value format where key matches [a-z_][a-z0-9_]* and value is non-empty.`,
        "INVALID_FLAG_VALUE",
      );
    }
    const key = parts[0];
    if (!TAG_KEY_RE.test(key)) {
      throw new UsageError(
        `Invalid tag key "${key}" in "${tag}". Key must match [a-z_][a-z0-9_]*.`,
        "INVALID_FLAG_VALUE",
      );
    }
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  if (out.length > MAX_FEEDBACK_TAGS) {
    throw new UsageError(`Too many tags: ${out.length}. Maximum is ${MAX_FEEDBACK_TAGS}.`, "INVALID_FLAG_VALUE");
  }
  return out;
}

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
    reason: {
      type: "string",
      description: "Reason for the feedback (recommended for negative feedback, used by distillation)",
    },
    note: { type: "string", description: "Alias for --reason (backward-compatible, prefer --reason)" },
    tag: {
      type: "string",
      description: "Tag to attach to the feedback (repeatable, e.g. --tag slice:train --tag team:platform)",
    },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
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
      const reason = (args.reason as string | undefined) ?? (args.note as string | undefined);
      if (args.negative === true && !reason?.trim()) {
        const cfg = loadConfig();
        if (cfg.feedback?.requireReason === true) {
          throw new UsageError(
            "Negative feedback requires --reason (feedback.requireReason is enabled).",
            "MISSING_REQUIRED_ARGUMENT",
          );
        } else {
          warn("Warning: negative feedback without --reason provides less distillation signal.");
        }
      }
      const rawTags = parseAllFlagValues("--tag");
      const validatedTags = validateFeedbackTags(rawTags);
      const metadataObj = {
        signal,
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
        ...(validatedTags.length > 0 ? { tags: validatedTags } : {}),
      };
      const metadataStr = Object.keys(metadataObj).length > 1 ? JSON.stringify(metadataObj) : undefined;

      // Auto-index when stale so the index is current before recording feedback.
      const sources = resolveSourceEntries();
      if (sources.length > 0) {
        await ensureIndex(sources[0].path);
      }

      const db = openExistingDatabase();
      try {
        const entryId = findEntryIdByRef(db, ref);
        if (entryId === undefined) {
          throw new UsageError(
            `Ref "${ref}" is not in the index. ` +
              "Run 'akm search' to verify the asset exists, then 'akm index' if it was recently added.",
          );
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
          metadata: metadataStr,
        });

        // Apply feedback-derived utility score adjustment immediately so that
        // positive/negative signals influence search ranking without requiring
        // a full reindex. We query the total accumulated feedback counts from
        // usage_events so the delta reflects the entire signal history.
        try {
          const counts = db
            .prepare(
              `SELECT
                 SUM(CASE WHEN signal = 'positive' THEN 1 ELSE 0 END) AS pos,
                 SUM(CASE WHEN signal = 'negative' THEN 1 ELSE 0 END) AS neg
               FROM usage_events
               WHERE event_type = 'feedback' AND entry_id = ?`,
            )
            .get(entryId) as { pos: number | null; neg: number | null } | undefined;
          const pos = counts?.pos ?? 0;
          const neg = counts?.neg ?? 0;
          applyFeedbackToUtilityScore(db, entryId, pos, neg);
        } catch {
          // best-effort — feedback recording succeeds even if utility update fails
        }
      } finally {
        closeDatabase(db);
      }

      appendEvent({
        eventType: "feedback",
        ref,
        metadata: metadataObj,
      });
      output("feedback", { ok: true, ref, signal, reason: reason?.trim() ?? null, tags: validatedTags });
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

const workflowStartCommand = defineCommand({
  meta: {
    name: "start",
    description: "Start a new workflow run in the current working scope",
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
    description:
      "Show the next actionable workflow step in the current scope, auto-starting a run when passed a workflow ref",
  },
  args: {
    target: { type: "positional", description: "Workflow run id or workflow ref", required: true },
    params: { type: "string", description: "Workflow parameters as a JSON object (only for auto-started runs)" },
    "dry-run": { type: "boolean", description: "Not supported — rejected with an error", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      if (getHyphenatedBoolean(args, "dry-run")) {
        throw new UsageError(
          "`akm workflow next` does not support --dry-run. Remove the flag to start or resume a run.",
          "INVALID_FLAG_VALUE",
        );
      }
      const parsedParams = args.params ? parseWorkflowJsonObject(args.params, "--params") : undefined;
      // If the target looks like a UUID-style run id (no `:` and matches the
      // run-id shape), short-circuit with a structured WORKFLOW_NOT_FOUND
      // error before parseAssetRef gets to throw an unhelpful ref-parse error.
      if (looksLikeWorkflowRunId(args.target)) {
        const { hasWorkflowRun } = await import("./workflows/runs.js");
        if (!(await hasWorkflowRun(args.target))) {
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
      const result = await completeWorkflowStep({
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
    description: "Show full workflow run state for review or resume; workflow refs resolve within the current scope",
  },
  args: {
    target: { type: "positional", description: "Workflow run id or workflow ref (workflow:<name>)", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
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
        const { runs } = await listWorkflowRuns({ workflowRef: ref });
        if (runs.length === 0) {
          throw new NotFoundError(`No workflow runs found for ${ref}`, "WORKFLOW_NOT_FOUND");
        }
        const mostRecent = runs[0];
        if (!mostRecent) throw new NotFoundError(`No workflow runs found for ${ref}`, "WORKFLOW_NOT_FOUND");
        const result = await getWorkflowStatus(mostRecent.id);
        output("workflow-status", result);
      } else {
        const result = await getWorkflowStatus(target);
        output("workflow-status", result);
      }
    });
  },
});

const workflowListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List workflow runs in the current working scope",
  },
  args: {
    ref: { type: "string", description: "Filter to one workflow ref" },
    active: { type: "boolean", description: "Only show active runs", default: false },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const result = await listWorkflowRuns({ workflowRef: args.ref, activeOnly: args.active });
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
    return runWithJsonErrors(async () => {
      const result = await resumeWorkflowRun(args.runId);
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
    return runWithJsonErrors(async () => {
      if (hasWorkflowSubcommand(args)) return;
      output("workflow-list", await listWorkflowRuns({ activeOnly: true }));
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
    showSimilar: {
      type: "boolean",
      description: "Return top-3 similar existing memories in output (opt-in)",
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
        if (args.showSimilar) {
          const similar = await fetchSimilarMemories(body.slice(0, 500), result.ref);
          output("remember", { ok: true, ...result, similar });
        } else {
          output("remember", { ok: true, ...result });
        }
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
      if (args.showSimilar) {
        const similar = await fetchSimilarMemories((body ?? args.content ?? "").slice(0, 500), result.ref);
        output("remember", { ok: true, ...result, similar });
      } else {
        output("remember", { ok: true, ...result });
      }
    });
  },
});

/**
 * Best-effort top-3 similar memory search for `--show-similar`.
 * Scoped to memory: type; excludes the just-written ref.
 */
async function fetchSimilarMemories(
  query: string,
  excludeRef: string,
): Promise<Array<{ ref: string; title?: string }>> {
  try {
    const result = await akmSearch({ query, type: "memory", limit: 4 });
    return (result.hits ?? [])
      .filter(
        (h): h is import("./sources/types").SourceSearchHit => "ref" in h && (h as { ref: string }).ref !== excludeRef,
      )
      .slice(0, 3)
      .map((h) => ({ ref: h.ref, ...(h.name ? { title: h.name } : {}) }));
  } catch {
    return [];
  }
}

const importKnowledgeCommand = defineCommand({
  meta: {
    name: "import",
    description: "Import a knowledge document or URL into the default stash",
  },
  args: {
    source: {
      type: "positional",
      description: 'Source file path, URL, or "-" to read from stdin',
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
      const { content, preferredName } = await readKnowledgeInput(args.source);
      const result = await writeMarkdownAsset({
        type: "knowledge",
        content,
        name: args.name ?? (isHttpUrl(args.source) ? preferredName : undefined),
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
// `akm vault` manages secrets stored in `.env` files under each stash's
// vaults/ directory. Values are NEVER written to stdout or structured output.

function parseVaultRef(ref: string): ReturnType<typeof parseAssetRef> {
  return parseAssetRef(ref.includes(":") ? ref : `vault:${ref}`);
}

function findVaultSource(origin: string | undefined): IndexSearchSource {
  const sources = resolveSourceEntries(undefined, loadConfig());
  if (sources.length === 0) {
    throw new UsageError("No stashes configured. Run `akm init` to create your working stash.");
  }
  if (!origin || origin === "local") return sources[0];
  const named = sources.find((source) => source.registryId === origin);
  if (!named) {
    throw new NotFoundError(`Source not found for origin: ${origin}`);
  }
  return named;
}

function makeVaultRef(name: string, source?: IndexSearchSource): string {
  return source?.registryId ? `${source.registryId}//vault:${name}` : `vault:${name}`;
}

function resolveVaultPath(ref: string): {
  name: string;
  absPath: string;
  source: IndexSearchSource;
  parsedRef: ReturnType<typeof parseAssetRef>;
} {
  const parsed = parseVaultRef(ref);
  if (parsed.type !== "vault") {
    throw new UsageError(`Expected a vault ref (vault:<name>); got "${ref}".`);
  }
  const source = findVaultSource(parsed.origin);
  const typeRoot = path.join(source.path, "vaults");
  const absPath = resolveAssetPathFromName("vault", typeRoot, parsed.name);
  return { name: parsed.name, absPath, source, parsedRef: parsed };
}

/**
 * Walk `vaults/` recursively and return one entry per `.env` file, using the
 * vault asset spec's canonical-name logic so listing matches what the
 * matcher/asset-spec actually resolves (e.g. `vaults/team/prod.env` →
 * `vault:team/prod`, `vaults/team/.env` → `vault:team/default`).
 */
function listVaultsRecursive(
  listKeysFn: (vaultPath: string) => { keys: string[] },
): Array<{ ref: string; path: string; keys: string[] }> {
  const result: Array<{ ref: string; path: string; keys: string[] }> = [];
  for (const source of resolveSourceEntries(undefined, loadConfig())) {
    const vaultsDir = path.join(source.path, "vaults");
    if (!fs.existsSync(vaultsDir)) continue;

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
        result.push({ ref: makeVaultRef(canonical, source), path: full, keys });
      }
    };
    walk(vaultsDir);
  }
  return result;
}

function splitVaultRunTarget(target: string): { ref: string; key?: string } {
  const full = resolveVaultPath(target);
  if (fs.existsSync(full.absPath)) {
    return { ref: makeVaultRef(full.name, full.source) };
  }

  const slashIndex = target.lastIndexOf("/");
  if (slashIndex <= 0) {
    throw new NotFoundError(`Vault not found: ${target.includes(":") ? target : `vault:${target}`}`);
  }

  const refPart = target.slice(0, slashIndex);
  const key = target.slice(slashIndex + 1).trim();
  if (!key) {
    throw new UsageError("Expected vault run target in the form <ref> or <ref/KEY>.");
  }
  const resolved = resolveVaultPath(refPart);
  if (!fs.existsSync(resolved.absPath)) {
    throw new NotFoundError(`Vault not found: ${makeVaultRef(resolved.name, resolved.source)}`);
  }
  return { ref: makeVaultRef(resolved.name, resolved.source), key };
}

const vaultListCommand = defineCommand({
  meta: { name: "list", description: "List all vaults across all stashes with their available key names (no values)" },
  run() {
    return runWithJsonErrors(async () => {
      const { listKeys } = await import("./commands/vault.js");
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
      const { name, absPath, source } = resolveVaultPath(args.name);
      createVault(absPath);
      output("vault-create", { ref: makeVaultRef(name, source), path: absPath });
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
      const { name, absPath, source } = resolveVaultPath(args.ref);

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
      output("vault-set", { ref: makeVaultRef(name, source), key: realKey, path: absPath });
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
      const { name, absPath, source } = resolveVaultPath(args.ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Vault not found: ${makeVaultRef(name, source)}`);
      }
      const removed = unsetKey(absPath, args.key);
      output("vault-unset", { ref: makeVaultRef(name, source), key: args.key, removed, path: absPath });
    });
  },
});

const vaultPathCommand = defineCommand({
  meta: {
    name: "path",
    description:
      'Print the absolute vault file path so you can load it directly, e.g. `source "$(akm vault path vault:prod)"`.',
  },
  args: {
    ref: { type: "positional", description: "Vault ref", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { name, absPath, source } = resolveVaultPath(args.ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Vault not found: ${makeVaultRef(name, source)}`);
      }
      process.stdout.write(`${absPath}\n`);
    });
  },
});

const vaultRunCommand = defineCommand({
  meta: {
    name: "run",
    description:
      "Run a command with env injected from a vault or a single vault key: `akm vault run <ref[/KEY]> -- <command>`",
  },
  args: {
    target: { type: "positional", description: "Vault ref or ref/key target", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const dashIndex = process.argv.indexOf("--");
      if (dashIndex < 0 || dashIndex === process.argv.length - 1) {
        throw new UsageError("Missing command. Usage: akm vault run <ref[/KEY]> -- <command>");
      }

      const command = process.argv.slice(dashIndex + 1);
      const { loadEnv } = await import("./commands/vault.js");
      const { ref, key } = splitVaultRunTarget(args.target);
      const { name, absPath, source } = resolveVaultPath(ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Vault not found: ${makeVaultRef(name, source)}`);
      }

      const envValues = loadEnv(absPath);
      const mergedEnv = { ...process.env };
      if (key) {
        if (!(key in envValues)) {
          throw new NotFoundError(`Key not found in ${makeVaultRef(name, source)}: ${key}`);
        }
        mergedEnv[key] = envValues[key];
      } else {
        for (const [envKey, envValue] of Object.entries(envValues)) {
          mergedEnv[envKey] = envValue;
        }
      }

      const result = spawnSync(command[0] as string, command.slice(1), {
        stdio: "inherit",
        env: mergedEnv,
      });
      if (result.error) throw result.error;
      process.exit(result.status ?? 0);
    });
  },
});

const vaultCommand = defineCommand({
  meta: {
    name: "vault",
    description:
      "Manage secret vaults (.env files). Keys are visible, values stay on disk and never appear in structured output.",
  },
  subCommands: {
    list: vaultListCommand,
    path: vaultPathCommand,
    run: vaultRunCommand,
    create: vaultCreateCommand,
    set: vaultSetCommand,
    unset: vaultUnsetCommand,
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      if (hasSubcommand(args, VAULT_SUBCOMMAND_SET)) return;
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
      "Copy a source into wikis/<name>/raw/<slug>.md with frontmatter. Source may be a file path, URL, or '-' for stdin.",
  },
  args: {
    name: { type: "positional", description: "Wiki name", required: true },
    source: { type: "positional", description: "Source file path, URL, or '-' to read from stdin", required: true },
    as: { type: "string", description: "Preferred slug base (defaults to source filename or first-line slug)" },
    target: {
      type: "string",
      description:
        "Name of a writable stash source to write into instead of the default stash. Must match a configured source name (run `akm list` to see sources).",
    },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { stashRaw } = await import("./wiki/wiki.js");
      const { content, preferredName } = await readKnowledgeInput(args.source);

      let stashDir: string;
      if (args.target) {
        // Resolve the named source to its filesystem path.
        const cfg = loadConfig();
        const sources = resolveConfiguredSources(cfg);
        const match = sources.find((s) => s.name === args.target);
        if (!match) {
          throw new UsageError(
            `--target must reference a configured source name. No source named "${args.target}" found. Run \`akm list\` to see available sources.`,
            "INVALID_FLAG_VALUE",
          );
        }
        const spec = match.source;
        if (spec.type !== "filesystem" && spec.type !== "local") {
          throw new ConfigError(
            `Source "${args.target}" is not a filesystem source and cannot be used as a wiki stash target.`,
            "INVALID_CONFIG_FILE",
            `Use a source with type "filesystem" or "local", or omit --target to use the default stash.`,
          );
        }
        stashDir = spec.path;
      } else {
        stashDir = resolveStashDir();
      }

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
      if (hasSubcommand(args, WIKI_SUBCOMMAND_SET)) return;
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
    "exclude-tags": {
      type: "string",
      description: "Exclude events matching these tags (repeatable)",
    },
    "include-tags": {
      type: "string",
      description: "Only include events with ALL these tags (repeatable)",
    },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const excludeTags = parseAllFlagValues("--exclude-tags");
      const includeTags = parseAllFlagValues("--include-tags");
      const result = akmEventsList({
        since: args.since,
        type: args.type,
        ref: args.ref,
        ...(excludeTags.length > 0 ? { excludeTags } : {}),
        ...(includeTags.length > 0 ? { includeTags } : {}),
      });
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
    "exclude-tags": {
      type: "string",
      description: "Exclude events matching these tags (repeatable)",
    },
    "include-tags": {
      type: "string",
      description: "Only include events with ALL these tags (repeatable)",
    },
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
      const excludeTags = parseAllFlagValues("--exclude-tags");
      const includeTags = parseAllFlagValues("--include-tags");
      const result = await akmEventsTail({
        since: args.since,
        type: args.type,
        ref: args.ref,
        intervalMs,
        maxDurationMs,
        maxEvents,
        ...(excludeTags.length > 0 ? { excludeTags } : {}),
        ...(includeTags.length > 0 ? { includeTags } : {}),
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

const proposalsCommand = defineCommand({
  meta: { name: "proposals", description: "List proposal queue entries" },
  args: {
    status: { type: "string", description: "Filter by status (pending|accepted|rejected)" },
    ref: { type: "string", description: "Filter by asset ref (type:name)" },
    type: { type: "string", description: "Filter by asset type" },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const status = parseProposalStatus(args.status);
      const result = akmProposalList({
        status,
        ref: args.ref,
        includeArchive: status === "accepted" || status === "rejected",
      });
      output("proposal-list", result);
    });
  },
});

const acceptCommand = defineCommand({
  meta: { name: "accept", description: "Accept a proposal and promote it into the stash" },
  args: {
    id: {
      type: "positional",
      description: "Proposal id (uuid / prefix) or asset ref (e.g. skill:akm-dream)",
      required: true,
    },
    target: { type: "string", description: "Override the write target by source name" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await akmProposalAccept({ id: args.id, target: args.target });
      output("proposal-accept", result);
    });
  },
});

const rejectCommand = defineCommand({
  meta: { name: "reject", description: "Reject a proposal and record the reason" },
  args: {
    id: {
      type: "positional",
      description: "Proposal id (uuid / prefix) or asset ref (e.g. skill:akm-dream)",
      required: true,
    },
    reason: { type: "string", description: "Reason for rejection (required)" },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      if (!args.reason || !String(args.reason).trim()) {
        throw new UsageError("Usage: akm reject <id> --reason '<reason>'", "MISSING_REQUIRED_ARGUMENT");
      }
      const result = akmProposalReject({ id: args.id, reason: args.reason });
      output("proposal-reject", result);
    });
  },
});

const diffCommand = defineCommand({
  meta: { name: "diff", description: "Show the diff for a proposal (accepts full UUID, UUID prefix, or asset ref)" },
  args: {
    id: {
      type: "positional",
      description: "Proposal id (uuid / prefix) or asset ref (e.g. skill:akm-dream)",
      required: true,
    },
    target: { type: "string", description: "Override the write target by source name" },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      const result = akmProposalDiff({ id: args.id, target: args.target });
      output("proposal-diff", result);
    });
  },
});

// ── distill (#228) ──────────────────────────────────────────────────────────

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

const agentCommand = defineCommand({
  meta: {
    name: "agent",
    description:
      "Dispatch an agent by named profile, optionally injecting a prompt from inline text, a stash command: asset, or a stash workflow: asset",
  },
  args: {
    profile: {
      type: "positional",
      description: "Agent profile name (from config.agent.profiles or a built-in)",
      required: false,
    },
    prompt: { type: "string", description: "Inline prompt text to pass to the agent" },
    command: { type: "string", description: "Load the body of a command: asset from the index and use as the prompt" },
    workflow: {
      type: "string",
      description: "Load the body of a workflow: asset from the index and use as the prompt",
    },
    "timeout-ms": { type: "string", description: "Override the agent CLI timeout in milliseconds" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      if (!args.profile) {
        throw new UsageError(
          "Usage: akm agent <profile> [--prompt <text>] [--command <ref>] [--workflow <ref>] [args...]",
          "MISSING_REQUIRED_ARGUMENT",
          "Provide the agent profile name. Available profiles are listed in config.agent.profiles.",
        );
      }

      // Collect extra positional args (forwarded to the agent and used as
      // template placeholders when a command/workflow ref is specified).
      const extraArgs = Array.isArray(args._) ? (args._ as string[]).filter((a) => a !== args.profile) : [];

      const timeoutRaw = (args as Record<string, unknown>)["timeout-ms"];
      const timeoutMs =
        typeof timeoutRaw === "string" && timeoutRaw.trim() ? Number.parseInt(timeoutRaw, 10) : undefined;

      const config = loadConfig();
      const { parseAgentConfig } = await import("./integrations/agent/config.js");
      const agentConfig = parseAgentConfig(config.agent);

      const result = await akmAgentDispatch({
        profileName: String(args.profile),
        prompt: typeof args.prompt === "string" ? args.prompt : undefined,
        commandRef: typeof args.command === "string" && args.command.trim() ? args.command.trim() : undefined,
        workflowRef: typeof args.workflow === "string" && args.workflow.trim() ? args.workflow.trim() : undefined,
        args: extraArgs.length > 0 ? extraArgs : undefined,
        agentConfig,
        llmConfig: config.llm,
        ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      });

      output("agent-result", result);

      if (!result.ok) {
        process.exit(EXIT_GENERAL);
      }
    });
  },
});

const lintCommand = defineCommand({
  meta: {
    name: "lint",
    description:
      "Scan stash .md files for structural issues (unquoted colons, missing updated field, orphaned stubs, placeholder stubs, missing name/type, stale paths). Use --fix to auto-fix Tier 1 issues.",
  },
  args: {
    fix: { type: "boolean", description: "Apply auto-fixes in place", default: false },
    dir: { type: "string", description: "Override stash root directory (default: from config)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = akmLint({
        fix: args.fix ?? false,
        dir: typeof args.dir === "string" && args.dir.trim() ? args.dir.trim() : undefined,
      });
      output("lint", result);
      if (!result.ok) process.exit(EXIT_GENERAL);
    });
  },
});

const improveCommand = defineCommand({
  meta: {
    name: "improve",
    description:
      "Analyze existing AKM assets and generate improvement proposals; also consolidates memories when llm.features.memory_consolidation is enabled",
  },
  args: {
    scope: {
      type: "positional",
      description: "Optional asset type or asset ref to improve",
      required: false,
    },
    task: { type: "string", description: "Add extra guidance for this improvement pass" },
    "dry-run": { type: "boolean", description: "Show planned actions without writing", default: false },
    target: { type: "string", description: "Override the write target for accepted proposals" },
    "auto-accept": {
      type: "string",
      description: "Automatically accept low-risk proposals (only 'safe' is supported)",
    },
    limit: { type: "string", description: "Maximum number of assets to process (highest utility first)" },
    "timeout-ms": {
      type: "string",
      description: "Wall-clock budget for the entire run in milliseconds (default: 7200000 = 2 hours)",
    },
    "reflect-cooldown-days": {
      type: "string",
      description: "Days before re-reflecting a recently reflected asset (default: 7, 0 to disable)",
    },
    "distill-cooldown-days": {
      type: "string",
      description: "Days before re-distilling an asset with a recent accepted proposal (default: 30, 0 to disable)",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const autoAcceptRaw = getHyphenatedArg<string>(args, "auto-accept");
      if (autoAcceptRaw !== undefined && autoAcceptRaw !== "safe") {
        throw new UsageError("--auto-accept only supports the value 'safe'.", "INVALID_FLAG_VALUE");
      }
      const targetArg = typeof args.target === "string" && args.target.trim() ? args.target.trim() : undefined;
      const taskArg = typeof args.task === "string" && args.task.trim() ? args.task : undefined;
      const dryRun = getHyphenatedBoolean(args, "dry-run");
      const autoAccept = autoAcceptRaw === "safe" ? ("safe" as const) : undefined;
      const limitRaw = parsePositiveIntFlag(args.limit ?? undefined);
      const timeoutRaw = getHyphenatedArg<string>(args, "timeout-ms");
      const timeoutMs = timeoutRaw !== undefined ? parseInt(timeoutRaw, 10) : undefined;
      if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
        throw new UsageError(`Invalid --timeout-ms value: "${timeoutRaw}". Must be a positive integer.`);
      }
      const reflectCooldownRaw = getHyphenatedArg<string>(args, "reflect-cooldown-days");
      const reflectCooldownDays = reflectCooldownRaw !== undefined ? parseInt(reflectCooldownRaw, 10) : undefined;
      if (reflectCooldownDays !== undefined && Number.isNaN(reflectCooldownDays)) {
        throw new UsageError(
          `Invalid --reflect-cooldown-days value: "${reflectCooldownRaw}". Must be a non-negative integer.`,
        );
      }
      const distillCooldownRaw = getHyphenatedArg<string>(args, "distill-cooldown-days");
      const distillCooldownDays = distillCooldownRaw !== undefined ? parseInt(distillCooldownRaw, 10) : undefined;
      if (distillCooldownDays !== undefined && Number.isNaN(distillCooldownDays)) {
        throw new UsageError(
          `Invalid --distill-cooldown-days value: "${distillCooldownRaw}". Must be a non-negative integer.`,
        );
      }

      const improveLogFile = path.join(
        getCacheDir(),
        "logs",
        "improve",
        `${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
      );
      setLogFile(improveLogFile);
      let improveResult: Awaited<ReturnType<typeof akmImprove>>;
      try {
        improveResult = await akmImprove({
          scope: typeof args.scope === "string" && args.scope.trim() ? args.scope : undefined,
          task: taskArg,
          dryRun,
          target: targetArg,
          autoAccept,
          ...(limitRaw !== undefined ? { limit: limitRaw } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(reflectCooldownDays !== undefined ? { reflectCooldownDays } : {}),
          ...(distillCooldownDays !== undefined ? { distillCooldownDays } : {}),
          consolidateOptions: { target: targetArg, dryRun, autoAccept, task: taskArg },
        });
      } finally {
        clearLogFile();
      }
      output("improve", improveResult);
      process.exit(0);
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
    file: { type: "string", description: "Read the task or prompt text from a UTF-8 file" },
    profile: { type: "string", description: "Override the agent profile (defaults to agent.default)" },
    "timeout-ms": { type: "string", description: "Override the agent CLI timeout in milliseconds" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      // citty silently shows help and exits 0 when required positionals are
      // omitted. Re-validate explicitly so the exit code is 2 (USAGE) and a
      // structured JSON error reaches scripted callers.
      const taskFromFlag = typeof args.task === "string" ? args.task : undefined;
      const fileFromFlag = typeof args.file === "string" ? args.file : undefined;
      if (!args.type || !args.name || (!taskFromFlag && !fileFromFlag)) {
        throw new UsageError(
          "Usage: akm propose <type> <name> (--task '<task>' | --file <path>).",
          "MISSING_REQUIRED_ARGUMENT",
          "Provide the asset type, name, and exactly one of --task or --file.",
        );
      }
      if (taskFromFlag && fileFromFlag) {
        throw new UsageError("Pass exactly one of --task or --file.", "INVALID_FLAG_VALUE");
      }
      const taskText = fileFromFlag ? fs.readFileSync(path.resolve(fileFromFlag), "utf8") : (taskFromFlag ?? "");
      const timeoutRaw = (args as Record<string, unknown>)["timeout-ms"];
      const timeoutMs =
        typeof timeoutRaw === "string" && timeoutRaw.trim() ? Number.parseInt(timeoutRaw, 10) : undefined;
      const result = await akmPropose({
        type: String(args.type),
        name: String(args.name),
        task: taskText,
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

const TASKS_SUBCOMMAND_SET = new Set([
  "add",
  "list",
  "show",
  "remove",
  "enable",
  "disable",
  "run",
  "history",
  "sync",
  "doctor",
]);

const tasksAddCommand = defineCommand({
  meta: { name: "add", description: "Register a new scheduled task and install it in the OS scheduler" },
  args: {
    id: { type: "positional", description: "Task id (used as filename and scheduler entry)", required: true },
    schedule: { type: "string", description: 'Cron-style schedule, e.g. "0 9 * * *" or "@daily"', required: true },
    workflow: { type: "string", description: "Workflow ref to invoke (e.g. workflow:my-flow)" },
    prompt: {
      type: "string",
      description: "Prompt for the configured agent harness — inline text, an asset ref like agent:foo, or ./path.md",
    },
    profile: { type: "string", description: "Agent profile to use for prompt targets (default: config.agent.default)" },
    params: { type: "string", description: "Workflow params as a JSON object" },
    description: { type: "string", description: "Human-readable description" },
    tags: { type: "string", description: "Comma-separated tags" },
    disabled: { type: "boolean", description: "Register but leave disabled in the OS scheduler", default: false },
    force: { type: "boolean", description: "Overwrite an existing task with the same id", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await akmTasksAdd({
        id: args.id,
        schedule: args.schedule,
        workflow: args.workflow,
        prompt: args.prompt,
        profile: args.profile,
        params: args.params,
        description: args.description,
        tags: args.tags
          ? args.tags
              .split(/[\s,]+/)
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
        disabled: args.disabled === true,
        force: args.force === true,
      });
      output("tasks-add", result);
    });
  },
});

const tasksListCommand = defineCommand({
  meta: { name: "list", description: "List scheduled tasks in the stash" },
  async run() {
    await runWithJsonErrors(async () => {
      const result = await akmTasksList();
      output("tasks-list", result);
    });
  },
});

const tasksShowCommand = defineCommand({
  meta: { name: "show", description: "Show a parsed task definition" },
  args: { id: { type: "positional", description: "Task id or task:<id>", required: true } },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const { id } = parseTaskRef(args.id);
      const result = await akmTasksShow(id);
      output("tasks-show", result);
    });
  },
});

const tasksRemoveCommand = defineCommand({
  meta: { name: "remove", description: "Delete a task file and uninstall it from the OS scheduler" },
  args: { id: { type: "positional", description: "Task id", required: true } },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const { id } = parseTaskRef(args.id);
      const result = await akmTasksRemove(id);
      output("tasks-remove", result);
    });
  },
});

const tasksEnableCommand = defineCommand({
  meta: { name: "enable", description: "Enable a previously-disabled task" },
  args: { id: { type: "positional", description: "Task id", required: true } },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const { id } = parseTaskRef(args.id);
      const result = await akmTasksSetEnabled(id, true);
      output("tasks-enable", result);
    });
  },
});

const tasksDisableCommand = defineCommand({
  meta: { name: "disable", description: "Disable a task in the OS scheduler without removing the file" },
  args: { id: { type: "positional", description: "Task id", required: true } },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const { id } = parseTaskRef(args.id);
      const result = await akmTasksSetEnabled(id, false);
      output("tasks-disable", result);
    });
  },
});

const tasksRunCommand = defineCommand({
  meta: {
    name: "run",
    description: "Execute a task now (this is what cron / launchd / schtasks invoke at the scheduled time)",
  },
  args: { id: { type: "positional", description: "Task id", required: true } },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const { id } = parseTaskRef(args.id);
      const envelope = await akmTasksRun(id);
      output("tasks-run", envelope);
      if (envelope.exitCode !== 0) process.exit(envelope.exitCode);
    });
  },
});

const tasksHistoryCommand = defineCommand({
  meta: { name: "history", description: "Show recent task run history" },
  args: {
    id: { type: "string", description: "Filter to one task id" },
    limit: { type: "string", description: "Maximum rows to return (default 50)" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const limit = parsePositiveIntFlag(args.limit ?? undefined);
      const result = await akmTasksHistory({ id: args.id, limit });
      output("tasks-history", result);
    });
  },
});

const tasksSyncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Reconcile the on-disk task files with the OS scheduler",
  },
  async run() {
    await runWithJsonErrors(async () => {
      const result = await akmTasksSync();
      output("tasks-sync", result);
    });
  },
});

const tasksDoctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Report the active scheduler backend, akm bin path, log dir, and supported schedule subset",
  },
  async run() {
    await runWithJsonErrors(async () => {
      const result = await akmTasksDoctor();
      output("tasks-doctor", result);
    });
  },
});

const tasksCommand = defineCommand({
  meta: {
    name: "tasks",
    description: "Schedule workflows or prompts via the OS-native scheduler (cron / launchd / schtasks)",
  },
  subCommands: {
    add: tasksAddCommand,
    list: tasksListCommand,
    show: tasksShowCommand,
    remove: tasksRemoveCommand,
    enable: tasksEnableCommand,
    disable: tasksDisableCommand,
    run: tasksRunCommand,
    history: tasksHistoryCommand,
    sync: tasksSyncCommand,
    doctor: tasksDoctorCommand,
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      if (hasSubcommand(args, TASKS_SUBCOMMAND_SET)) return;
      const result = await akmTasksList();
      output("tasks-list", result);
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
    agent: agentCommand,
    lint: lintCommand,
    improve: improveCommand,
    propose: proposeCommand,
    proposals: proposalsCommand,
    accept: acceptCommand,
    reject: rejectCommand,
    diff: diffCommand,
    help: helpCommand,
    hints: hintsCommand,
    completions: completionsCommand,
    vault: vaultCommand,
    wiki: wikiCommand,
    tasks: tasksCommand,
  },
});

const CONFIG_SUBCOMMAND_SET = new Set(["path", "list", "show", "get", "set", "unset"]);
const VAULT_SUBCOMMAND_SET = new Set(["list", "path", "run", "create", "set", "unset"]);
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
