// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm bundle` command group — 0.9 CLI overhaul (S7).
 *
 * Consolidates the five former top-level bundle-lifecycle commands under one
 * group, hard break, no alias kept at the top level:
 *   - `create` (= old top-level `init`, src/commands/sources/init.ts)
 *   - `add`    (= old top-level `add`, src/commands/sources/add-cli.ts — the
 *     command definition moved here; `add-cli.ts` keeps its exported helpers,
 *     including `auditInstalledStashForDangerousKeys`, which a test imports
 *     directly)
 *   - `list`   (= old top-level `list`)
 *   - `remove` (= old top-level `remove`)
 *   - `update` (= old top-level `update`)
 *   - `show <name>` — NEW: a single-bundle detail view of the `list` payload.
 *
 * `add`/`list`/`remove`/`update` are pure relocations (payload and output
 * shape unchanged: `SourceEntry`/`RemoveResponse`/`UpdateResponse` keep their
 * bare `add`/`list`/`remove`/`update` output shape). `create` is a genuine
 * verb rename (was `init`), so its output shape is renamed to `bundle-create`
 * to match (the same convention S8 used for `propose` -> `proposal new`'s
 * `proposal-new` shape). `show` is a new shape, `bundle-show`.
 */

import { defineGroupCommand, defineJsonCommand, output } from "../../cli/shared";
import { renameBundle } from "../../core/bundle-rename";
import { NotFoundError, TransientError, UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { warn } from "../../core/warn";
import type { SourceKind } from "../../sources/types";
import { akmTasksSync } from "../tasks/tasks";
import { addCommand } from "./add-cli";
import { akmInit } from "./init";
import { akmListSources, akmRemove, akmUpdate } from "./installed-stashes";

const VALID_SOURCE_KINDS = new Set<SourceKind>(["filesystem", "git", "npm", "website"]);

function parseKindFilter(raw: string | undefined): SourceKind[] | undefined {
  if (!raw) return undefined;
  const kinds = raw.split(",").map((s) => s.trim()) as SourceKind[];
  for (const k of kinds) {
    if (!VALID_SOURCE_KINDS.has(k)) {
      throw new UsageError(`Invalid --kind value: "${k}". Expected one of: filesystem, git, npm, website`);
    }
  }
  return kinds;
}

const createCommand = defineJsonCommand({
  meta: {
    name: "create",
    description: "Initialize akm's working bundle directory and persist it in config",
  },
  args: {
    dir: { type: "string", description: "Custom bundle directory path (default: ~/akm)" },
    "set-default": {
      type: "boolean",
      description:
        "Make --dir the default bundle. Without this, `akm bundle create --dir X` scaffolds X but leaves your existing default bundle unchanged.",
      default: false,
    },
  },
  async run({ args }) {
    const result = await akmInit({
      dir: args.dir,
      setDefault: args["set-default"],
    });
    output("bundle-create", result);
  },
});

const listCommand = defineJsonCommand({
  meta: { name: "list", description: "List configured bundles and their resolved source state" },
  args: {
    kind: {
      type: "string",
      description: "Filter by source provider (filesystem, git, npm, website). Comma-separated.",
    },
  },
  async run({ args }) {
    const kind = parseKindFilter(args.kind);
    const result = await akmListSources({ kind });
    output("list", result);
  },
});

const showCommand = defineJsonCommand({
  meta: { name: "show", description: "Show detail for a single configured bundle" },
  args: {
    name: { type: "positional", description: "Bundle name (as reported by `akm bundle list`)", required: true },
  },
  async run({ args }) {
    const { sources } = await akmListSources();
    const entry = sources.find((s) => s.name === args.name);
    if (!entry) {
      throw new NotFoundError(`No configured bundle named "${args.name}"`, "SOURCE_NOT_FOUND");
    }
    output("bundle-show", entry);
  },
});

const removeCommand = defineJsonCommand({
  meta: { name: "remove", description: "Remove a bundle by id, ref, path, URL, or name" },
  args: {
    target: { type: "positional", description: "Bundle to remove (id, ref, path, URL, or name)", required: true },
    yes: { type: "boolean", alias: "y", description: "Skip confirmation prompt", default: false },
  },
  async run({ args }) {
    const { confirmDestructive } = await import("../../cli/confirm.js");
    const confirmed = await confirmDestructive(`Remove bundle "${args.target}"? This cannot be undone.`, {
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

const updateCommand = defineJsonCommand({
  meta: {
    name: "update",
    description:
      "Refresh one or all configured bundles and reconcile their index. Git refresh is explicit; schedule this command for automatic updates.",
  },
  args: {
    target: { type: "positional", description: "Bundle to update (id or ref)", required: false },
    all: { type: "boolean", description: "Update all configured bundles and report each outcome", default: false },
    force: { type: "boolean", description: "Force fresh download even if version is unchanged", default: false },
    "skip-if-locked": {
      type: "boolean",
      description: "Exit successfully when index/state database contention shows another akm operation is active",
      default: false,
    },
    "allow-dangerous-env-keys": {
      type: "boolean",
      description:
        "Allow an update containing dangerous env keys (e.g. LD_PRELOAD, PATH). Use only after explicitly reviewing the staged bundle.",
      default: false,
    },
    // F1/R-058: gates ONLY the rare branch where the resolved content
    // directory moves and the previous `localRoot` is deleted — a normal
    // refresh (the overwhelming majority of updates) deletes nothing and
    // never consults this flag. Mirrors `remove`'s `-y/--yes`.
    yes: {
      type: "boolean",
      alias: "y",
      description:
        "Skip the confirmation prompt when an update needs to delete a previous install directory (because the resolved content location moved). No effect on a normal refresh, which deletes nothing.",
      default: false,
    },
  },
  async run({ args }) {
    let result: Awaited<ReturnType<typeof akmUpdate>>;
    try {
      result = await akmUpdate({
        target: args.target,
        all: args.all,
        force: args.force,
        yes: args.yes,
        allowDangerousEnvKeys: args["allow-dangerous-env-keys"],
      });
    } catch (error) {
      const skippable = isSkippableBundleUpdateLock(error);
      if (!args["skip-if-locked"] || !skippable) throw error;
      warn(`[bundle update] ${error.message}; skipping (--skip-if-locked)`);
      output("update", { ok: true, skipped: { reason: "lock-held", code: error.code } });
      return;
    }
    appendEvent({
      eventType: "update",
      metadata: {
        target: args.target ?? null,
        all: args.all === true,
        force: args.force === true,
        allowDangerousEnvKeys: args["allow-dangerous-env-keys"] === true,
        processed: Array.isArray((result as { processed?: unknown[] }).processed)
          ? (result as { processed: unknown[] }).processed.length
          : 0,
      },
    });
    output("update", result);
  },
});

const renameCommand = defineJsonCommand({
  meta: {
    name: "rename",
    description:
      "Rename a configured bundle's key everywhere akm persists it (config, lock, index, and its own proposals/task history). Content inside the bundle that still spells the old ref is reported, not rewritten.",
  },
  args: {
    old: { type: "positional", description: "Current bundle name", required: true },
    new: { type: "positional", description: "New bundle name (must be a legal, unused slug)", required: true },
    "dry-run": {
      type: "boolean",
      description: "Show the rename plan without writing anything",
      default: false,
    },
  },
  async run({ args }) {
    const result = await renameBundle(
      args.old,
      args.new,
      { dryRun: args["dry-run"] },
      {
        syncTasks: (newId, backend) => akmTasksSync({ backend }, newId),
      },
    );
    output("bundle-rename", result);
  },
});

export function isSkippableBundleUpdateLock(error: unknown): error is TransientError {
  return (
    error instanceof TransientError &&
    ["INDEX_DB_CONTENDED", "STATE_DB_CONTENDED", "MAINTENANCE_BARRIER_BUSY"].includes(error.code)
  );
}

export const bundleCommand = defineGroupCommand({
  meta: {
    name: "bundle",
    description: "Create, add to, inspect, and manage your bundles (working bundle + configured sources)",
  },
  subCommands: {
    create: createCommand,
    add: addCommand,
    list: listCommand,
    show: showCommand,
    remove: removeCommand,
    update: updateCommand,
    rename: renameCommand,
  },
});
