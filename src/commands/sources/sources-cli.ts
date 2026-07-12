// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Source-management CLI commands — `akm list/remove/update/upgrade/sync/clone/history`.
 *
 * Extracted verbatim from src/cli.ts (WS6). Each `main.subCommands.<key>`
 * registration line stays byte-identical; the args/output shape of every
 * subcommand is unchanged. The `--kind` filter helper (`parseKindFilter` +
 * `VALID_SOURCE_KINDS`), the `runSyncBody` git-commit/push body, and the
 * `wasFormatValueConsumedAsName` citty-mis-parse workaround are used ONLY by
 * this cluster, so they move with it.
 *
 * Leaf handlers whose body is a plain `runWithJsonErrors(async () => { … })`
 * are migrated to `defineJsonCommand`, which emits the same JSON envelope
 * (stdout/stderr/exit-code) as the inline form. `sync` keeps `defineCommand`
 * because its `run` delegates to `runSyncBody` (which owns the
 * `runWithJsonErrors` wrapper) rather than wrapping inline.
 */
import { defineCommand } from "citty";
import { defineJsonCommand, output, runWithJsonErrors } from "../../cli/shared";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { parseFlagValue } from "../../output/context";
import { resolveWritableOverride, saveGitStash } from "../../sources/providers/git";
import type { SourceKind } from "../../sources/types";
import { pkgVersion } from "../../version";
import { akmHistory } from "./history";
import { akmListSources, akmRemove, akmUpdate } from "./installed-stashes";
import { checkForUpdate, performUpgrade } from "./self-update";
import { akmClone } from "./source-clone";

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

export const listCommand = defineJsonCommand({
  meta: { name: "list", description: "List all sources (local directories, managed packages, remote providers)" },
  args: {
    kind: { type: "string", description: "Filter by source kind (local, managed, remote). Comma-separated." },
  },
  async run({ args }) {
    const kind = parseKindFilter(args.kind);
    const result = await akmListSources({ kind });
    output("list", result);
  },
});

export const removeCommand = defineJsonCommand({
  meta: { name: "remove", description: "Remove a source by id, ref, path, URL, or name" },
  args: {
    target: { type: "positional", description: "Source to remove (id, ref, path, URL, or name)", required: true },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation prompt", default: false },
  },
  async run({ args }) {
    const { confirmDestructive } = await import("../../cli/confirm.js");
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
  },
});

export const updateCommand = defineJsonCommand({
  meta: { name: "update", description: "Update one or all managed sources" },
  args: {
    target: { type: "positional", description: "Source to update (id or ref)", required: false },
    all: { type: "boolean", description: "Update all installed entries", default: false },
    force: { type: "boolean", description: "Force fresh download even if version is unchanged", default: false },
  },
  async run({ args }) {
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
  },
});

export const upgradeCommand = defineJsonCommand({
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
      description: "Skip the post-upgrade index rebuild (migration preflight and apply still run)",
      default: false,
    },
    "migration-config": {
      type: "string",
      description: "For 0.9+ upgrades, pass an operator-prepared config only to the new binary's migration apply",
    },
  },
  async run({ args }) {
    const check = await checkForUpdate(pkgVersion);
    if (args.check) {
      output("upgrade", check);
      return;
    }
    const skipChecksum = args["skip-checksum"];
    const skipPostUpgrade = args["skip-post-upgrade"];
    const migrationConfig = args["migration-config"];
    const result = await performUpgrade(check, { force: args.force, skipChecksum, skipPostUpgrade, migrationConfig });
    output("upgrade", result);
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

export const syncCommand = defineCommand({
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

export const cloneCommand = defineJsonCommand({
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
    const result = await akmClone({
      sourceRef: args.ref,
      newName: args.name,
      force: args.force,
      dest: args.dest,
    });
    output("clone", result);
  },
});

export const historyCommand = defineJsonCommand({
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
  async run({ args }) {
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
  },
});
