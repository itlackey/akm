// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { defineCommand } from "citty";
import { parsePositiveIntFlag } from "../cli/parse-args";
import { defineJsonCommand, output } from "../cli/shared";
import type { RegistryConfigEntry } from "../core/config/config";
import { DEFAULT_CONFIG, loadUserConfig, mutateConfig } from "../core/config/config";
import { UsageError } from "../core/errors";
import { warn } from "../core/warn";
import { buildRegistryIndex, writeRegistryIndex } from "../registry/build-index";
import { searchRegistry } from "./read/registry-search";

export const registryCommand = defineCommand({
  meta: { name: "registry", description: "Manage stash registries" },
  subCommands: {
    list: defineJsonCommand({
      meta: { name: "list", description: "List configured registries" },
      async run() {
        const config = loadUserConfig();
        const registries = config.registries ?? DEFAULT_CONFIG.registries;
        output("registry-list", { registries });
      },
    }),
    add: defineJsonCommand({
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
      async run({ args }) {
        if (!args.url.startsWith("http")) {
          throw new UsageError("Registry URL must start with http:// or https://");
        }
        if (args.url.startsWith("http://")) {
          const allowInsecure = args["allow-insecure"];
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
        let added = false;
        const updated = mutateConfig((config) => {
          const registries = [...(config.registries ?? [])];
          if (registries.some((registry) => registry.url === args.url)) return config;
          registries.push(entry);
          added = true;
          return { ...config, registries };
        }).config;
        output("registry-add", {
          registries: updated.registries ?? [],
          added,
          ...(!added ? { message: "Registry URL already configured" } : {}),
        });
      },
    }),
    remove: defineJsonCommand({
      meta: { name: "remove", description: "Remove a registry by URL or name" },
      args: {
        target: { type: "positional", description: "Registry URL or name to remove", required: true },
        yes: { type: "boolean", alias: "y", description: "Skip confirmation prompt", default: false },
      },
      async run({ args }) {
        const config = loadUserConfig();
        const registries = [...(config.registries ?? [])];
        const idx = registries.findIndex((r) => r.url === args.target || r.name === args.target);
        if (idx === -1) {
          output("registry-remove", { registries, removed: false, message: "No matching registry found" });
          return;
        }
        const { confirmDestructive } = await import("../cli/confirm.js");
        const confirmed = await confirmDestructive(`Remove registry "${args.target}"? This cannot be undone.`, {
          yes: args.yes === true,
        });
        if (!confirmed) {
          process.stderr.write("Aborted.\n");
          return;
        }
        let removed: RegistryConfigEntry | undefined;
        const updated = mutateConfig((latest) => {
          const current = [...(latest.registries ?? [])];
          const currentIndex = current.findIndex(
            (registry) => registry.url === args.target || registry.name === args.target,
          );
          if (currentIndex < 0) return latest;
          removed = current.splice(currentIndex, 1)[0];
          return { ...latest, registries: current };
        }).config;
        output("registry-remove", {
          registries: updated.registries ?? [],
          removed: removed !== undefined,
          ...(removed ? { entry: removed } : { message: "No matching registry found" }),
        });
      },
    }),
    search: defineJsonCommand({
      meta: { name: "search", description: "Search enabled registries for stashes" },
      args: {
        query: { type: "positional", description: "Search query", required: true },
        limit: { type: "string", description: "Maximum number of results" },
        assets: { type: "boolean", description: "Include asset-level search results", default: false },
      },
      async run({ args }) {
        const limitRaw = parsePositiveIntFlag(args.limit ?? undefined);
        const result = await searchRegistry(args.query, { limit: limitRaw, includeAssets: args.assets });
        output("registry-search", result);
      },
    }),
    "build-index": defineJsonCommand({
      meta: { name: "build-index", description: "Build a v2 registry index from discovery and manual entries" },
      args: {
        out: { type: "string", description: "Output path for the generated index" },
        manual: { type: "string", description: "Manual entries JSON file" },
        "npm-registry": { type: "string", description: "Override npm registry base URL" },
        "github-api": { type: "string", description: "Override GitHub API base URL" },
      },
      async run({ args }) {
        const result = await buildRegistryIndex({
          manualEntriesPath: args.manual,
          npmRegistryBase: args["npm-registry"],
          githubApiBase: args["github-api"],
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
      },
    }),
  },
});
