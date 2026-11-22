// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Source-management CLI commands — `akm upgrade/sync/clone`.
 *
 * The `runSyncBody` git-commit/push body is used only by this cluster.
 *
 * Leaf handlers are `defineJsonCommand`s, which emit the JSON envelope
 * (stdout/stderr/exit-code). `sync` keeps `defineCommand` because its `run`
 * delegates to `runSyncBody` (which owns the `runWithJsonErrors` wrapper)
 * rather than wrapping inline.
 *
 * Bundle `list`/`remove`/`update` live in the `akm bundle` group
 * (src/commands/sources/bundle-cli.ts). Root `sync` and this file's
 * `clone`/`upgrade` are top-level (the shipped `core/sync.yml` task calls
 * `akm sync` directly).
 */
import { defineCommand } from "citty";
import {
  defineJsonCommand,
  EXIT_CODES,
  GLOBAL_OUTPUT_ARGS,
  output,
  outputWithExitCode,
  runWithJsonErrors,
} from "../../cli/shared";
import { pkgVersion } from "../../version";
import { runUpgrade } from "./plugin-upgrade";
import { checkForUpdate, performUpgrade } from "./self-update";
import { akmClone } from "./source-clone";
import { akmSync } from "./sync";

export const upgradeCommand = defineJsonCommand({
  meta: {
    name: "upgrade",
    description:
      "Upgrade akm to the latest release, then update the akm plugin of each installed harness " +
      "(Claude Code, Codex, OpenCode 1 and 2).",
  },
  args: {
    check: {
      type: "boolean",
      description: "Report pending updates, CLI and per-harness plugins, without changing anything",
      default: false,
    },
    force: { type: "boolean", description: "Force upgrade even if on latest", default: false },
    "skip-post-upgrade": {
      type: "boolean",
      description: "Skip the post-upgrade index rebuild",
      default: false,
    },
    "skip-checksum": {
      type: "boolean",
      description: "Recovery only: install even when the release checksum cannot be verified (not recommended)",
      default: false,
    },
    channel: { type: "string", description: "Switch akm and every installed harness plugin to latest or next" },
    "allow-downgrade": {
      type: "boolean",
      description: "Allow an explicit channel switch to install an older release",
      default: false,
    },
    next: {
      type: "boolean",
      description: "Deprecated: use `--channel next`. Install the newest prerelease (the @next npm tag)",
      default: false,
    },
  },
  async run({ args }) {
    const run = await runUpgrade(
      {
        check: args.check,
        force: args.force,
        skipPostUpgrade: args["skip-post-upgrade"],
        skipChecksum: args["skip-checksum"],
        next: args.next,
        channel: args.channel,
        allowDowngrade: args["allow-downgrade"],
      },
      pkgVersion,
      {
        checkForUpdate: (version, channel, exactChannel) => checkForUpdate(version, undefined, channel, exactChannel),
        performUpgrade: (check, opts) => performUpgrade(check, opts),
      },
    );
    if (run.mode === "check") {
      output("upgrade", run.result);
      return;
    }
    outputWithExitCode("upgrade", run.result, run.failed ? EXIT_CODES.GENERAL : undefined);
  },
});

// `sync` body: the output wrapper around `akmSync`, which the workspace's bundle commit runs too.
async function runSyncBody(args: { name?: string; message?: string; push?: boolean }): Promise<void> {
  await runWithJsonErrors(async () => {
    // The optional `name` positional is safe to trust: the global output flags
    // are declared on the command (GLOBAL_OUTPUT_ARGS), so `akm sync --format
    // json` parses `json` as the flag's value, never as a stash name.
    output("sync", akmSync(args));
  });
}

export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description:
      "Sync changes in a git-backed bundle: commits every unignored change inside the bundle (and pushes when writable + remote is configured, using the bundle's configured credential). No-op for non-git bundles.",
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
      description: "Push after commit when writable and a remote is configured (--no-push commits only)",
      default: true,
    },
  },
  async run({ args }) {
    await runSyncBody(args);
  },
});

export const cloneCommand = defineJsonCommand({
  meta: {
    name: "clone",
    description:
      "Deprecated, removed in 0.11: use `akm import <ref> --asset-ref`. Clone an asset from any source into a managed bundle or an unmanaged custom destination",
  },
  args: {
    ref: { type: "positional", description: "Asset ref (e.g. npm:@scope/pkg//scripts/deploy.sh)", required: true },
    name: { type: "string", description: "New name for the cloned asset" },
    force: { type: "boolean", description: "Overwrite if the asset already exists at the destination", default: false },
    bundle: {
      type: "string",
      description: "Managed destination: a bundle name (default: defaultWriteTarget)",
    },
    dest: { type: "string", description: "Unmanaged destination directory (cannot be combined with --bundle)" },
  },
  async run({ args }) {
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
