#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Runtime guard: the akm-cli npm package bootstraps with Node.js >= 20.12
// (#465, #560), then its launcher prefers a working Bun >= 1.0 when available.
// The runtime boundary (src/runtime.ts, src/storage/database.ts) supports both.
// Under Node the CLI must be launched via the
// `dist/cli-node.mjs` wrapper, which registers the text-import loader hook
// before this module graph loads; running `node dist/cli.js` directly still
// works for code paths that touch no embedded text asset, but the wrapper is
// the supported entry. The hard floor is Node 20.12: `@clack/core` (prompts) imports
// `node:util`'s `styleText` (added in Node 20.12) — Node 18 (EOL) throws at import.
{
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  if (!isBun) {
    const [major = 0, minor = 0, patch = 0] = (process.versions.node ?? "0")
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
    const nodeOk = major > 20 || (major === 20 && (minor > 12 || (minor === 12 && patch >= 0)));
    if (!nodeOk) {
      console.error(
        "\n  ERROR: the akm-cli npm package requires Node.js >= 20.12.\n" +
          `  Detected Node.js ${process.versions.node ?? "unknown"}.\n` +
          "  Bun >= 1.0 is optional for execution; it does not replace the Node.js bootstrap.\n" +
          "  Upgrade Node.js (https://nodejs.org), or install the runtime-free standalone binary:\n" +
          "    curl -fsSL https://github.com/itlackey/akm/releases/latest/download/install.sh | bash\n",
      );
      process.exit(1);
    }
  }
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
import { type ArgsDef, defineCommand, runMain } from "citty";
import {
  findCittyTopLevelCommand,
  findCittyTopLevelCommandIndex,
  parseAllFlagValues,
  resolveHelpMigrateVersionArg,
  setParsedInvocation,
} from "./cli/invocation";
import { EXIT_CODES, emitJsonError, output, runWithJsonErrors } from "./cli/shared";
import { agentCommand, lintCommand, proposeCommand } from "./commands/agent/contribute-cli";
import { backupCommand } from "./commands/backup-cli";
import { generateBashCompletions, installBashCompletions } from "./commands/completions";
import { configCommand } from "./commands/config-cli";
import { envCommand } from "./commands/env/env-cli";
import { secretCommand } from "./commands/env/secret-cli";
import { feedbackCommand } from "./commands/feedback-cli";
import { graphCommand } from "./commands/graph/graph-cli";
import { akmHealth } from "./commands/health";
import { renderRunsDetailMd, renderWindowCompareMd } from "./commands/health/md-report";
import type { WindowSpec } from "./commands/health/types";
import { parseWindowSpec } from "./commands/health/windows";
import { extractCommand } from "./commands/improve/extract-cli";
import { improveCommand } from "./commands/improve/improve-cli";
import { migrateCommand } from "./commands/migrate-cli";
import { mvCommand } from "./commands/mv-cli";
import { hintsCommand, lessonsCommand, logCommand } from "./commands/observability-cli";
import { proposalCommand } from "./commands/proposal/proposal-cli";
import { rememberCommand } from "./commands/read/remember-cli";
import { curateCommand, searchCommand, showCommand } from "./commands/read/search-cli";
import { normalizeShowArgv } from "./commands/read/show";
import { registryCommand } from "./commands/registry-cli";
import { addCommand } from "./commands/sources/add-cli";
import { renderMigrationHelp } from "./commands/sources/migration-help";
import {
  cloneCommand,
  historyCommand,
  listCommand,
  removeCommand,
  syncCommand,
  updateCommand,
  upgradeCommand,
} from "./commands/sources/sources-cli";
import { importKnowledgeCommand, indexCommand, infoCommand, initCommand } from "./commands/sources/stash-cli";
import { tasksCommand } from "./commands/tasks/tasks-cli";
import { workflowCommand } from "./commands/workflow-cli";
import { bestEffort } from "./core/best-effort";
import { DEFAULT_CONFIG, loadConfig } from "./core/config/config";
import { UsageError } from "./core/errors";
import { assertNoPendingMigrationOperation } from "./core/migration-operation";
import { getCacheDir, getConfigPath, getDbPath } from "./core/paths";
import { plainize } from "./core/tty";
import { info, isQuiet, setQuiet, setVerbose, warn } from "./core/warn";
import { disposeDispatchResources } from "./integrations/agent/runner-dispatch";
import { getHyphenatedBoolean, getOutputMode, initOutputMode } from "./output/context";
import { deliverRendered, renderHtml, resolveTemplatePath } from "./output/html-render";
import { pkgVersion } from "./version";

function applyEarlyStderrFlags(argv: string[]): void {
  if (argv.includes("--quiet") || argv.includes("-q")) {
    setQuiet(true);
  }
  if (argv.includes("--verbose")) {
    setVerbose(true);
  }
}

// resolveHelpMigrateVersionArg moved to ./cli/invocation (chunk-9 WI-9.9
// argv-normalization fold — it re-scanned process.argv, same as
// findCittyTopLevelCommand and parseAllFlagValues below).

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
    "no-init": {
      type: "boolean",
      default: false,
      description: "Write configuration without scaffolding the stash directory",
    },
    probe: {
      type: "boolean",
      default: false,
      description: "Probe LLM/embedding endpoints before writing config to verify connectivity",
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
      // citty treats a leading `no-` as boolean negation on some parse paths,
      // so retain the raw argv spelling as the authoritative compatibility form.
      const noInit = getHyphenatedBoolean(args, "no-init") || process.argv.includes("--no-init");
      const detectOnly = args["detect-only"];
      const resetRecommended = args["reset-recommended"];
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
    compare: {
      type: "string",
      description: "Comparison window for the --format html report's trend deltas (default: 24h)",
    },
  },
  async run({ args }) {
    let resultStatus: "pass" | "warn" | "fail" | undefined;
    await runWithJsonErrors(async () => {
      // citty only surfaces the last value of a repeated flag, so read --windows
      // directly from argv to support multi-window comparison.
      const rawWindows = parseAllFlagValues("--windows");
      const windows: WindowSpec[] | undefined =
        rawWindows.length > 0 ? rawWindows.map((raw) => parseWindowSpec(raw)) : undefined;
      const groupBy = args["group-by"];
      const windowCompareRaw = args["window-compare"];
      const mode = getOutputMode();

      // `--format html` is health-specific: render the full HTML health
      // report (charts, KPI cards, advisories) from the bespoke template.
      // Mirrors the `md` intercept below. Two reads, exactly like the
      // retired akm-health-report skill: the canonical per-run window plus a
      // window-compare read for the trend deltas (defaults to 24h,
      // overridable via --compare).
      if (mode.format === "html") {
        // Default the compare window to the report's own `--since` window so the
        // trend deltas are like-for-like (e.g. last 7d vs the prior 7d). A fixed
        // 24h default made a `--since 7d` report compare its 7-day totals against
        // a 24-hour prior window, producing meaningless deltas.
        const compare = args.compare ?? windowCompareRaw ?? args.since ?? "24h";
        const result = akmHealth({ since: args.since, groupBy: "run", windowCompare: compare });
        resultStatus = result.status;
        const deltas = result.deltas;
        const { buildHealthHtmlReplacements } = await import("./commands/health/html-report");
        const { listPendingProposals } = await import("./commands/proposal/proposal");
        const replacements = buildHealthHtmlReplacements(result, {
          window: args.since ?? "24h",
          compare,
          proposals: listPendingProposals(),
          deltas,
        });
        deliverRendered(renderHtml(resolveTemplatePath("health"), replacements), mode.outputPath);
        return;
      }

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
      if (mode.format === "md") {
        if (result.windows && result.windows.length > 0) {
          deliverRendered(renderWindowCompareMd(result.windows, result.deltas), mode.outputPath);
        } else if (result.runs) {
          deliverRendered(renderRunsDetailMd(result.runs), mode.outputPath);
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
    format: { type: "string", description: "Output format (json|jsonl|text|yaml|md|html)", default: "json" },
    output: {
      type: "string",
      description: "Write rendered output to a file instead of stdout (all formats except jsonl)",
    },
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
    mv: mvCommand,
    registry: registryCommand,
    migrate: migrateCommand,
    backup: backupCommand,
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
    tasks: tasksCommand,
  },
});

const MAIN_TOP_LEVEL_ARGS = main.args as ArgsDef;

function isTaskRunWithId(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  const commandIndex = findCittyTopLevelCommandIndex(args, MAIN_TOP_LEVEL_ARGS);
  const command = commandIndex >= 0 ? args[commandIndex] : undefined;
  if (command !== "tasks" && command !== "task") return false;
  const taskArgs = args.slice(commandIndex + 1);
  return taskArgs[0] === "run" && typeof taskArgs[1] === "string" && !taskArgs[1].startsWith("-");
}

/** Recovery/setup surfaces must remain reachable when config.json is invalid. */
export function shouldBypassConfigStartup(argv: readonly string[]): boolean {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.includes("--version") || args.includes("-v")) return true;
  const commandIndex = findCittyTopLevelCommandIndex(args, MAIN_TOP_LEVEL_ARGS);
  const command = commandIndex >= 0 ? args[commandIndex] : undefined;
  if (command === "setup" || command === "backup" || command === "migrate") return true;
  if (isTaskRunWithId(argv)) return true;
  if (command !== "config") return false;
  const configIndex = args.indexOf("config");
  const subcommand = args.slice(configIndex + 1).find((arg) => !arg.startsWith("-"));
  return subcommand === "path" || subcommand === "validate" || subcommand === "migrate";
}

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
//
// Node path: this module carries a `#!/usr/bin/env bun` shebang and is launched
// under Node via the `dist/cli-node.mjs` wrapper, which `import()`s this file
// (so `import.meta.main` is false here even though the CLI is the real entry).
// The wrapper sets `AKM_NODE_ENTRY=1` to opt into the startup block. The test
// harness never sets it, so importing cli.ts under Bun stays inert as before.
if (import.meta.main || process.env.AKM_NODE_ENTRY === "1") {
  // citty reads process.argv directly and does not accept a custom argv array,
  // so we must replace process.argv with the normalized version before runMain.
  process.argv = normalizeShowArgv(process.argv);
  // Mint the ParsedInvocation singleton from the (normalized) argv — the ONE
  // place argv is parsed for the whole process (plan §10.7 / chunk-9 WI-9.9).
  // Every out-of-cli.ts command module reads argv state through
  // `getParsedInvocation()` from here on instead of re-scanning process.argv.
  setParsedInvocation(process.argv);
  // Resolve output mode once at startup from the (normalized) argv and persisted
  // config. All subsequent output() calls read from this in-memory singleton.
  // `initOutputMode` can throw a UsageError when --format/--detail values are
  // invalid; surface it through the same JSON-error path the rest of the CLI uses
  // rather than letting the raw exception escape with a stack trace.
  try {
    applyEarlyStderrFlags(process.argv);
    if (isTaskRunWithId(process.argv)) assertNoPendingMigrationOperation();
    const bypassConfig = shouldBypassConfigStartup(process.argv);
    initOutputMode(process.argv, bypassConfig ? (DEFAULT_CONFIG.output ?? {}) : (loadConfig().output ?? {}));
  } catch (error: unknown) {
    emitJsonError(error);
  }

  // `--shape summary` is only meaningful on `akm show`. Reject it up front for
  // every other command so a write command (e.g. `akm proposal accept …`)
  // fails fast BEFORE performing its mutation, rather than throwing at
  // output-shaping time after the side effect has already happened. The
  // shape-registry gate in shapeForCommand() remains as defense-in-depth (and
  // covers the in-process test harness, which skips this startup block).
  const topLevelCommand = findCittyTopLevelCommand(process.argv.slice(2), MAIN_TOP_LEVEL_ARGS);
  if (getOutputMode().shape === "summary" && topLevelCommand !== "show") {
    emitJsonError(new UsageError("'--shape summary' is only valid on 'akm show'.", "INVALID_SHAPE_VALUE"));
  }

  // One-time cleanup of stale 0.7.x index file at the old cache location.
  // 0.8.0 moved the index to $XDG_DATA_HOME/akm/index.db (getDataDir()).
  // If the old file exists at $XDG_CACHE_HOME/akm/index.db, remove it so the
  // user isn't confused by a phantom DB. Best-effort; never fatal.
  if (!shouldBypassConfigStartup(process.argv)) {
    bestEffort(() => {
      const oldIndexPath = path.join(getCacheDir(), "index.db");
      if (fs.existsSync(oldIndexPath)) {
        fs.rmSync(oldIndexPath, { force: true });
        fs.rmSync(`${oldIndexPath}-shm`, { force: true });
        fs.rmSync(`${oldIndexPath}-wal`, { force: true });
        warn(`Cleaned up stale 0.7.x index from ${oldIndexPath}. Canonical path is now ${getDbPath()}.`);
      }
    }, "stale 0.7.x index cleanup is non-fatal");
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

  try {
    await runMain(main);
  } finally {
    await disposeDispatchResources();
  }
}
