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
import { configCommand } from "./commands/config-cli";
import { akmDbBackups } from "./commands/db-cli";
import { envCommand } from "./commands/env-cli";
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
import { improveCommand } from "./commands/improve-cli";
import { assembleInfo } from "./commands/info";
import { akmInit } from "./commands/init";
import { readKnowledgeInput, writeMarkdownAsset } from "./commands/knowledge";
import { akmLint } from "./commands/lint";
import { renderMigrationHelp } from "./commands/migration-help";
import { hintsCommand, lessonsCommand, logCommand } from "./commands/observability-cli";
import { proposalCommand } from "./commands/proposal-cli";
import { akmPropose } from "./commands/propose";
import { registryCommand } from "./commands/registry-cli";
import { rememberCommand } from "./commands/remember-cli";
import { curateCommand, searchCommand, showCommand } from "./commands/search-cli";
import { secretCommand } from "./commands/secret-cli";
import { normalizeShowArgv } from "./commands/show";
import {
  cloneCommand,
  historyCommand,
  listCommand,
  removeCommand,
  syncCommand,
  updateCommand,
  upgradeCommand,
} from "./commands/sources-cli";
import { tasksCommand } from "./commands/tasks-cli";
import { wikiCommand } from "./commands/wiki-cli";
import { workflowCommand } from "./commands/workflow-cli";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "./core/asset-create";
import { isHttpUrl } from "./core/common";
import { loadConfig } from "./core/config";
import { UsageError } from "./core/errors";
import { appendEvent } from "./core/events";
import { getCacheDir, getConfigPath, getDbPath } from "./core/paths";
import { plainize } from "./core/tty";
import { clearLogFile, info, isQuiet, isVerbose, setLogFile, setQuiet, setVerbose, warn } from "./core/warn";
import { akmIndex } from "./indexer/indexer";
import {
  getHyphenatedArg,
  getHyphenatedBoolean,
  getOutputMode,
  initOutputMode,
  parseFlagValue,
} from "./output/context";
import { pkgVersion } from "./version";

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
