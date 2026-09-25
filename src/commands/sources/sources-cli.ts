// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Source-management CLI commands — `akm upgrade/sync/clone`.
 *
 * Extracted verbatim from src/cli.ts (WS6). Each `main.subCommands.<key>`
 * registration line stays byte-identical; the args/output shape of every
 * subcommand is unchanged. The `runSyncBody` git-commit/push body is used
 * ONLY by this cluster, so it moves with it.
 *
 * Leaf handlers whose body is a plain `runWithJsonErrors(async () => { … })`
 * are migrated to `defineJsonCommand`, which emits the same JSON envelope
 * (stdout/stderr/exit-code) as the inline form. `sync` keeps `defineCommand`
 * because its `run` delegates to `runSyncBody` (which owns the
 * `runWithJsonErrors` wrapper) rather than wrapping inline.
 *
 * 0.9.0 CLI overhaul (S3): top-level `history` was dropped; its
 * `--accept-rate-by-source` metric was folded into `akm health --report`
 * (src/commands/health/accept-rate.ts).
 *
 * 0.9 CLI overhaul (S7): `list`/`remove`/`update` moved out of this cluster
 * into the new `akm bundle` group (src/commands/sources/bundle-cli.ts) — no
 * top-level `list`/`remove`/`update` remains. Root `sync` and this file's
 * `clone`/`upgrade` stay top-level (the shipped `core/sync.yml` task calls
 * `akm sync` directly).
 */
import { defineCommand } from "citty";
import { getParsedInvocation } from "../../cli/invocation";
import {
  defineJsonCommand,
  EXIT_CODES,
  GLOBAL_OUTPUT_ARGS,
  output,
  outputWithExitCode,
  runWithJsonErrors,
} from "../../cli/shared";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveWritableOverride, saveGitStash } from "../../sources/providers/git";
import { pkgVersion } from "../../version";
import { checkForUpdate, performUpgrade } from "./self-update";
import { akmClone } from "./source-clone";

export const upgradeCommand = defineJsonCommand({
  meta: { name: "upgrade", description: "Upgrade akm to the latest release" },
  args: {
    check: { type: "boolean", description: "Check for updates without installing", default: false },
    force: { type: "boolean", description: "Force upgrade even if on latest", default: false },
    "skip-post-upgrade": {
      type: "boolean",
      description: "Skip the post-upgrade index rebuild",
      default: false,
    },
  },
  async run({ args }) {
    const check = await checkForUpdate(pkgVersion);
    if (args.check) {
      output("upgrade", check);
      return;
    }
    const skipPostUpgrade = args["skip-post-upgrade"];
    const result = await performUpgrade(check, { force: args.force, skipPostUpgrade });
    // The install may have succeeded, but an upgrade whose migration is
    // blocked or could not run is not done: exit like `akm migrate apply` does.
    const migrationFailed = result.migration?.status === "blocked" || result.migration?.status === "failed";
    outputWithExitCode("upgrade", result, migrationFailed ? EXIT_CODES.GENERAL : undefined);
  },
});

// `sync` body, standalone so the git-commit/push logic stays in one place.
async function runSyncBody(args: { name?: string; message?: string; push?: boolean }): Promise<void> {
  await runWithJsonErrors(async () => {
    // The optional `name` positional is safe to trust: the global output flags
    // are declared on the command (GLOBAL_OUTPUT_ARGS), so `akm sync --format
    // json` parses `json` as the flag's value, never as a stash name.
    const effectiveName = args.name;

    let writable: boolean | undefined;
    if (effectiveName === undefined) {
      // Primary stash — honour the configured default bundle's writable flag.
      writable = resolveWritableOverride(loadConfig());
    }

    const result = saveGitStash(effectiveName, args.message, writable, { push: args.push !== false });
    appendEvent({
      eventType: "sync",
      metadata: {
        name: effectiveName ?? null,
        message: args.message ?? null,
        ok: (result as { ok?: boolean }).ok !== false,
      },
    });
    output("sync", result);
  });
}

export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description:
      "Sync changes in a git-backed bundle: commits (and pushes when writable + remote is configured). No-op for non-git bundles.",
  },
  // Raw defineCommand (not defineJsonCommand), so the global output flags are
  // spread in explicitly — without them the optional `name` positional would
  // swallow a space-separated global flag's value.
  args: {
    ...GLOBAL_OUTPUT_ARGS,
    name: {
      type: "positional",
      description: "Name of the git bundle to sync (default: primary bundle directory)",
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
    await runSyncBody(args);
  },
});

/**
 * `--target` was renamed to `--bundle` on `clone` in 0.9 (S8). citty is
 * non-strict, so the retired spelling is silently absorbed rather than
 * rejected — the asset then lands in the default bundle instead of the one
 * the caller named, with exit 0 and no error. Reject it explicitly instead.
 */
function rejectRetiredCloneTargetFlag(): void {
  if (!getParsedInvocation().hasFlag("--target")) return;
  throw new UsageError(
    "`akm clone --target` was renamed to `--bundle` in 0.9. Use `--bundle <name>` instead.",
    "INVALID_FLAG_VALUE",
  );
}

export const cloneCommand = defineJsonCommand({
  meta: {
    name: "clone",
    description: "Clone an asset from any source into a managed bundle or an unmanaged custom destination",
  },
  args: {
    ref: { type: "positional", description: "Asset ref (e.g. npm:@scope/pkg//scripts/deploy.sh)", required: true },
    name: { type: "string", description: "New name for the cloned asset" },
    force: { type: "boolean", description: "Overwrite if the asset already exists at the destination", default: false },
    bundle: {
      type: "string",
      description:
        "Override the managed destination. Accepts a bundle name from config; falls back to defaultWriteTarget then the working bundle.",
    },
    dest: { type: "string", description: "Unmanaged destination directory (cannot be combined with --bundle)" },
  },
  async run({ args }) {
    rejectRetiredCloneTargetFlag();
    const result = await akmClone({
      sourceRef: args.ref,
      newName: args.name,
      force: args.force,
      dest: args.dest,
      target: args.bundle,
    });
    output("clone", result);
  },
});
