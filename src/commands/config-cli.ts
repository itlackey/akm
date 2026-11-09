// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineGroupCommand, defineJsonCommand, output } from "../cli/shared";
import { getConfigValueSource, loadConfig, mutateConfig } from "../core/config/config";
import { getConfigPath } from "../core/paths";
import {
  akmConfigDiff,
  assertUnsettable,
  getConfigValue,
  listConfig,
  redactSecretKeys,
  setConfigValue,
  unsetConfigValue,
} from "./config";

// ── `akm config` command surface ────────────────────────────────────────────
// Extracted verbatim from src/cli.ts (WS6). The `main.subCommands.config` key
// and every config subcommand's args/output shape are byte-identical. Leaf
// handlers whose body is a plain `runWithJsonErrors(() => { … })` are
// migrated to `defineJsonCommand`, which emits the same JSON envelope
// (stdout/stderr/exit-code) as the inline form.
//
// `akm config enable|disable` (a hardcoded alias for toggling the skills.sh
// registry) was removed in 0.9.0 (C4). Use `akm registry add|remove`, the
// general mechanism, instead.

export const configCommand = defineGroupCommand({
  meta: { name: "config", description: "Show and manage configuration" },
  subCommands: {
    path: defineJsonCommand({
      meta: { name: "path", description: "Print the path to the config file" },
      run() {
        console.log(getConfigPath());
      },
    }),
    list: defineJsonCommand({
      meta: { name: "list", description: "List current configuration" },
      run() {
        output("config", redactSecretKeys(listConfig(loadConfig())));
      },
    }),
    get: defineJsonCommand({
      meta: { name: "get", description: "Get a configuration value by key" },
      args: {
        key: { type: "positional", required: true, description: "Config key (for example: embedding, defaultBundle)" },
        "show-source": {
          type: "boolean",
          description: "Wrap the value as { value, source } (local or default)",
          default: false,
        },
      },
      run({ args }) {
        const value = getConfigValue(loadConfig(), args.key);
        output(
          "config",
          args["show-source"] ? { value: value ?? null, source: getConfigValueSource(args.key) } : (value ?? null),
        );
      },
    }),
    set: defineJsonCommand({
      meta: {
        name: "set",
        description:
          "Set a configuration value by key; prints the resulting config with ok: true. " +
          "Array and object values take JSON, quoted for the shell: akm config set projects.x.filters.project '[\"x\"]'. " +
          "Remove a key with `akm config unset`.",
      },
      args: {
        key: {
          type: "positional",
          required: true,
          description: "Config key (for example: defaultBundle, connections.fast.endpoint)",
        },
        value: { type: "positional", required: true, description: "Config value (JSON for arrays and objects)" },
        // #463: stable machine-friendly entry point for plugins / hooks.
        // `--silent` suppresses the config dump on stdout so hook-driven
        // writes don't pollute their host's output stream.
        silent: {
          type: "boolean",
          description: "Print nothing on success (for hooks and CI); errors still print",
          default: false,
        },
      },
      run({ args }) {
        const updated = mutateConfig((current) => setConfigValue(current, args.key, args.value)).config;
        if (!args.silent) {
          output("config", redactSecretKeys(listConfig(updated)));
        }
      },
    }),
    unset: defineJsonCommand({
      meta: {
        name: "unset",
        description:
          "Unset an optional configuration key or a whole section such as connections.fast or harnesses.opencode; prints the resulting config with ok: true",
      },
      args: {
        key: { type: "positional", required: true, description: "Config key to unset" },
        silent: {
          type: "boolean",
          description: "Print nothing on success (for hooks and CI); errors still print",
          default: false,
        },
      },
      run({ args }) {
        assertUnsettable(args.key);
        const result = mutateConfig((current) => unsetConfigValue(current, args.key), { absentNoop: true });
        const updated = result.config;
        if (!args.silent) {
          output("config", redactSecretKeys(listConfig(updated)));
        }
      },
    }),
    diff: defineJsonCommand({
      meta: {
        name: "diff",
        description: "Show effective-config differences against another config file, secrets redacted",
      },
      args: {
        ref: {
          type: "positional",
          required: true,
          description: "Other config file path",
        },
      },
      run({ args }) {
        output("config-diff", akmConfigDiff(args.ref));
      },
    }),
  },
  // The bare `akm config` invocation (and `akm config --list`) dumps the
  // current config. defineGroupCommand short-circuits this body when a
  // registered subcommand ran, so the routing set stays derived from the
  // subCommands map and can never desync.
  // Bare `akm config` runs `akm config list` (see insertBareListSubcommand in src/cli.ts).
});
