// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm wiki` command family. Extracted verbatim from src/cli.ts (WS6) so the
 * God Module shrinks; the `main.subCommands.wiki` key and every subcommand's
 * args/output shape are byte-identical. Handlers whose body is a plain
 * `runWithJsonErrors(...) + output(...)` are migrated to `defineJsonCommand`,
 * which emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * form. `wiki lint` keeps an explicit `runWithJsonErrors` because it calls
 * `process.exit(1)` after the wrapper when findings exist.
 */

import { defineCommand } from "citty";
import { getStringArg, hasSubcommand, parsePositiveIntFlag } from "../cli/parse-args";
import { defineJsonCommand, output, runWithJsonErrors } from "../cli/shared";
import { isHttpUrl, resolveStashDir } from "../core/common";
import { loadConfig, resolveConfiguredSources } from "../core/config/config";
import { ConfigError, UsageError } from "../core/errors";
import { getHyphenatedArg, getHyphenatedBoolean } from "../output/context";
import { akmAgentDispatch } from "./agent/agent-dispatch";
import { readKnowledgeInput } from "./read/knowledge";
import { buildWebsiteOptions } from "./sources/add-cli";

const wikiCreateCommand = defineJsonCommand({
  meta: { name: "create", description: "Scaffold a new wiki under <stashDir>/wikis/<name>/" },
  args: {
    name: { type: "positional", description: "Wiki name (lowercase, digits, hyphens)", required: true },
  },
  async run({ args }) {
    const { createWiki } = await import("../wiki/wiki.js");
    const stashDir = resolveStashDir();
    const result = createWiki(stashDir, args.name);
    output("wiki-create", result);
  },
});

const wikiRegisterCommand = defineJsonCommand({
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
  async run({ args }) {
    const { registerWikiSource } = await import("./sources/source-add");
    const result = await registerWikiSource({
      ref: args.ref.trim(),
      name: args.name,
      options: Object.keys(buildWebsiteOptions(args)).length > 0 ? buildWebsiteOptions(args) : undefined,
      writable: args.writable,
    });
    output("wiki-register", result);
  },
});

const wikiListCommand = defineJsonCommand({
  meta: { name: "list", description: "List wikis with page/raw counts and last-modified timestamps" },
  async run() {
    const { listWikis } = await import("../wiki/wiki.js");
    const stashDir = resolveStashDir();
    const wikis = listWikis(stashDir);
    output("wiki-list", { wikis });
  },
});

const wikiShowCommand = defineJsonCommand({
  meta: { name: "show", description: "Show a wiki's path, description, counts, and last 3 log entries" },
  args: {
    name: { type: "positional", description: "Wiki name", required: true },
  },
  async run({ args }) {
    const { showWiki } = await import("../wiki/wiki.js");
    const stashDir = resolveStashDir();
    const result = showWiki(stashDir, args.name);
    output("wiki-show", result);
  },
});

const wikiRemoveCommand = defineJsonCommand({
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
  async run({ args }) {
    const { confirmDestructive } = await import("../cli/confirm.js");
    const confirmed = await confirmDestructive(`Remove wiki "${args.name}"? This cannot be undone.`, {
      yes: args.yes === true,
    });
    if (!confirmed) {
      process.stderr.write("Aborted.\n");
      return;
    }
    const withSources = getHyphenatedBoolean(args, "with-sources");
    const { removeWiki } = await import("../wiki/wiki.js");
    const { akmIndex } = await import("../indexer/indexer");
    const stashDir = resolveStashDir();
    const result = removeWiki(stashDir, args.name, { withSources });
    await akmIndex({ stashDir });
    output("wiki-remove", result);
  },
});

const wikiPagesCommand = defineJsonCommand({
  meta: {
    name: "pages",
    description: "List wiki pages (ref + frontmatter description), excluding schema/index/log/raw",
  },
  args: {
    name: { type: "positional", description: "Wiki name", required: true },
  },
  async run({ args }) {
    const { listPages } = await import("../wiki/wiki.js");
    const stashDir = resolveStashDir();
    const pages = listPages(stashDir, args.name);
    output("wiki-pages", { wiki: args.name, pages });
  },
});

const wikiSearchCommand = defineJsonCommand({
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
  async run({ args }) {
    const { resolveWikiSource, searchInWiki } = await import("../wiki/wiki.js");
    const stashDir = resolveStashDir();
    resolveWikiSource(stashDir, args.name);
    const parsedLimit = args.limit ? Number(args.limit) : undefined;
    const limit =
      typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;
    const response = await searchInWiki({ stashDir, wikiName: args.name, query: args.query, limit });
    output("search", response);
  },
});

const wikiStashCommand = defineJsonCommand({
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
  async run({ args }) {
    const { stashRaw } = await import("../wiki/wiki.js");
    const { content, preferredName } = await (async () => {
      if (!isHttpUrl(args.source)) return readKnowledgeInput(args.source);
      const { fetchWebsiteMarkdownSnapshot } = await import("../sources/website-ingest");
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
      const { lintWiki } = await import("../wiki/wiki.js");
      const stashDir = resolveStashDir();
      const report = lintWiki(stashDir, args.name);
      output("wiki-lint", report);
      findingCount = report.findings.length;
    });
    if (findingCount > 0) process.exit(1); // EXIT_GENERAL
  },
});

const wikiIngestCommand = defineJsonCommand({
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
  async run({ args }) {
    const { buildIngestWorkflow } = await import("../wiki/wiki.js");
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

    const { getDefaultLlmConfig } = await import("../core/config/config.js");
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
  },
});

// Single source of truth: the routing set is derived from the subCommands keys
// (M10) so adding a subcommand can never silently desync from `hasSubcommand`.
const wikiSubCommands = {
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
};
const WIKI_SUBCOMMAND_SET = new Set(Object.keys(wikiSubCommands));

export const wikiCommand = defineCommand({
  meta: {
    name: "wiki",
    description:
      "Manage multiple markdown wikis (Karpathy-style). akm surfaces (lifecycle, raw/, lint, index); the agent writes pages.",
  },
  subCommands: wikiSubCommands,
  run({ args }) {
    return runWithJsonErrors(async () => {
      if (hasSubcommand(args, WIKI_SUBCOMMAND_SET)) return;
      // Default action: list wikis
      const { listWikis } = await import("../wiki/wiki.js");
      output("wiki-list", { wikis: listWikis(resolveStashDir()) });
    });
  },
});
