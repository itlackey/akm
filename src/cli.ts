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

import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import { getStringArg, hasSubcommand, parsePositiveIntFlag } from "./cli/parse-args";
import { EXIT_CODES, emitJsonError, output, parseAllFlagValues, runWithJsonErrors } from "./cli/shared";
import { addCommand } from "./commands/add-cli";
import { akmAgentDispatch } from "./commands/agent-dispatch";
import { generateBashCompletions, installBashCompletions } from "./commands/completions";
import { getConfigValue, listConfig, setConfigValue, unsetConfigValue } from "./commands/config-cli";
import { akmCurate } from "./commands/curate";
import { akmDbBackups } from "./commands/db-cli";
import { envCommand } from "./commands/env-cli";
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
import { secretCommand } from "./commands/secret-cli";
import { checkForUpdate, performUpgrade } from "./commands/self-update";
import { akmShowUnified, normalizeShowArgv } from "./commands/show";
import { akmClone } from "./commands/source-clone";
import { tasksCommand } from "./commands/tasks-cli";
import { wikiCommand } from "./commands/wiki-cli";
import { workflowCommand } from "./commands/workflow-cli";
import { parseAssetRef } from "./core/asset-ref";
import { isHttpUrl, resolveStashDir } from "./core/common";
import { DEFAULT_CONFIG, loadConfig, loadUserConfig, saveConfig } from "./core/config";
import { UsageError } from "./core/errors";
import { appendEvent } from "./core/events";
import { getCacheDir, getConfigPath, getDbPath, getDefaultStashDir } from "./core/paths";
import { parseMetaRef } from "./core/stash-meta";
import { plainize } from "./core/tty";
import { clearLogFile, info, isQuiet, isVerbose, setLogFile, setQuiet, setVerbose, warn } from "./core/warn";
import { closeDatabase, collectTagSetFromEntries, openExistingDatabase } from "./indexer/db";
import { akmIndex } from "./indexer/indexer";
import { resolveSourceEntries } from "./indexer/search-source";
import { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL } from "./output/cli-hints";
import {
  getHyphenatedArg,
  getHyphenatedBoolean,
  getOutputMode,
  initOutputMode,
  parseDetailLevel,
  parseFlagValue,
} from "./output/context";
import { formatEventLine } from "./output/text";
import { resolveWritableOverride, saveGitStash } from "./sources/providers/git";
import type { KnowledgeView, ShowDetailLevel, SourceKind } from "./sources/types";
import { pkgVersion } from "./version";

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
