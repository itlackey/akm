#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Runtime guard: akm-cli 0.8 is Bun-only. The `preinstall` hook in
// package.json blocks `npm install`, but it does not protect against a
// stale node-resolved shebang, a wrong PATH entry, or someone running
// `node dist/cli.js` directly from a clone. In any of those cases the
// next line — `import { spawnSync } from "node:child_process";` — would
// itself succeed under node, only to die a few imports later with a
// confusing `ERR_MODULE_NOT_FOUND` for our extensionless internal paths.
// Catch the wrong-runtime case here with a friendly message instead of
// a stack trace. Cross-runtime support is planned for 0.9 (issue #465).
if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
  console.error(
    "\n  ERROR: akm-cli 0.8 requires the Bun runtime (https://bun.sh) or the prebuilt binary.\n" +
      "  Running under Node.js is not supported in this release.\n" +
      "  Install options:\n" +
      "    1. Bun:    curl -fsSL https://bun.sh/install | bash  &&  bun install -g akm-cli\n" +
      "    2. Binary: curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash\n" +
      "  Cross-runtime support is planned for 0.9.0.\n",
  );
  process.exit(1);
}

// Global error handlers (#478) — route any async work outside the
// `runWithJsonErrors` envelope through the same JSON shape so users never see
// a raw stack trace. Background timers, fire-and-forget appendEvent writes,
// and lazy `import()` failures are the typical sources. Registered before
// any other top-level work so the startup IIFE banner and the stale-DB
// cleanup are also covered.
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: `Unhandled rejection: ${err.message}`,
        code: "UNHANDLED_REJECTION",
        hint: "Re-run with AKM_DEBUG=1 for a stack trace, or report at https://github.com/itlackey/akm/issues with the failing command.",
      },
      null,
      2,
    ),
  );
  if (process.env.AKM_DEBUG === "1" && err.stack) console.error(err.stack);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: `Uncaught exception: ${err.message}`,
        code: "UNCAUGHT_EXCEPTION",
        hint: "Re-run with AKM_DEBUG=1 for a stack trace, or report at https://github.com/itlackey/akm/issues with the failing command.",
      },
      null,
      2,
    ),
  );
  if (process.env.AKM_DEBUG === "1" && err.stack) console.error(err.stack);
  process.exit(1);
});

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import { getStringArg, hasSubcommand, parsePositiveIntFlag } from "./cli/parse-args";
import { EXIT_CODES, emitJsonError, output, parseAllFlagValues, runWithJsonErrors } from "./cli/shared";
import { addCommand, buildWebsiteOptions } from "./commands/add-cli";
import { akmAgentDispatch } from "./commands/agent-dispatch";
import { generateBashCompletions, installBashCompletions } from "./commands/completions";
import { getConfigValue, listConfig, setConfigValue, unsetConfigValue } from "./commands/config-cli";
import { akmCurate } from "./commands/curate";
import { akmDbBackups } from "./commands/db-cli";
import { akmEventsList, akmEventsTail } from "./commands/events";
import { extractCommand } from "./commands/extract-cli";
import { feedbackCommand } from "./commands/feedback-cli";
import { graphCommand } from "./commands/graph-cli";
import {
  akmHealth,
  parseWindowSpec,
  renderRunsDetailMd,
  renderWindowCompareMd,
  type WindowSpec,
} from "./commands/health";
import { akmHistory } from "./commands/history";
import { improveCommand } from "./commands/improve-cli";
import { assembleInfo } from "./commands/info";
import { akmInit } from "./commands/init";
import { akmListSources, akmRemove, akmUpdate } from "./commands/installed-stashes";
import { readKnowledgeInput, writeMarkdownAsset } from "./commands/knowledge";
import { akmLint } from "./commands/lint";
import { renderMigrationHelp } from "./commands/migration-help";
import { registryCommand } from "./commands/registry-cli";
import { rememberCommand } from "./commands/remember-cli";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "./core/asset-create";

/**
 * Resolve the event source from the environment. When `AKM_EVENT_SOURCE` is
 * set (e.g. by `akm improve` for agent subprocesses), events are tagged so
 * they can be filtered out of user-facing history.
 */
function resolveEventSource(): "user" | "improve" | undefined {
  const raw = process.env.AKM_EVENT_SOURCE;
  if (raw === "improve") return "improve";
  if (raw === "user") return "user";
  return undefined;
}

import { proposalCommand } from "./commands/proposal-cli";
import { akmPropose } from "./commands/propose";
import { akmSearch, parseBeliefFilterMode, parseScopeFilterFlags, parseSearchSource } from "./commands/search";
import { checkForUpdate, performUpgrade } from "./commands/self-update";
import { akmShowUnified, normalizeShowArgv } from "./commands/show";
import { akmClone } from "./commands/source-clone";
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
import { isHttpUrl, isWithin, resolveStashDir, writeFileAtomic } from "./core/common";
import { DEFAULT_CONFIG, loadConfig, loadUserConfig, resolveConfiguredSources, saveConfig } from "./core/config";
import { ConfigError, NotFoundError, UsageError } from "./core/errors";
import { appendEvent } from "./core/events";
import { getCacheDir, getConfigPath, getDbPath, getDefaultStashDir } from "./core/paths";
import { parseMetaRef } from "./core/stash-meta";
import { plainize } from "./core/tty";
import { clearLogFile, info, isQuiet, isVerbose, setLogFile, setQuiet, setVerbose, warn } from "./core/warn";
import { closeDatabase, collectTagSetFromEntries, openExistingDatabase } from "./indexer/db";
import { akmIndex } from "./indexer/indexer";
import { type SearchSource as IndexSearchSource, resolveSourceEntries } from "./indexer/search-source";
import { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL } from "./output/cli-hints";
import {
  getHyphenatedArg,
  getHyphenatedBoolean,
  getOutputMode,
  hasBooleanFlag,
  initOutputMode,
  parseDetailLevel,
  parseFlagValue,
} from "./output/context";
import { formatEventLine } from "./output/text";
import { resolveSourcesForOrigin } from "./registry/origin-resolve";
import { resolveWritableOverride, saveGitStash } from "./sources/providers/git";
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

function applyEarlyStderrFlags(argv: string[]): void {
  if (argv.includes("--quiet") || argv.includes("-q")) {
    setQuiet(true);
  }
  if (argv.includes("--verbose")) {
    setVerbose(true);
  }
}

function resolveHelpMigrateVersionArg(version: string | undefined): string | undefined {
  if (version === undefined) return undefined;

  const parsedFormat = parseFlagValue(process.argv, "--format");
  if (
    parsedFormat !== undefined &&
    version === parsedFormat &&
    wasHelpMigrateFlagValueConsumedAsVersion(version, parsedFormat, "--format")
  ) {
    return undefined;
  }

  const parsedDetail = parseFlagValue(process.argv, "--detail");
  if (
    parsedDetail !== undefined &&
    version === parsedDetail &&
    wasHelpMigrateFlagValueConsumedAsVersion(version, parsedDetail, "--detail")
  ) {
    return undefined;
  }

  return version;
}

function wasHelpMigrateFlagValueConsumedAsVersion(
  version: string,
  flagValue: string,
  flagName: "--format" | "--detail",
): boolean {
  const argv = process.argv.slice(2);
  const helpIndex = argv.indexOf("help");
  const tokens = helpIndex >= 0 ? argv.slice(helpIndex + 1) : argv;
  const migrateIndex = tokens.indexOf("migrate");
  const relevant = migrateIndex >= 0 ? tokens.slice(migrateIndex + 1) : tokens;

  let flagIndex = -1;
  for (let i = 0; i < relevant.length; i += 1) {
    const token = relevant[i];
    if (token === flagName || token === `${flagName}=${flagValue}`) {
      flagIndex = i;
      break;
    }
  }

  if (flagIndex === -1) return false;
  if (relevant.slice(0, flagIndex).includes(version)) return false;
  return relevant[flagIndex] === flagName ? relevant[flagIndex + 1] === version : true;
}

/**
 * Stderr-only human-friendly hint after a non-interactive `setup` invocation.
 * Default --format is `json`, so a CI or piped consumer sees only the JSON on
 * stdout. But an interactive user running `akm setup --yes` would otherwise
 * see only the JSON blob with no obvious next step. When stderr is a TTY and
 * the JSON went to stdout, print a two-line summary to stderr telling the
 * user (a) where the stash landed and (b) what to run next.
 *
 * Silent when: stderr is not a TTY (CI, pipes), --format=text/yaml (the user
 * already gets readable output), --quiet, or the result is missing fields.
 */
function printSetupTtyHint(result: { stashDir?: string; configPath?: string }): void {
  if (!process.stderr.isTTY) return;
  const mode = getOutputMode();
  if (mode.format !== "json" && mode.format !== "jsonl") return;
  if (isQuiet()) return;
  if (!result?.stashDir) return;
  console.error(
    plainize(
      `\n✓ Stash created at ${result.stashDir}\n` +
        `  Next: \`akm add github:itlackey/akm-stash\` then \`akm index\` to populate the stash.`,
    ),
  );
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
    from: {
      type: "string",
      description:
        "Path to a config file (JSON or YAML) to bootstrap from. Skips prompts for keys present in the file.",
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
    "detect-only": {
      type: "boolean",
      default: false,
      description:
        "Run environment detection only and print the result (no prompts, no writes). Pair with --format json.",
    },
    "reset-recommended": {
      type: "boolean",
      default: false,
      description:
        "Merge opinionated, detection-derived defaults into the existing config without removing custom keys.",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const noInit = getHyphenatedBoolean(args, "no-init");
      const detectOnly = getHyphenatedBoolean(args, "detect-only");
      const resetRecommended = getHyphenatedBoolean(args, "reset-recommended");
      if (detectOnly) {
        // Detection only: no prompts, no writes.
        const { runDetectOnly } = await import("./setup/setup");
        const detection = await runDetectOnly();
        output("setup", detection);
        return;
      }
      if (resetRecommended) {
        const { runResetRecommended } = await import("./setup/setup");
        const result = await runResetRecommended({ dir: args.dir, noInit, probe: args.probe });
        output("setup", result);
        printSetupTtyHint(result);
        return;
      }
      if (args.from && args.config) {
        throw new UsageError("Pass either --from <file> or --config <json>, not both.", "INVALID_FLAG_VALUE");
      }
      if (args.from) {
        // File-based bootstrap. `loadSetupConfigFromFile` expands a leading
        // `~`, resolves relative paths against cwd, picks the YAML or JSON
        // parser based on the file extension, and surfaces any
        // read/parse/shape errors as ConfigError("INVALID_CONFIG_FILE").
        // `runSetupFromConfig` is fully non-interactive; with `--yes` it also
        // fills defaults for keys the file leaves missing.
        const { loadSetupConfigFromFile, runSetupFromConfig } = await import("./setup/setup");
        const loaded = await loadSetupConfigFromFile(args.from);
        const result = await runSetupFromConfig({
          configJson: loaded.configJson,
          dir: args.dir,
          noInit,
          probe: args.probe,
          applyDefaults: args.yes,
        });
        output("setup", result);
        printSetupTtyHint(result);
      } else if (args.config) {
        // Non-interactive config mode. With `--yes`, defaults fill any keys
        // the JSON blob leaves missing after the deep merge.
        const { runSetupFromConfig } = await import("./setup/setup");
        const result = await runSetupFromConfig({
          configJson: args.config,
          dir: args.dir,
          noInit,
          probe: args.probe,
          applyDefaults: args.yes,
        });
        output("setup", result);
        printSetupTtyHint(result);
      } else if (args.yes) {
        // Defaults mode — no prompts
        const { runSetupWithDefaults } = await import("./setup/setup");
        const result = await runSetupWithDefaults({
          dir: args.dir,
          noInit,
          probe: args.probe,
        });
        output("setup", result);
        printSetupTtyHint(result);
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
    clean: {
      type: "boolean",
      description: "After indexing, remove any entries whose source file no longer exists on disk.",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "When combined with --clean, report stale entries without deleting them.",
      default: false,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      if (getHyphenatedBoolean(args, "enrich") || parseFlagValue(process.argv, "--enrich") !== undefined) {
        throw new UsageError(
          "`akm index --enrich` has been removed. Plain `akm index` now performs metadata enrichment by default.",
        );
      }
      if (getHyphenatedBoolean(args, "re-enrich") || parseFlagValue(process.argv, "--re-enrich") !== undefined) {
        throw new UsageError(
          "`akm index --re-enrich` has been removed. Re-enrichment of index-time LLM passes is not exposed in this slice.",
        );
      }
      const outputMode = getOutputMode();
      const controller = new AbortController();
      const abort = (): void => controller.abort(new Error("index interrupted"));
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      const indexLogFile = path.join(
        getCacheDir(),
        "logs",
        "index",
        `${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
      );
      setLogFile(indexLogFile);
      const verbose = isVerbose();
      const spin = !verbose && outputMode.format === "text" ? p.spinner() : null;
      if (spin) {
        spin.start(`Building search index${args.full ? " (full rebuild)" : ""}...`);
      }
      let latestMessage = "";
      try {
        const result = await akmIndex({
          full: args.full,
          clean: args.clean,
          dryRun: args["dry-run"],
          onProgress: ({ phase, message, processed, total }) => {
            latestMessage = message;
            const progressPrefix = processed !== undefined && total !== undefined ? `[${processed}/${total}] ` : "";
            if (verbose) {
              info(`[index:${phase}] ${progressPrefix}${message}`);
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
        clearLogFile();
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
      }
    });
  },
});

const infoCommand = defineCommand({
  meta: { name: "info", description: "Show system capabilities, configuration, and index stats" },
  run() {
    return runWithJsonErrors(() => {
      const result = assembleInfo();
      output("info", result);
    });
  },
});

const healthCommand = defineCommand({
  meta: { name: "health", description: "Check akm runtime health, artifacts, and improve metrics" },
  args: {
    since: {
      type: "string",
      description: "Rolling window start (ISO timestamp, date, epoch ms, or shorthand like 24h / 7d)",
    },
    "group-by": {
      type: "string",
      description: "Group rows by: run (one row per improve_runs entry). Omit for the default summary.",
    },
    "window-compare": {
      type: "string",
      description: "Compare current window vs prior window of the same duration (e.g. 24h, 7d, 30m)",
    },
    windows: {
      type: "string",
      description:
        "Explicit comparison window 'name=...,since=ISO,until=ISO' (repeatable, up to 4; mutually exclusive with --window-compare)",
    },
  },
  async run({ args }) {
    let resultStatus: "pass" | "warn" | "fail" | undefined;
    await runWithJsonErrors(() => {
      // citty only surfaces the last value of a repeated flag, so read --windows
      // directly from argv to support multi-window comparison.
      const rawWindows = parseAllFlagValues("--windows");
      const windows: WindowSpec[] | undefined =
        rawWindows.length > 0 ? rawWindows.map((raw) => parseWindowSpec(raw)) : undefined;
      const groupBy = (args as Record<string, unknown>)["group-by"] as string | undefined;
      const windowCompareRaw = (args as Record<string, unknown>)["window-compare"] as string | undefined;
      const result = akmHealth({
        since: args.since,
        groupBy: groupBy as "run" | undefined,
        windowCompare: windowCompareRaw,
        windows,
      });
      resultStatus = result.status;
      // `--format md` is health-specific: render a TSV-shaped per-run or
      // window-compare table to stdout instead of going through the JSON
      // envelope. Other modes fall through to the standard output() path.
      const mode = getOutputMode();
      if (mode.format === "md") {
        if (result.windows && result.windows.length > 0) {
          console.log(renderWindowCompareMd(result.windows, result.deltas));
        } else if (result.runs) {
          console.log(renderRunsDetailMd(result.runs));
        } else {
          output("health", result);
        }
      } else {
        output("health", result);
      }
    });
    if (resultStatus === "fail") {
      process.exit(EXIT_GENERAL);
    }
    if (resultStatus === "warn") {
      process.exit(EXIT_HEALTH_WARN);
    }
  },
});

// MVP DB administration. Currently only `akm db backups`; restore is manual —
// stop akm and run `scripts/migrations/restore-data-dir.sh <backup>`.
const DB_SUBCOMMAND_SET = new Set(["backups"]);

const dbCommand = defineCommand({
  meta: {
    name: "db",
    description:
      "Inspect the AKM SQLite data directory. Currently exposes `backups`; to restore from a snapshot, stop akm and run scripts/migrations/restore-data-dir.sh against the chosen backup.",
  },
  subCommands: {
    backups: defineCommand({
      meta: {
        name: "backups",
        description:
          "List pre-upgrade snapshots of the data directory (newest first). Backups are created automatically before destructive DB version upgrades unless AKM_DB_BACKUP=0.",
      },
      run() {
        return runWithJsonErrors(() => {
          output("db-backups", akmDbBackups());
        });
      },
    }),
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      if (hasSubcommand(args, DB_SUBCOMMAND_SET)) return;
      // Default action: list backups.
      output("db-backups", akmDbBackups());
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
        "Asset type filter (skill, command, agent, knowledge, workflow, script, memory, env, secret, wiki, lesson, or any). Use workflow to find step-by-step task assets.",
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
    detail: { type: "string", description: "Detail level (brief|normal|full)" },
    "no-project-context": {
      type: "boolean",
      description:
        "Disable the automatic project-context ranking boost (also disabled by AKM_DISABLE_PROJECT_CONTEXT=1).",
      default: false,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const query = (args.query ?? "").trim();
      if (!query) {
        throw new UsageError(
          'A search query is required. Usage: akm search "<query>" [--type <type>] [--limit <n>]',
          "MISSING_REQUIRED_ARGUMENT",
          'Pass a query like `akm search "docker"` or `akm search "code review" --type skill`.',
        );
      }
      const type = args.type as string | undefined;
      const limit = parsePositiveIntFlag(args.limit ?? undefined);
      const source = parseSearchSource(args.source);
      // Repeatable; citty exposes only the last `--filter` value, so read all
      // occurrences directly from argv (same pattern as `--tag`).
      const filterTokens = parseAllFlagValues("--filter");
      const filters = parseScopeFilterFlags(filterTokens, "--filter");
      const includeProposed = (args as Record<string, unknown>)["include-proposed"] === true;
      const belief = parseBeliefFilterMode(typeof args.belief === "string" ? args.belief : undefined);
      const noProjectContext = getHyphenatedBoolean(args, "no-project-context");
      // --no-project-context sets env so searchDatabase picks it up without
      // threading the flag through the entire call stack.
      if (noProjectContext) process.env.AKM_DISABLE_PROJECT_CONTEXT = "1";
      const result = await akmSearch({
        query,
        type,
        limit,
        source,
        filters,
        includeProposed,
        belief,
        eventSource: resolveEventSource(),
      });
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
        "Asset type filter (skill, command, agent, knowledge, workflow, script, memory, env, secret, wiki, lesson, or any). Use workflow to curate step-by-step task assets.",
    },
    limit: { type: "string", description: "Maximum number of curated results", default: "4" },
    source: { type: "string", description: "Search source (stash|registry|both)", default: "stash" },
    // Output-contract flags. The active values are read from the process-level
    // singleton (parsed from argv at startup); these declarations make them
    // visible in `akm curate --help` and document the supported axes.
    format: { type: "string", description: "Output format (json|jsonl|text|yaml)" },
    detail: { type: "string", description: "Detail level (brief|normal|full)" },
    shape: { type: "string", description: "Output projection (human|agent)" },
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
    yes: { type: "boolean", alias: "y", description: "Skip confirmation prompt", default: false },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const { confirmDestructive } = await import("./cli/confirm.js");
      const confirmed = await confirmDestructive(`Remove source "${args.target}"? This cannot be undone.`, {
        yes: args.yes === true,
      });
      if (!confirmed) {
        process.stderr.write("Aborted.\n");
        return;
      }
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
    detail: { type: "string", description: "Detail level (brief|normal|full)" },
    shape: { type: "string", description: "Output projection (human|agent|summary)" },
    scope: {
      type: "string",
      description:
        "Scope filter (repeatable): --scope user=<id> --scope agent=<id> --scope run=<id> --scope channel=<name>. Narrows resolution to assets whose frontmatter scope matches.",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      // `[origin//]meta[:name]` targets the stash `.meta/` convention, which is
      // not a typed asset ref — skip ref validation and let akmShowUnified
      // direct-read it. (`parseAssetRef` would reject the non-type `meta`.)
      if (!parseMetaRef(args.ref)) parseAssetRef(args.ref);
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
      const cliShape = getOutputMode().shape;
      const explicitDetail = parseFlagValue(process.argv, "--detail");
      // `--shape summary` selects the compact metadata projection for show
      // (the legacy `--detail summary` spelling still maps here via the
      // back-compat path in resolveOutputMode). `--detail brief` forces the
      // brief response regardless of shape.
      const showDetail: ShowDetailLevel | undefined =
        explicitDetail === "brief" ? "brief" : cliShape === "summary" ? "summary" : undefined;
      // `--scope` is repeatable — citty only exposes the last value, so read
      // every occurrence directly from argv (same pattern as `--filter`).
      const scopeTokens = parseAllFlagValues("--scope");
      const scope = parseScopeFilterFlags(scopeTokens, "--scope");
      const result = await akmShowUnified({
        ref: args.ref,
        view,
        detail: showDetail,
        scope,
        eventSource: resolveEventSource(),
      });
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
        // #463: stable machine-friendly entry point for plugins / hooks.
        // `--silent` suppresses the config dump on stdout so hook-driven
        // writes don't pollute their host's output stream.
        silent: {
          type: "boolean",
          description:
            "Suppress the post-write config dump on stdout. Use from hooks and CI scripts; the write still happens and errors still print.",
          default: false,
        },
        // #463: explicit layer flag for forward-compat. User layer is the only
        // settable layer today; the flag exists so plugin authors can encode
        // intent and the surface stays stable if project-layer writes return.
        layer: {
          type: "string",
          description: "Config layer to write to. Currently only `user` is supported.",
          default: "user",
        },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          if (args.layer && args.layer !== "user") {
            throw new UsageError(
              `Unsupported --layer "${args.layer}". Only "user" is settable in 0.8.0.`,
              "INVALID_FLAG_VALUE",
            );
          }
          // Use loadConfig (not loadUserConfig) so the project-config
          // deprecation warning fires consistently with `akm config get`
          // (#457). Effective merged shape is identical post-0.8.0.
          const updated = setConfigValue(loadConfig(), args.key, args.value);
          saveConfig(updated);
          if (!args.silent) {
            output("config", listConfig(updated));
          }
        });
      },
    }),
    unset: defineCommand({
      meta: { name: "unset", description: "Unset an optional configuration key or whole embedding/llm section" },
      args: {
        key: { type: "positional", required: true, description: "Config key to unset" },
        silent: {
          type: "boolean",
          description: "Suppress the post-write config dump on stdout.",
          default: false,
        },
        layer: {
          type: "string",
          description: "Config layer to write to. Currently only `user` is supported.",
          default: "user",
        },
      },
      run({ args }) {
        return runWithJsonErrors(() => {
          if (args.layer && args.layer !== "user") {
            throw new UsageError(
              `Unsupported --layer "${args.layer}". Only "user" is settable in 0.8.0.`,
              "INVALID_FLAG_VALUE",
            );
          }
          const updated = unsetConfigValue(loadConfig(), args.key);
          saveConfig(updated);
          if (!args.silent) {
            output("config", listConfig(updated));
          }
        });
      },
    }),
    validate: defineCommand({
      meta: {
        name: "validate",
        description: "Validate the on-disk config file against the schema. Exits non-zero on errors.",
      },
      async run() {
        return runWithJsonErrors(async () => {
          const { runConfigValidate } = await import("./cli/config-validate.js");
          await runConfigValidate();
        });
      },
    }),
    migrate: defineCommand({
      meta: {
        name: "migrate",
        description: "Migrate the config file to the current schema version. Use --dry-run to preview without writing.",
      },
      args: {
        "dry-run": { type: "boolean", description: "Preview the migration result without writing.", default: false },
        "print-diff": {
          type: "boolean",
          description: "Print a unified diff of old vs new config alongside the migration output.",
          default: false,
        },
      },
      async run({ args }) {
        return runWithJsonErrors(async () => {
          const { runConfigMigrate } = await import("./cli/config-migrate.js");
          await runConfigMigrate({ dryRun: Boolean(args["dry-run"]), printDiff: Boolean(args["print-diff"]) });
        });
      },
    }),
    enable: defineCommand({
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
    }),
    disable: defineCommand({
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

// `sync` body. Kept as a standalone function so the git-commit/push logic and
// the `--format`-as-name workaround stay in one place.
async function runSyncBody(args: { name?: string; message?: string; push?: boolean }, verb: "sync"): Promise<void> {
  await runWithJsonErrors(async () => {
    // Fix: citty can consume `--format json` (space-separated) as the
    // positional `name` argument (e.g. `akm sync --format json` parses
    // name="json"). Detect the mis-parse by checking argv order — only
    // treat the positional as consumed by --format when --format appears
    // before any standalone occurrence of the same value in the sync
    // subcommand's argv slice. This preserves legitimate invocations
    // like `akm sync json --format json`.
    const parsedFormat = parseFlagValue(process.argv, "--format");
    const effectiveName =
      args.name !== undefined &&
      parsedFormat !== undefined &&
      args.name === parsedFormat &&
      wasFormatValueConsumedAsName(args.name, parsedFormat, verb)
        ? undefined
        : args.name;

    let writable: boolean | undefined;
    if (effectiveName === undefined) {
      // Primary stash — honour the root-level writable flag from config.
      writable = resolveWritableOverride(loadConfig());
    }

    const result = saveGitStash(effectiveName, args.message, writable, { push: args.push !== false });
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
}

const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description:
      "Sync changes in a git-backed stash: commits (and pushes when writable + remote is configured). No-op for non-git stashes.",
  },
  args: {
    name: {
      type: "positional",
      description: "Name of the git stash to sync (default: primary stash directory)",
      required: false,
    },
    message: {
      type: "string",
      alias: "m",
      description: "Commit message (default: timestamp)",
    },
    push: {
      type: "boolean",
      description: "Push after commit when writable + remote configured (use --no-push to commit only). Default: true.",
      default: true,
    },
  },
  async run({ args }) {
    await runSyncBody(args, "sync");
  },
});

/**
 * Detect whether `--format <value>` was consumed by citty as the optional
 * `name` positional of `akm sync`. Returns true only when `--format` appears
 * in the sync subcommand's argv slice AND the candidate name does NOT
 * appear as a standalone positional elsewhere (before or after the flag).
 *
 * This keeps `akm sync json --format json` routing `json` as the stash name,
 * while `akm sync --format json` (no separate positional) is treated as a
 * primary-stash sync. `verb` is the subcommand token to anchor on.
 */
function wasFormatValueConsumedAsName(name: string, formatValue: string, verb: "sync"): boolean {
  const argv = process.argv.slice(2);
  const verbIndex = argv.indexOf(verb);
  const tokens = verbIndex >= 0 ? argv.slice(verbIndex + 1) : argv;

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

const historyCommand = defineCommand({
  meta: {
    name: "history",
    description:
      "Show mutation/usage history for a single asset (--ref) or stash-wide.\n\n" +
      "Event sources:\n" +
      "  usage_events (default): search, show, and feedback events from the local index.\n" +
      "  state.db events (--include-proposals): proposal lifecycle events (promoted, rejected)\n" +
      "    emitted by `akm accept` / `akm reject`.\n\n" +
      "Results from all active sources are merged and sorted chronologically.",
  },
  args: {
    ref: { type: "string", description: "Asset ref (type:name). Omit for stash-wide history." },
    since: { type: "string", description: "ISO timestamp or epoch ms — only events on/after this time" },
    generator: {
      type: "string",
      description: 'Filter by event generator: "user" (default) or "improve" (akm improve operations).',
    },
    "include-proposals": {
      type: "boolean",
      description:
        "Also include proposal lifecycle events (promoted, rejected) from state.db events. " +
        "Default: false (usage_events only).",
      default: false,
    },
    "accept-rate-by-source": {
      type: "boolean",
      description:
        "Compute accept-rate-per-source metrics from the proposal store and include them in the output (F-4 / #385). " +
        "Useful for measuring which generators (reflect, distill, …) produce the most accepted proposals.",
      default: false,
    },
    format: { type: "string", description: "Output format (json|jsonl|text|yaml)" },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const generatorFlag = args.generator as "user" | "improve" | undefined;
      if (generatorFlag !== undefined && generatorFlag !== "user" && generatorFlag !== "improve") {
        throw new UsageError(
          `Invalid --generator value: "${generatorFlag}". Must be "user" or "improve".`,
          "INVALID_FLAG_VALUE",
        );
      }
      const sources = resolveSourceEntries();
      const stashDir = sources[0]?.path;
      const result = await akmHistory({
        ref: args.ref,
        since: args.since,
        source: generatorFlag,
        includeProposals: args["include-proposals"],
        acceptRateBySource: args["accept-rate-by-source"] as boolean | undefined,
        stashDir,
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
    force: {
      type: "boolean",
      description: "Allow a parallel run when an active run already exists in this scope (#485)",
      default: false,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await startWorkflowRun(args.ref, parseWorkflowJsonObject(args.params, "--params"), {
        force: args.force === true,
      });
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
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      // `--dry-run` is intentionally NOT a declared arg (so it stays out of
      // --help). The guard reads it straight from process.argv so existing
      // callers still get a clear, actionable error instead of a generic
      // "unknown flag" from citty.
      if (hasBooleanFlag(process.argv, "--dry-run")) {
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
    summary: {
      type: "string",
      description: "Summary of work done (required when completing a step); validated against completion criteria",
    },
    evidence: { type: "string", description: "Evidence JSON object for the step" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await completeWorkflowStep({
        runId: args.runId,
        stepId: args.step,
        status: parseWorkflowStepState(args.state),
        notes: args.notes,
        summary: args.summary,
        evidence: args.evidence ? parseWorkflowJsonObject(args.evidence, "--evidence") : undefined,
      });
      if ("ok" in result && result.ok === false) {
        // Summary failed the completion-criteria validation gate (#506): the
        // step stays pending and the agent receives corrective feedback.
        output("workflow-complete-rejected", result);
        return;
      }
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
    name: {
      type: "positional",
      description: "Workflow name (flat, no '/'; use --path for a subdirectory)",
      required: true,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under workflows/ to place the workflow in (e.g. 'release'). The filename comes from the name.",
    },
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
      // `name` is flat; subdirectory placement is `--path`'s job.
      assertFlatAssetName(args.name);
      const effectiveName = combineCreatePath(normalizeCreateSubPath(args.path), args.name);
      const namePattern = /^[a-z0-9][a-z0-9._/-]*$/;
      if (!namePattern.test(effectiveName)) {
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
        name: effectiveName,
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
      description:
        "Knowledge name (flat, no '/'; defaults to the source filename or content slug). Use --path for a subdirectory.",
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under knowledge/ to place the document in (e.g. 'projects/example'). The filename still comes from --name or the source slug.",
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
      // `--name` is a flat name; subdirectory placement is `--path`'s job.
      assertFlatAssetName(args.name);
      const { content, preferredName } = await readKnowledgeInput(args.source);
      const result = await writeMarkdownAsset({
        type: "knowledge",
        content,
        name: args.name ?? (isHttpUrl(args.source) ? preferredName : undefined),
        fallbackPrefix: "knowledge",
        preferredName,
        force: args.force,
        target: args.target,
        path: args.path,
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
        "Hints detail level (brief|normal|full). `brief` prints the short guide; `normal`/`full` print the complete guide.",
      default: "normal",
    },
  },
  run({ args }) {
    return runWithJsonErrors(() => {
      // Let the global parser validate the value so an invalid `--detail`
      // returns the standard JSON error envelope (exit 2) rather than a raw
      // stack trace + exit 1. `brief` → short doc; `normal`/`full` → full doc.
      const detail = parseDetailLevel(args.detail as string | undefined) ?? "normal";
      process.stdout.write(loadHints(detail === "brief" ? "brief" : "full"));
    });
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
          const version = resolveHelpMigrateVersionArg(typeof args.version === "string" ? args.version : undefined);
          if (!version?.trim()) {
            throw new UsageError(
              "Usage: akm help migrate <version>.",
              "MISSING_REQUIRED_ARGUMENT",
              "Pass a version like `0.6.0`, `v0.6.0`, `0.6.0-rc1`, or `latest`.",
            );
          }
          process.stdout.write(renderMigrationHelp(version));
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
      info(`Completions installed to ${dest}`);
      info(`Restart your shell or run:  source ${dest}`);
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

// ── env ───────────────────────────────────────────────────────────────────
//
// `akm env` manages whole `.env` files under each stash's env/ directory.
// Values are NEVER written to stdout or structured output — only key NAMES and
// start-of-line comments are surfaced. akm does not manage individual entries;
// you edit the `.env` file yourself and akm loads it. Replaced the deprecated
// `vault` type (removed in 0.9.0).

function parseEnvRef(ref: string): ReturnType<typeof parseAssetRef> {
  return parseAssetRef(ref.includes(":") ? ref : `env:${ref}`);
}

function findEnvSource(origin: string | undefined): IndexSearchSource {
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

function makeEnvRef(name: string, source?: IndexSearchSource): string {
  return source?.registryId ? `${source.registryId}//env:${name}` : `env:${name}`;
}

/**
 * Resolve an env ref to an absolute `.env` path. Accepts `env:` and
 * `environment:` (alias) refs as well as bare names. The path is returned even
 * when the file does not yet exist (so `create` writes under `env/`).
 */
function resolveEnvPath(ref: string): {
  name: string;
  absPath: string;
  source: IndexSearchSource;
  parsedRef: ReturnType<typeof parseAssetRef>;
  dir: "env";
} {
  const parsed = parseEnvRef(ref);
  if (parsed.type !== "env") {
    throw new UsageError(`Expected an env ref (env:<name>); got "${ref}".`);
  }
  const source = findEnvSource(parsed.origin);

  const envRoot = path.join(source.path, "env");
  const envPath = resolveAssetPathFromName("env", envRoot, parsed.name);
  // Defense-in-depth: ensure the resolved path stays inside the env directory.
  // validateName already rejects traversal patterns like "../../foo", but an
  // absolute-path override or symlink-based attack could still escape without
  // this second check.
  if (!isWithin(envPath, envRoot)) {
    throw new UsageError(`Env name "${parsed.name}" escapes the env directory.`);
  }

  return { name: parsed.name, absPath: envPath, source, parsedRef: parsed, dir: "env" };
}

/**
 * Walk each stash's env files and return one entry per `.env` file, using the
 * env asset spec's canonical-name logic (e.g. `env/team/prod.env` →
 * `env:team/prod`, `env/team/.env` → `env:team/default`).
 */
function listEnvsRecursive(
  listKeysFn: (envPath: string) => { keys: string[] },
): Array<{ ref: string; path: string; keys: string[] }> {
  const result: Array<{ ref: string; path: string; keys: string[] }> = [];
  for (const source of resolveSourceEntries(undefined, loadConfig())) {
    const root = path.join(source.path, "env");
    if (!fs.existsSync(root)) continue;

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name !== ".env" && !entry.name.endsWith(".env")) continue;
        const canonical = deriveCanonicalAssetName("env", root, full);
        if (!canonical) continue;
        // Skip sensitive envs: a sibling .sensitive marker file suppresses listing.
        const markerPath = full.replace(/\.env$/, ".sensitive");
        if (fs.existsSync(markerPath)) continue;
        const { keys } = listKeysFn(full);
        result.push({ ref: makeEnvRef(canonical, source), path: full, keys });
      }
    };
    walk(root);
  }
  return result;
}

const envListCommand = defineCommand({
  meta: { name: "list", description: "List all env files across all stashes with their key names (no values)" },
  run() {
    return runWithJsonErrors(async () => {
      const { listKeys } = await import("./commands/env.js");
      output("env-list", { envs: listEnvsRecursive(listKeys) });
    });
  },
});

const envCreateCommand = defineCommand({
  meta: {
    name: "create",
    description:
      "Create an env file (empty by default; seed an existing `.env` with --from-file or --from-stdin). No-op if it already exists and no source is given.",
  },
  args: {
    name: {
      type: "positional",
      description: "Env name (flat, e.g. prod → prod.env; use --path for a subdirectory)",
      required: true,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under env/ to place the env file in (e.g. 'staging'). The filename comes from the name.",
    },
    "from-file": { type: "string", description: "Seed the env file from an existing .env at this path" },
    "from-stdin": { type: "boolean", description: "Seed the env file from stdin", default: false },
    sensitive: {
      type: "boolean",
      description: "Exclude this env file from env list output and the search index",
      default: false,
    },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { createEnv, writeEnv } = await import("./commands/env.js");
      // `create` always targets env/, never the frozen vaults/ copy.
      const parsed = parseEnvRef(args.name);
      // `name` is flat; subdirectory placement is `--path`'s job.
      assertFlatAssetName(parsed.name);
      parsed.name = combineCreatePath(normalizeCreateSubPath(getStringArg(args, "path")), parsed.name);
      const source = findEnvSource(parsed.origin);
      const envRoot = path.join(source.path, "env");
      const absPath = resolveAssetPathFromName("env", envRoot, parsed.name);
      if (!isWithin(absPath, envRoot)) {
        throw new UsageError(`Env name "${parsed.name}" escapes the env directory.`);
      }

      const fromFile = getHyphenatedArg<string>(args, "from-file");
      const fromStdin = getHyphenatedArg<boolean>(args, "from-stdin") === true;
      if (fromFile !== undefined && fromStdin) {
        throw new UsageError("Pass only one of --from-file or --from-stdin.", "INVALID_FLAG_VALUE");
      }

      if (fromFile !== undefined || fromStdin) {
        // Ingest path: never silently clobber an existing env file.
        if (fs.existsSync(absPath)) {
          throw new UsageError(
            `Env "${makeEnvRef(parsed.name, source)}" already exists. Remove it first (\`akm env remove\`) or edit the file directly.`,
            "RESOURCE_ALREADY_EXISTS",
          );
        }
        let content: string;
        if (fromFile !== undefined) {
          if (!fs.existsSync(fromFile)) {
            throw new NotFoundError(`Source file not found: ${fromFile}`, "FILE_NOT_FOUND");
          }
          content = fs.readFileSync(fromFile, "utf8");
        } else {
          const MAX_ENV_BYTES = 1024 * 1024; // 1 MB
          let total = 0;
          const chunks: Uint8Array[] = [];
          for await (const chunk of Bun.stdin.stream()) {
            total += chunk.byteLength;
            if (total > MAX_ENV_BYTES) {
              throw new UsageError("Env file exceeds 1 MB limit.", "INVALID_FLAG_VALUE");
            }
            chunks.push(chunk);
          }
          content = Buffer.concat(chunks).toString("utf8");
        }
        writeEnv(absPath, content);
      } else {
        createEnv(absPath);
      }

      if (args.sensitive) {
        const markerPath = absPath.replace(/\.env$/, ".sensitive");
        if (!fs.existsSync(markerPath)) {
          fs.writeFileSync(markerPath, "", { mode: 0o600 });
        }
      }
      output("env-create", { ref: makeEnvRef(parsed.name, source) });
    });
  },
});

const envPathCommand = defineCommand({
  meta: {
    name: "path",
    description:
      "Print the absolute env file path (Docker `_FILE` convention / `--env-file`). To inject values, use `akm env run <ref> -- <cmd>` — do NOT `source` the raw file.",
  },
  args: {
    ref: { type: "positional", description: "Env ref", required: true },
    quiet: { type: "boolean", alias: "q", description: "Suppress the unsafe-source warning", default: false },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { name, absPath, source } = resolveEnvPath(args.ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Env not found: ${makeEnvRef(name, source)}`);
      }
      // The raw `.env` may contain `X=$(cmd)`, which executes if `source`d.
      // Warning goes to stderr (never contaminates the path on stdout) and is
      // suppressed with --quiet for the legitimate `_FILE` / `--env-file` use.
      if (args.quiet !== true) {
        process.stderr.write(
          `warning: this is the raw file path. Do NOT \`source\` it (shell substitutions in the file would execute).\n` +
            `         To inject values run: akm env run ${args.ref} -- <command>\n`,
        );
      }
      process.stdout.write(`${absPath}\n`);
    });
  },
});

const envExportCommand = defineCommand({
  meta: {
    name: "export",
    description:
      "Write safe `export KEY='value'` lines to a file (mode 0600) for `source`-ing — requires --out <path>. Values are re-serialised single-quoted so a raw `.env` cannot execute on load, and are NEVER printed to stdout. To use values directly, prefer `akm env run <ref> -- <command>`.",
  },
  args: {
    ref: { type: "positional", description: "Env ref", required: true },
    out: { type: "string", alias: "o", description: "Destination file (required). Written at mode 0600." },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const outPath = getHyphenatedArg<string>(args, "out");
      if (!outPath) {
        throw new UsageError(
          "`akm env export` writes to a file — pass --out <path>.\n" +
            "       To use values directly, run `akm env run <ref> -- <command>` (or `-- $SHELL` for an interactive\n" +
            "       session). export never prints values to stdout, to avoid leaking them into a captured context.",
          "MISSING_REQUIRED_ARGUMENT",
        );
      }
      const { name, absPath, source } = resolveEnvPath(args.ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Env not found: ${makeEnvRef(name, source)}`);
      }
      const { buildShellExportScript } = await import("./commands/env.js");
      const resolvedOut = path.resolve(outPath);
      writeFileAtomic(resolvedOut, buildShellExportScript(absPath), 0o600);
      output("env-export", { ref: makeEnvRef(name, source), out: resolvedOut });
    });
  },
});

/**
 * Shared implementation for `env run`. Injects an entire env file's values into
 * the child process env — never via a shell — after scanning the injected keys
 * for process-hijacking variables.
 */
async function runEnvInjected(target: string, opts: { only?: string[]; except?: string[] }): Promise<void> {
  const dashIndex = process.argv.indexOf("--");
  if (dashIndex < 0 || dashIndex === process.argv.length - 1) {
    throw new UsageError("Missing command. Usage: akm env run <ref> -- <command>");
  }
  const command = process.argv.slice(dashIndex + 1);

  const { name, absPath, source } = resolveEnvPath(target);
  if (!fs.existsSync(absPath)) {
    // Help users who reach for the removed single-key `ref/KEY` form.
    const slash = target.lastIndexOf("/");
    if (slash > 0) {
      const maybeKey = target.slice(slash + 1);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(maybeKey)) {
        let baseExists = false;
        try {
          baseExists = fs.existsSync(resolveEnvPath(target.slice(0, slash)).absPath);
        } catch {
          baseExists = false;
        }
        if (baseExists) {
          throw new UsageError(
            `'akm env run' injects the whole file; the single-key '<ref>/${maybeKey}' form was removed.\n` +
              `       For one value use a secret: \`akm secret run secret:${maybeKey} ${maybeKey} -- <command>\`.`,
            "INVALID_FLAG_VALUE",
          );
        }
      }
    }
    throw new NotFoundError(`Env not found: ${makeEnvRef(name, source)}`);
  }

  const { loadEnv } = await import("./commands/env.js");
  const allValues = loadEnv(absPath);

  // Value-safe key filtering (--only / --except operate on key NAMES only).
  let envValues = allValues;
  if (opts.only && opts.except) {
    throw new UsageError("Pass only one of --only or --except.", "INVALID_FLAG_VALUE");
  }
  if (opts.only) {
    const wanted = new Set(opts.only);
    const missing = opts.only.filter((k) => !(k in allValues));
    if (missing.length > 0) {
      process.stderr.write(
        `warning: --only key(s) not present in ${makeEnvRef(name, source)}: ${missing.join(", ")}\n`,
      );
    }
    envValues = Object.fromEntries(Object.entries(allValues).filter(([k]) => wanted.has(k)));
  } else if (opts.except) {
    const excluded = new Set(opts.except);
    envValues = Object.fromEntries(Object.entries(allValues).filter(([k]) => !excluded.has(k)));
  }
  // Substitute `${secret:NAME}` tokens in values with the value of the sibling
  // secret asset in the SAME stash. The lookup is injected so commands/env.ts
  // keeps its narrow dependency surface; we resolve each name against this env's
  // own `source`. A missing secret is a hard error — inject NOTHING (no partial
  // injection). Resolved values are never logged or printed.
  const { resolveSecretTokens } = await import("./commands/env.js");
  const { readValue } = await import("./commands/secret.js");
  const secretsRoot = path.join(source.path, "secrets");
  const resolveSecret = (secretName: string): string | undefined => {
    const secretPath = resolveAssetPathFromName("secret", secretsRoot, secretName);
    // Defense-in-depth: ensure the resolved path stays inside the secrets dir.
    if (!isWithin(secretPath, secretsRoot)) {
      throw new UsageError(`Secret name "${secretName}" escapes the secrets directory.`);
    }
    if (!fs.existsSync(secretPath)) return undefined;
    // Match `secret run`: read utf8, do not trim (stay consistent with that path).
    return readValue(secretPath).toString("utf8");
  };
  const { values: substituted, missing } = resolveSecretTokens(envValues, resolveSecret);
  if (missing.length > 0) {
    const envRef = makeEnvRef(name, source);
    throw new NotFoundError(
      `Env "${envRef}" references secret(s) not found in its stash: ${missing.map((n) => `secret:${n}`).join(", ")}. Nothing was injected.`,
      "FILE_NOT_FOUND",
      `Create the missing secret, e.g. \`akm secret set secret:${missing[0]}\`.`,
    );
  }
  envValues = substituted;
  const keys = Object.keys(envValues);

  // Scan injected keys for known process-hijacking variables (LD_PRELOAD,
  // PATH, ...). Block for third-party-sourced stashes (origin has a registryId);
  // warn for the operator's own first-party stash, where they own the file.
  const { isDangerousEnvKey } = await import("./commands/lint/env-key-rules.js");
  const dangerous = keys.filter(isDangerousEnvKey);
  if (dangerous.length > 0) {
    const detail = `Env "${makeEnvRef(name, source)}" injects process-hijacking variable(s): ${dangerous.join(", ")}.`;
    if (source.registryId) {
      throw new UsageError(
        `Refusing to inject env from a third-party stash. ${detail}\n` +
          `       Review the file, then copy the values into a first-party env if you trust them.`,
        "INVALID_FLAG_VALUE",
      );
    }
    process.stderr.write(`warning: ${detail} Injecting anyway (first-party stash).\n`);
  }

  const mergedEnv = { ...process.env };
  for (const [envKey, envValue] of Object.entries(envValues)) {
    mergedEnv[envKey] = envValue;
  }

  // Audit trail: keys only, never values.
  appendEvent({
    eventType: "env_access",
    ref: makeEnvRef(name, source),
    metadata: { keys },
  });

  const result = spawnSync(command[0] as string, command.slice(1), {
    stdio: "inherit",
    env: mergedEnv,
  });
  if (result.error) {
    // Classify spawn failures (#483). Raw ErrnoException leaks a bare
    // "spawn ENOENT" with no hint — wrap it so consumers get a usable
    // code + hint in the standard JSON envelope.
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new NotFoundError(
        `Command not found: ${command[0]}`,
        "FILE_NOT_FOUND",
        `Install '${command[0]}' or add its directory to PATH before invoking 'akm env run'.`,
      );
    }
    if (err.code === "EACCES") {
      throw new ConfigError(
        `Command not executable: ${command[0]}`,
        "STASH_DIR_UNREADABLE",
        `Add execute permission ('chmod +x ${command[0]}') or invoke via an interpreter.`,
      );
    }
    throw err;
  }
  process.exit(result.status ?? 0);
}

/** Parse a comma/space-separated key list flag into a trimmed, non-empty array. */
function parseKeyListFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const keys = raw
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  return keys.length > 0 ? keys : undefined;
}

const envRunCommand = defineCommand({
  meta: {
    name: "run",
    description:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal `${secret:NAME}` token syntax documented for users, not interpolation
      "Run a command with the env file injected into its environment: `akm env run <ref> -- <command>`. Use `-- $SHELL` for an interactive session. Restrict which variables are injected with --only / --except. Values may embed `${secret:NAME}` tokens, replaced at run time with the sibling `secret:NAME` value from the same stash.",
  },
  args: {
    target: { type: "positional", description: "Env ref", required: true },
    only: {
      type: "string",
      description: "Inject ONLY these keys (comma-separated). Mutually exclusive with --except.",
    },
    except: { type: "string", description: "Inject all keys EXCEPT these (comma-separated)." },
  },
  run({ args }) {
    return runWithJsonErrors(() =>
      runEnvInjected(args.target, {
        only: parseKeyListFlag(getHyphenatedArg<string>(args, "only")),
        except: parseKeyListFlag(getHyphenatedArg<string>(args, "except")),
      }),
    );
  },
});

const envRemoveCommand = defineCommand({
  meta: { name: "remove", description: "Remove an env file (and its .sensitive marker, if any)" },
  args: {
    ref: { type: "positional", description: "Env ref", required: true },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation prompt", default: false },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const parsed = parseEnvRef(args.ref);
      const source = findEnvSource(parsed.origin);
      const envRoot = path.join(source.path, "env");
      const absPath = resolveAssetPathFromName("env", envRoot, parsed.name);
      if (!isWithin(absPath, envRoot)) {
        throw new UsageError(`Env name "${parsed.name}" escapes the env directory.`);
      }
      const { confirmDestructive } = await import("./cli/confirm.js");
      const confirmed = await confirmDestructive(`Remove env "${args.ref}"? This cannot be undone.`, {
        yes: args.yes === true,
      });
      if (!confirmed) {
        process.stderr.write("Aborted.\n");
        return;
      }
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Env not found: ${makeEnvRef(parsed.name, source)}`);
      }
      const { removeEnv } = await import("./commands/env.js");
      const removed = removeEnv(absPath);
      output("env-remove", { ref: makeEnvRef(parsed.name, source), removed });
    });
  },
});

const envSetCommand = defineCommand({
  meta: {
    name: "set",
    description:
      "Set (create or update) a single KEY in an env file: `akm env set <ref> <KEY>`. The value is read from stdin by default (never via argv); use --from-env <VAR> or --from-file <path>. Preserves existing comments and key order; the value is never printed. Creates the env file if it does not exist.",
  },
  args: {
    ref: { type: "positional", description: "Env ref (e.g. env:prod or just prod)", required: true },
    key: { type: "positional", description: "Key name to set (e.g. API_URL)", required: true },
    "from-env": { type: "string", description: "Read the value from the named environment variable" },
    "from-file": { type: "string", description: "Read the value from this file" },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const parsed = parseEnvRef(args.ref);
      const source = findEnvSource(parsed.origin);
      const envRoot = path.join(source.path, "env");
      const absPath = resolveAssetPathFromName("env", envRoot, parsed.name);
      if (!isWithin(absPath, envRoot)) {
        throw new UsageError(`Env name "${parsed.name}" escapes the env directory.`);
      }
      const key = String(args.key);
      const { ENV_KEY_RE, setEnvKey } = await import("./commands/env.js");
      if (!ENV_KEY_RE.test(key)) {
        throw new UsageError(`Invalid env key "${key}". Keys match [A-Za-z_][A-Za-z0-9_]*.`, "INVALID_FLAG_VALUE");
      }

      const fromEnv = getHyphenatedArg<string>(args, "from-env");
      const fromFile = getHyphenatedArg<string>(args, "from-file");
      if (fromEnv !== undefined && fromFile !== undefined) {
        throw new UsageError("Pass only one of --from-file or --from-env (or use stdin).", "INVALID_FLAG_VALUE");
      }
      const MAX_ENV_VALUE_BYTES = 1024 * 1024; // 1 MB
      let value: string;
      if (fromFile !== undefined) {
        if (!fs.existsSync(fromFile)) {
          throw new NotFoundError(`File not found: ${fromFile}`, "FILE_NOT_FOUND");
        }
        const buf = fs.readFileSync(fromFile);
        if (buf.byteLength > MAX_ENV_VALUE_BYTES) throw new UsageError("Value exceeds the 1 MB limit.");
        value = buf.toString("utf8");
      } else if (fromEnv !== undefined) {
        const v = process.env[fromEnv];
        if (v === undefined) {
          throw new UsageError(`Environment variable "${fromEnv}" is not set.`, "INVALID_FLAG_VALUE");
        }
        value = v;
      } else {
        let total = 0;
        const chunks: Uint8Array[] = [];
        for await (const chunk of Bun.stdin.stream()) {
          total += chunk.byteLength;
          if (total > MAX_ENV_VALUE_BYTES) throw new UsageError("Value exceeds the 1 MB limit.");
          chunks.push(chunk);
        }
        // Strip a single trailing newline so `echo "$VAL" | akm env set` is exact.
        value = Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
      }
      setEnvKey(absPath, key, value);
      // Warn (never block) on process-hijacking key names, matching the env-run audit.
      const { isDangerousEnvKey } = await import("./commands/lint/env-key-rules.js");
      if (isDangerousEnvKey(key) && !isQuiet()) {
        process.stderr.write(
          `warning: "${key}" can influence process execution when this env is loaded via 'akm env run'.\n`,
        );
      }
      output("env-set", { ref: makeEnvRef(parsed.name, source), key });
    });
  },
});

const envUnsetCommand = defineCommand({
  meta: {
    name: "unset",
    description:
      "Remove one or more KEYs from an env file: `akm env unset <ref> <KEY...>`. Preserves other keys and comments. To remove the whole file, use `akm env remove`.",
  },
  args: {
    ref: { type: "positional", description: "Env ref (e.g. env:prod or just prod)", required: true },
    // `key` is read from the raw positionals (one or more) in run(); declared
    // non-required so citty doesn't block before we emit a structured error.
    key: { type: "positional", description: "Key name(s) to remove (one or more)", required: false },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const parsed = parseEnvRef(args.ref);
      const source = findEnvSource(parsed.origin);
      const envRoot = path.join(source.path, "env");
      const absPath = resolveAssetPathFromName("env", envRoot, parsed.name);
      if (!isWithin(absPath, envRoot)) {
        throw new UsageError(`Env name "${parsed.name}" escapes the env directory.`);
      }
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Env not found: ${makeEnvRef(parsed.name, source)}`);
      }
      // citty puts every positional in `args._` (incl. the ref at [0]); the keys
      // are the remaining positionals. citty also mis-captures the space-separated
      // value of a global flag (`--format json`) as a positional, so drop any
      // token that is actually a global flag's value (cli.ts:1335 documents this).
      const globalFlagValues = new Set(
        ["--format", "--shape", "--detail", "--scope", "--filter", "--target"]
          .map((flag) => parseFlagValue(process.argv, flag))
          .filter((v): v is string => typeof v === "string"),
      );
      const keys = (Array.isArray(args._) ? (args._ as unknown[]).map(String) : [])
        .slice(1)
        .filter((k) => !globalFlagValues.has(k));
      if (keys.length === 0) {
        throw new UsageError("Usage: akm env unset <ref> <KEY...> (one or more keys).", "MISSING_REQUIRED_ARGUMENT");
      }
      const { ENV_KEY_RE, unsetEnvKeys } = await import("./commands/env.js");
      const invalid = keys.filter((k) => !ENV_KEY_RE.test(k));
      if (invalid.length > 0) {
        throw new UsageError(`Invalid env key(s): ${invalid.join(", ")}.`, "INVALID_FLAG_VALUE");
      }
      const { removed, missing } = unsetEnvKeys(absPath, keys);
      output("env-unset", { ref: makeEnvRef(parsed.name, source), removed, missing });
    });
  },
});

const envCommand = defineCommand({
  meta: {
    name: "env",
    description:
      "Manage `.env` files — a group of related CONFIGURATION values for an app or service (URLs, flags, plus any credentials it needs), loaded together. Values may or may not be sensitive; akm protects them all the same (key names visible, values never in structured output). For a single sensitive value used on its own (an auth token, key, or cert), use `akm secret`.",
  },
  subCommands: {
    list: envListCommand,
    path: envPathCommand,
    export: envExportCommand,
    run: envRunCommand,
    create: envCreateCommand,
    set: envSetCommand,
    unset: envUnsetCommand,
    remove: envRemoveCommand,
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      if (hasSubcommand(args, ENV_SUBCOMMAND_SET)) return;
      const { listKeys } = await import("./commands/env.js");
      output("env-list", { envs: listEnvsRecursive(listKeys) });
    });
  },
});

// ── secret ──────────────────────────────────────────────────────────────────
//
// `akm secret` manages whole-file secrets under each stash's secrets/ directory.
// Unlike env files (.env key/value), the ENTIRE file is the secret value. The bytes
// are NEVER written to stdout or structured output. Values reach a command only
// via `akm secret run` (injected into a child env var) or `akm secret path`
// (the Docker /run/secrets + `_FILE` convention).

function parseSecretRef(ref: string): ReturnType<typeof parseAssetRef> {
  return parseAssetRef(ref.includes(":") ? ref : `secret:${ref}`);
}

function makeSecretRef(name: string, source?: IndexSearchSource): string {
  return source?.registryId ? `${source.registryId}//secret:${name}` : `secret:${name}`;
}

function resolveSecretPath(
  ref: string,
  // Create-only (`secret set`): enforce a flat ref name and apply `--path` as
  // the subdirectory. Lookup callers omit this so nested refs keep resolving.
  create?: { subPath?: string },
): {
  name: string;
  absPath: string;
  source: IndexSearchSource;
} {
  const parsed = parseSecretRef(ref);
  if (parsed.type !== "secret") {
    throw new UsageError(`Expected a secret ref (secret:<name>); got "${ref}".`);
  }
  if (create) {
    assertFlatAssetName(parsed.name);
    parsed.name = combineCreatePath(normalizeCreateSubPath(create.subPath), parsed.name);
  }
  // Source resolution is identical for every asset type; reuse the env helper.
  const source = findEnvSource(parsed.origin);
  const typeRoot = path.join(source.path, "secrets");
  const absPath = resolveAssetPathFromName("secret", typeRoot, parsed.name);
  // Defense-in-depth: ensure the resolved path stays inside the secrets dir.
  if (!isWithin(absPath, typeRoot)) {
    throw new UsageError(`Secret name "${parsed.name}" escapes the secrets directory.`);
  }
  return { name: parsed.name, absPath, source };
}

/** Walk `secrets/` across all stashes, returning one entry per secret file. */
function listSecretsRecursive(): Array<{ ref: string; path: string }> {
  const result: Array<{ ref: string; path: string }> = [];
  for (const source of resolveSourceEntries(undefined, loadConfig())) {
    const secretsDir = path.join(source.path, "secrets");
    if (!fs.existsSync(secretsDir)) continue;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.endsWith(".lock") || entry.name.endsWith(".sensitive")) continue;
        // A sibling `<name>.sensitive` marker suppresses listing.
        if (fs.existsSync(`${full}.sensitive`)) continue;
        const canonical = deriveCanonicalAssetName("secret", secretsDir, full);
        if (!canonical) continue;
        result.push({ ref: makeSecretRef(canonical, source), path: full });
      }
    };
    walk(secretsDir);
  }
  return result;
}

const secretListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List all secrets across all stashes by name (the file contents are never shown)",
  },
  run() {
    return runWithJsonErrors(async () => {
      output("secret-list", { secrets: listSecretsRecursive() });
    });
  },
});

const secretSetCommand = defineCommand({
  meta: {
    name: "set",
    description:
      "Create or overwrite a secret. The value is read from stdin by default (never via argv). Use --from-file <path> to import an existing file byte-exact, or --from-env <VAR> to read from an environment variable. Multi-line values are allowed.",
  },
  args: {
    ref: {
      type: "positional",
      description: "Secret ref (flat name, e.g. secret:deploy-key or just deploy-key; use --path for a subdirectory)",
      required: true,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under secrets/ to place the secret in (e.g. 'team'). The filename comes from the name.",
    },
    "from-file": { type: "string", description: "Read the value from this file (stored byte-exact)" },
    "from-env": { type: "string", description: "Read the value from the named environment variable" },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { setSecret } = await import("./commands/secret.js");
      const { name, absPath, source } = resolveSecretPath(args.ref, { subPath: getStringArg(args, "path") });

      const fromEnv = getHyphenatedArg<string>(args, "from-env");
      const fromFile = getHyphenatedArg<string>(args, "from-file");
      if (fromEnv !== undefined && fromFile !== undefined) {
        throw new UsageError("Pass only one of --from-file or --from-env (or use stdin).", "INVALID_FLAG_VALUE");
      }

      const MAX_SECRET_BYTES = 5 * 1024 * 1024; // 5 MB
      let value: Buffer;
      if (fromFile !== undefined) {
        if (!fs.existsSync(fromFile)) {
          throw new NotFoundError(`File not found: ${fromFile}`, "FILE_NOT_FOUND");
        }
        value = fs.readFileSync(fromFile);
        if (value.byteLength > MAX_SECRET_BYTES) {
          throw new UsageError("Secret exceeds the 5 MB limit.");
        }
      } else if (fromEnv !== undefined) {
        const envVal = process.env[fromEnv];
        if (envVal === undefined) {
          throw new UsageError(`Environment variable "${fromEnv}" is not set.`, "INVALID_FLAG_VALUE");
        }
        value = Buffer.from(envVal, "utf8");
      } else {
        if (process.stdin.isTTY) {
          process.stderr.write(`Enter value for secret "${name}" (Ctrl-D when done):\n`);
        }
        let totalBytes = 0;
        const chunks: Uint8Array[] = [];
        for await (const chunk of Bun.stdin.stream()) {
          totalBytes += chunk.byteLength;
          if (totalBytes > MAX_SECRET_BYTES) {
            throw new UsageError("Secret exceeds the 5 MB limit.");
          }
          chunks.push(chunk);
        }
        // Strip a single trailing newline so `echo "$TOKEN" | akm secret set`
        // stores the token without the shell-added newline. Use --from-file for
        // byte-exact storage of multi-line material (PEM keys, certs).
        value = Buffer.from(Buffer.concat(chunks).toString("utf8").replace(/\n$/, ""), "utf8");
      }

      setSecret(absPath, value);
      output("secret-set", { ref: makeSecretRef(name, source) });
    });
  },
});

const secretPathCommand = defineCommand({
  meta: {
    name: "path",
    description:
      "Print the absolute secret file path for the Docker `_FILE` convention, e.g. `MY_SECRET_FILE=$(akm secret path secret:deploy-key)`.",
  },
  args: {
    ref: { type: "positional", description: "Secret ref", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { name, absPath, source } = resolveSecretPath(args.ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Secret not found: ${makeSecretRef(name, source)}`);
      }
      process.stdout.write(`${absPath}\n`);
    });
  },
});

const secretRunCommand = defineCommand({
  meta: {
    name: "run",
    description:
      "Run a command with a secret's value injected into an env var: `akm secret run <ref> <VAR> -- <command>`. The value is set as $VAR in the child process only.",
  },
  args: {
    ref: { type: "positional", description: "Secret ref", required: true },
    var: { type: "positional", description: "Environment variable name to inject the value into", required: true },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      // Validate the target env var name FIRST (before the command split) so a
      // dangerous/invalid name is rejected regardless of how the command is
      // supplied — and so the failure does not depend on argv parsing.
      const varName = args.var;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
        throw new UsageError(`"${varName}" is not a valid environment variable name.`, "INVALID_FLAG_VALUE");
      }
      const { isDangerousEnvKey } = await import("./commands/lint/env-key-rules.js");
      if (isDangerousEnvKey(varName)) {
        throw new UsageError(
          `Refusing to inject a secret into "${varName}": it is a known process-hijacking variable (e.g. LD_PRELOAD, PATH).`,
          "INVALID_FLAG_VALUE",
        );
      }

      const dashIndex = process.argv.indexOf("--");
      if (dashIndex < 0 || dashIndex === process.argv.length - 1) {
        throw new UsageError("Missing command. Usage: akm secret run <ref> <VAR> -- <command>");
      }
      const command = process.argv.slice(dashIndex + 1);

      const { name, absPath, source } = resolveSecretPath(args.ref);
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Secret not found: ${makeSecretRef(name, source)}`);
      }
      const { readValue } = await import("./commands/secret.js");

      const mergedEnv = { ...process.env };
      mergedEnv[varName] = readValue(absPath).toString("utf8");

      // Audit trail: record access by ref + var name only — never the value.
      appendEvent({
        eventType: "secret_access",
        ref: makeSecretRef(name, source),
        metadata: { var: varName },
      });

      const result = spawnSync(command[0] as string, command.slice(1), {
        stdio: "inherit",
        env: mergedEnv,
      });
      if (result.error) {
        const err = result.error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          throw new NotFoundError(
            `Command not found: ${command[0]}`,
            "FILE_NOT_FOUND",
            `Install '${command[0]}' or add its directory to PATH before invoking 'akm secret run'.`,
          );
        }
        if (err.code === "EACCES") {
          throw new ConfigError(
            `Command not executable: ${command[0]}`,
            "STASH_DIR_UNREADABLE",
            `Add execute permission ('chmod +x ${command[0]}') or invoke via an interpreter.`,
          );
        }
        throw err;
      }
      process.exit(result.status ?? 0);
    });
  },
});

const secretRemoveCommand = defineCommand({
  meta: { name: "remove", description: "Remove a secret (and its .sensitive marker, if any)" },
  args: {
    ref: { type: "positional", description: "Secret ref", required: true },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation prompt", default: false },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { name, absPath, source } = resolveSecretPath(args.ref);
      const { confirmDestructive } = await import("./cli/confirm.js");
      const confirmed = await confirmDestructive(`Remove secret "${args.ref}"? This cannot be undone.`, {
        yes: args.yes === true,
      });
      if (!confirmed) {
        process.stderr.write("Aborted.\n");
        return;
      }
      const { removeSecret } = await import("./commands/secret.js");
      if (!fs.existsSync(absPath)) {
        throw new NotFoundError(`Secret not found: ${makeSecretRef(name, source)}`);
      }
      const removed = removeSecret(absPath);
      output("secret-remove", { ref: makeSecretRef(name, source), removed });
    });
  },
});

const secretCommand = defineCommand({
  meta: {
    name: "secret",
    description:
      "Manage secrets — a single sensitive value used on its own for authentication (an API token, a PEM private key, a TLS cert), one value per file. Names are visible; the file contents are the value and never appear in structured output. For a group of related configuration loaded together, use `akm env`.",
  },
  subCommands: {
    list: secretListCommand,
    path: secretPathCommand,
    run: secretRunCommand,
    set: secretSetCommand,
    remove: secretRemoveCommand,
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      if (hasSubcommand(args, SECRET_SUBCOMMAND_SET)) return;
      output("secret-list", { secrets: listSecretsRecursive() });
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
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip confirmation prompt (required in non-interactive shells)",
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
      const { confirmDestructive } = await import("./cli/confirm.js");
      const confirmed = await confirmDestructive(`Remove wiki "${args.name}"? This cannot be undone.`, {
        yes: args.yes === true,
      });
      if (!confirmed) {
        process.stderr.write("Aborted.\n");
        return;
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
      const { content, preferredName } = await (async () => {
        if (!isHttpUrl(args.source)) return readKnowledgeInput(args.source);
        const { fetchWebsiteMarkdownSnapshot } = await import("./sources/website-ingest");
        const snapshot = await fetchWebsiteMarkdownSnapshot(args.source);
        return { content: snapshot.content, preferredName: args.as ?? snapshot.preferredName };
      })();

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
    description:
      "Dispatch an agent to execute the ingest workflow for this wiki. Uses --profile or config.defaults.agent.",
  },
  args: {
    name: { type: "positional", description: "Wiki name", required: true },
    profile: {
      type: "string",
      description: "Agent profile to use (default: config.defaults.agent).",
    },
    model: {
      type: "string",
      description: "Model override — accepts aliases (opus, sonnet, haiku) or exact platform model IDs.",
    },
    "timeout-ms": { type: "string", description: "Override the agent CLI timeout in milliseconds." },
  },
  run({ args }) {
    return runWithJsonErrors(async () => {
      const { buildIngestWorkflow } = await import("./wiki/wiki.js");
      const stashDir = resolveStashDir();
      const built = buildIngestWorkflow(stashDir, args.name);

      const config = loadConfig();
      const profileName = getStringArg(args, "profile") ?? config.defaults?.agent;
      if (!profileName) {
        throw new UsageError(
          "akm wiki ingest requires an agent profile. Pass --profile <name> or set defaults.agent in config.",
          "MISSING_REQUIRED_ARGUMENT",
          "Available profiles are listed under profiles.agent in your config. Run `akm config get profiles.agent` to inspect.",
        );
      }

      const timeoutMs = parsePositiveIntFlag(getHyphenatedArg<string>(args, "timeout-ms"), "--timeout-ms");
      const model = getStringArg(args, "model");

      const { getDefaultLlmConfig } = await import("./core/config.js");
      const dispatchResult = await akmAgentDispatch({
        profileName,
        agentConfig: config,
        llmConfig: getDefaultLlmConfig(config),
        prompt: built.workflow,
        dispatch: {
          prompt: built.workflow,
          ...(model !== undefined ? { model } : {}),
        },
        ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      });

      output("wiki-ingest", {
        wiki: built.wiki,
        path: built.path,
        schemaPath: built.schemaPath,
        dispatched: true,
        profile: profileName,
        agentResult: dispatchResult,
      });
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

// ── `akm log` ────────────────────────────────────────────────────────────────
// Append-only events stream surface (#204). `list` reads state.db events
// with optional --since/--type/--ref filters; `tail` follows the table via
// a polling loop and prints each event as a single JSONL line.

const eventsListCommand = defineCommand({
  meta: { name: "list", description: "List events from the append-only state.db events stream" },
  args: {
    since: {
      type: "string",
      description: "ISO timestamp / epoch ms, OR `@offset:<id>` for a durable row-id cursor (resume across processes)",
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
  meta: { name: "tail", description: "Follow the append-only state.db events stream (polling)" },
  args: {
    since: {
      type: "string",
      description: "ISO timestamp / epoch ms, OR `@offset:<id>` for a durable row-id cursor (resume across processes)",
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
      const intervalMs = parsePositiveIntFlag(getHyphenatedArg<string>(args, "interval-ms"), "--interval-ms");
      const maxDurationMs = parsePositiveIntFlag(
        getHyphenatedArg<string>(args, "max-duration-ms"),
        "--max-duration-ms",
      );
      const maxEvents = parsePositiveIntFlag(getHyphenatedArg<string>(args, "max-events"), "--max-events");
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

const logCommand = defineCommand({
  meta: {
    name: "log",
    description: "Read or follow the append-only state.db events stream (mutations, feedback, indexing)",
  },
  subCommands: {
    list: eventsListCommand,
    tail: eventsTailCommand,
  },
});

// ── lessons subcommands (Phase 7A / Advantage D4c) ──────────────────────────

const lessonsCoverageCommand = defineCommand({
  meta: {
    name: "coverage",
    description:
      "Report tags that exist on indexed assets but are NOT yet covered by any lesson.\n\n" +
      "Useful for spotting topics where the stash has skills/commands/scripts but no\n" +
      "crystallized lesson — a signal that the team has tacit knowledge worth distilling.\n\n" +
      "Default output is JSON: { uncoveredTags: string[], lessonTagCount: number, totalTagCount: number }.\n" +
      "Pass --format text for a plain-text bulleted list.",
  },
  args: {},
  run() {
    return runWithJsonErrors(() => {
      const db = openExistingDatabase();
      try {
        const allTagSet = collectTagSetFromEntries(db, undefined);
        const lessonTagSet = collectTagSetFromEntries(db, "lesson");
        const uncovered: string[] = [];
        for (const tag of allTagSet) {
          if (!lessonTagSet.has(tag)) uncovered.push(tag);
        }
        uncovered.sort((a, b) => a.localeCompare(b));
        output("lessons-coverage", {
          ok: true,
          uncoveredTags: uncovered,
          lessonTagCount: lessonTagSet.size,
          totalTagCount: allTagSet.size,
        });
      } finally {
        closeDatabase(db);
      }
    });
  },
});

const lessonsCommand = defineCommand({
  meta: {
    name: "lessons",
    alias: "lesson",
    description: "Lesson-asset tooling: tag-coverage gaps, strength queries.",
  },
  subCommands: {
    coverage: lessonsCoverageCommand,
  },
});

const agentCommand = defineCommand({
  meta: {
    name: "agent",
    description:
      "Dispatch an agent CLI (opencode, claude, …) with an optional agent asset that provides the system prompt, model, and tool policy. Use <agent-ref> to embody a stash agent, --model to override the model, and --prompt/--command/--workflow to provide the task.",
  },
  args: {
    profile: {
      type: "positional",
      description: "Agent profile / platform to use (opencode, claude, …)",
      required: false,
    },
    "agent-ref": {
      type: "positional",
      description:
        "Optional agent asset ref (e.g. agent:code-reviewer). Loads system prompt, model, and tool policy from the stash asset.",
      required: false,
    },
    prompt: { type: "string", description: "Task prompt to pass to the agent" },
    command: { type: "string", description: "Load prompt from a command: asset" },
    workflow: { type: "string", description: "Load prompt from a workflow: asset" },
    model: {
      type: "string",
      description:
        "Model override — accepts aliases (opus, sonnet, haiku) or exact platform model IDs. Overrides the model specified in the agent asset.",
    },
    "timeout-ms": { type: "string", description: "Override the agent CLI timeout in milliseconds" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      if (!args.profile) {
        throw new UsageError(
          "Usage: akm agent <profile> [<agent-ref>] [--prompt <text>] [--model <model>]",
          "MISSING_REQUIRED_ARGUMENT",
          "Provide the agent profile name. Available profiles are listed in profiles.agent.",
        );
      }

      const timeoutMs = parsePositiveIntFlag(getHyphenatedArg<string>(args, "timeout-ms"), "--timeout-ms");

      const config = loadConfig();
      const { getDefaultLlmConfig } = await import("./core/config.js");
      // After 0.8.0 the agent block IS the loaded AkmConfig.
      const agentConfig = config;

      // Resolve agent asset ref → extract system prompt, model, and tool policy.
      const agentRef = getStringArg(args, "agent-ref");

      let systemPrompt: string | undefined;
      let assetModel: string | undefined;
      let assetTools: import("./sources/types.js").ShowResponse["toolPolicy"] | undefined;

      if (agentRef) {
        const { akmShowUnified } = await import("./commands/show.js");
        const asset = await akmShowUnified({ ref: agentRef, detail: "full" });
        systemPrompt = typeof asset.content === "string" ? asset.content : undefined;
        assetModel = typeof asset.modelHint === "string" ? asset.modelHint : undefined;
        assetTools = asset.toolPolicy;
      }

      // --model flag wins over the asset's modelHint.
      const model = getStringArg(args, "model") ?? assetModel;

      const promptText = getStringArg(args, "prompt");
      const commandRef = getStringArg(args, "command");
      const workflowRef = getStringArg(args, "workflow");

      // Only build a dispatch request when there is something to dispatch — a
      // prompt, an agent asset, or a model override. When none of these are
      // present the agent is launched interactively (no injected prompt, no
      // platform-specific flags beyond the profile's base args).
      const hasDispatchContent = !!(promptText ?? commandRef ?? workflowRef ?? systemPrompt ?? model ?? assetTools);

      const result = await akmAgentDispatch({
        profileName: String(args.profile),
        prompt: promptText,
        commandRef,
        workflowRef,
        agentConfig,
        llmConfig: getDefaultLlmConfig(config),
        ...(hasDispatchContent
          ? {
              dispatch: {
                prompt: promptText ?? "",
                systemPrompt,
                model,
                tools: assetTools,
              },
            }
          : {}),
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
      "Scan stash .md files for structural issues (unquoted colons, missing updated field, orphaned stubs, placeholder stubs, missing name/type, stale paths). Use --fix to auto-fix Tier 1 issues. Exits 0 on success regardless of findings; use --fail-on-flagged for CI fail-on-finding behavior.",
  },
  args: {
    fix: { type: "boolean", description: "Apply auto-fixes in place", default: false },
    dir: { type: "string", description: "Override stash root directory (default: from config)" },
    "fail-on-flagged": {
      type: "boolean",
      description: "Exit non-zero when summary.flagged > 0 (CI-friendly). Default: exit 0 regardless of findings.",
      default: false,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = akmLint({
        fix: args.fix ?? false,
        dir: getStringArg(args, "dir"),
      });
      output("lint", result);
      if (args["fail-on-flagged"] && result.summary.flagged > 0) process.exit(EXIT_GENERAL);
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
    name: {
      type: "positional",
      description: "Asset name (flat, no '/'; use --path for a subdirectory)",
      required: false,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under the type dir to place the proposed asset in (e.g. 'release'). The filename comes from the name.",
    },
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
      // `name` is flat; subdirectory placement is `--path`'s job.
      assertFlatAssetName(String(args.name));
      const proposedName = combineCreatePath(normalizeCreateSubPath(getStringArg(args, "path")), String(args.name));
      const taskText = fileFromFlag ? fs.readFileSync(path.resolve(fileFromFlag), "utf8") : (taskFromFlag ?? "");
      const timeoutMs = parsePositiveIntFlag(getHyphenatedArg<string>(args, "timeout-ms"), "--timeout-ms");
      const result = await akmPropose({
        type: String(args.type),
        name: proposedName,
        task: taskText,
        profile: getStringArg(args, "profile"),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
    command: {
      type: "string",
      description:
        'Shell command to run on the schedule (no AI agent), e.g. "akm improve --auto-accept safe". Split on whitespace; quote the whole flag value.',
    },
    profile: { type: "string", description: "Agent profile to use for prompt targets (default: defaults.agent)" },
    params: { type: "string", description: "Workflow params as a JSON object" },
    name: { type: "string", description: "Human-readable name for the task" },
    "when-to-use": { type: "string", description: "Guidance on when this task runs or should be used" },
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
        command: args.command,
        profile: args.profile,
        params: args.params,
        name: args.name,
        when_to_use: getHyphenatedArg<string>(args, "when-to-use"),
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

function makeTasksToggleCommand(enabled: boolean) {
  const verb = enabled ? "enable" : "disable";
  const description = enabled
    ? "Enable a previously-disabled task"
    : "Disable a task in the OS scheduler without removing the file";
  return defineCommand({
    meta: { name: verb, description },
    args: { id: { type: "positional", description: "Task id", required: true } },
    async run({ args }) {
      await runWithJsonErrors(async () => {
        const { id } = parseTaskRef(args.id);
        const result = await akmTasksSetEnabled(id, enabled);
        output(`tasks-${verb}`, result);
      });
    },
  });
}

const tasksEnableCommand = makeTasksToggleCommand(true);
const tasksDisableCommand = makeTasksToggleCommand(false);

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
    alias: "task",
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

export const main = defineCommand({
  meta: {
    name: "akm",
    version: pkgVersion,
    description:
      "Agent Knowledge Management — search, show, and manage assets from your stash.\n\n" +
      "Exit codes:\n" +
      "  0   success\n" +
      "  1   general error / not found\n" +
      "  2   usage error\n" +
      "  4   health warn (akm health only)\n" +
      "  78  config error",
  },
  args: {
    format: { type: "string", description: "Output format (json|jsonl|text|yaml)", default: "json" },
    detail: {
      type: "string",
      description: "Detail level (verbosity): brief|normal|full. Default: brief.",
      default: "brief",
    },
    shape: {
      type: "string",
      description:
        "Output projection: human|agent|summary. 'agent' trims to agent-essential fields; " +
        "'summary' is only valid on 'akm show'. Default: human.",
    },
    quiet: {
      type: "boolean",
      alias: "q",
      description:
        "Suppress non-essential stderr output (banners, spinners, progress info). " +
        "Safety-critical output is never suppressed: errors, destructive-action confirmation prompts, " +
        "and auto-migration banners always appear regardless of --quiet.",
      default: false,
    },
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
    health: healthCommand,
    info: infoCommand,
    graph: graphCommand,
    db: dbCommand,
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
    sync: syncCommand,
    clone: cloneCommand,
    registry: registryCommand,
    config: configCommand,
    feedback: feedbackCommand,
    history: historyCommand,
    log: logCommand,
    lessons: lessonsCommand,
    agent: agentCommand,
    lint: lintCommand,
    improve: improveCommand,
    extract: extractCommand,
    propose: proposeCommand,
    proposal: proposalCommand,
    help: helpCommand,
    hints: hintsCommand,
    completions: completionsCommand,
    env: envCommand,
    secret: secretCommand,
    wiki: wikiCommand,
    tasks: tasksCommand,
  },
});

const CONFIG_SUBCOMMAND_SET = new Set(["path", "list", "show", "get", "set", "unset", "enable", "disable"]);
const ENV_SUBCOMMAND_SET = new Set(["list", "path", "export", "run", "create", "set", "unset", "remove"]);
const SECRET_SUBCOMMAND_SET = new Set(["list", "path", "run", "set", "remove"]);
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
// Canonical table lives in `src/cli/shared.ts` (EXIT_CODES). These aliases keep
// the local call sites terse. EXIT_HEALTH_WARN (4) is the `akm health` "warn"
// status — advisories fired but no hard failure; chosen to avoid colliding with
// GENERAL (1) and USAGE (2). CI monitors can map: 0=pass, 4=warn, 1=fail.
const EXIT_GENERAL = EXIT_CODES.GENERAL;
const EXIT_HEALTH_WARN = EXIT_CODES.HEALTH_WARN;

// Only run the CLI when this module is the direct entry point. When it is
// imported (e.g. by the in-process test harness in tests/_helpers/cli.ts),
// `import.meta.main` is false and we skip all startup side effects (argv
// mutation, output-mode init, index cleanup, banner, runMain) so importers
// can drive the `main` command themselves without the process exiting.
if (import.meta.main) {
  // citty reads process.argv directly and does not accept a custom argv array,
  // so we must replace process.argv with the normalized version before runMain.
  process.argv = normalizeShowArgv(process.argv);
  // Resolve output mode once at startup from the (normalized) argv and persisted
  // config. All subsequent output() calls read from this in-memory singleton.
  // `initOutputMode` can throw a UsageError when --format/--detail values are
  // invalid; surface it through the same JSON-error path the rest of the CLI uses
  // rather than letting the raw exception escape with a stack trace.
  try {
    applyEarlyStderrFlags(process.argv);
    initOutputMode(process.argv, loadConfig().output ?? {});
  } catch (error: unknown) {
    emitJsonError(error);
  }

  // `--shape summary` is only meaningful on `akm show`. Reject it up front for
  // every other command so a write command (e.g. `akm proposal accept …`)
  // fails fast BEFORE performing its mutation, rather than throwing at
  // output-shaping time after the side effect has already happened. The
  // shape-registry gate in shapeForCommand() remains as defense-in-depth (and
  // covers the in-process test harness, which skips this startup block).
  if (getOutputMode().shape === "summary" && process.argv[2] !== "show") {
    emitJsonError(new UsageError("'--shape summary' is only valid on 'akm show'.", "INVALID_SHAPE_VALUE"));
  }

  // One-time cleanup of stale 0.7.x index file at the old cache location.
  // 0.8.0 moved the index to $XDG_DATA_HOME/akm/index.db (getDataDir()).
  // If the old file exists at $XDG_CACHE_HOME/akm/index.db, remove it so the
  // user isn't confused by a phantom DB. Best-effort; never fatal.
  try {
    const oldIndexPath = path.join(getCacheDir(), "index.db");
    if (fs.existsSync(oldIndexPath)) {
      fs.rmSync(oldIndexPath, { force: true });
      fs.rmSync(`${oldIndexPath}-shm`, { force: true });
      fs.rmSync(`${oldIndexPath}-wal`, { force: true });
      warn(`Cleaned up stale 0.7.x index from ${oldIndexPath}. Canonical path is now ${getDbPath()}.`);
    }
  } catch {
    // Non-fatal; one-time warning only.
  }

  // First-time-user breadcrumb: when run with no subcommand AND no config
  // exists yet AND stderr is a TTY, print a friendly pointer to `akm setup`
  // above citty's auto-generated usage block. Triggers only when stdin/stderr
  // are interactive (so JSON-output users / CI consumers see nothing extra)
  // and stays silent for any flag-only invocation citty would handle itself
  // (--help, --version).
  (function maybePrintFirstTimeBanner(): void {
    const argv = process.argv.slice(2);
    // Fire only on completely bare `akm` invocation. Any explicit flag or
    // subcommand means the user knows what they want.
    if (argv.length > 0) return;
    if (!process.stderr.isTTY) return;
    try {
      if (fs.existsSync(getConfigPath())) return;
    } catch {
      // If we can't resolve the config path, assume non-fresh and stay silent.
      return;
    }
    console.error(
      plainize(
        "👋 First time with akm? Run `akm setup` to get started.\n   Docs: https://github.com/itlackey/akm#readme\n",
      ),
    );
  })();

  runMain(main);
}

// ── Hints (embedded AGENTS.md) ──────────────────────────────────────────────

function loadHints(detail: "brief" | "normal" | "full" = "normal"): string {
  // `brief` → the short AGENTS.md guide; `normal`/`full` → the complete guide.
  const wantFull = detail !== "brief";
  const filename = wantFull ? "AGENTS.full.md" : "AGENTS.md";
  const fallback = wantFull ? EMBEDDED_HINTS_FULL : EMBEDDED_HINTS;

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
