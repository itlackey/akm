// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm search`, `akm curate`, and `akm show` command family. Extracted verbatim
 * from src/cli.ts (WS6) so the God Module shrinks; the `main.subCommands.search`,
 * `.curate`, and `.show` keys and every command's args/output shape are
 * byte-identical. The three commands form a clean cluster: they share the
 * private `resolveEventSource()` helper and the `parseScopeFilterFlags`
 * search-source parsers. Handlers whose body is a plain
 * `runWithJsonErrors(async () => { … })` are migrated to `defineJsonCommand`,
 * which emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * form.
 */

import { parsePositiveIntFlag } from "../../cli/parse-args";
import { defineJsonCommand, output, parseAllFlagValues } from "../../cli/shared";
import { parseAssetRef } from "../../core/asset/asset-ref";
import { parseMetaRef } from "../../core/asset/stash-meta";
import { UsageError } from "../../core/errors";
import type { UsageEventSource } from "../../indexer/usage/usage-events";
import { getHyphenatedBoolean, getOutputMode, parseFlagValue } from "../../output/context";
import type { KnowledgeView, ShowDetailLevel } from "../../sources/types";
import { akmCurate } from "./curate";
import { akmSearch, parseBeliefFilterMode, parseScopeFilterFlags, parseSearchSource } from "./search";
import { akmShowUnified } from "./show";

// AKM_EVENT_SOURCE attributes a query to a `user` invocation, the internal
// `improve` loop, or the `task` runner so the event log can distinguish
// genuine demand from machine traffic; any other value is treated as unset.
function resolveEventSource(): UsageEventSource | undefined {
  const raw = process.env.AKM_EVENT_SOURCE;
  if (raw === "improve") return "improve";
  if (raw === "task") return "task";
  if (raw === "user") return "user";
  return undefined;
}

export const searchCommand = defineJsonCommand({
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
    "include-sessions": {
      type: "boolean",
      description:
        "Include session assets (excluded from default search results via config.search.defaultExcludeTypes).",
      default: false,
    },
  },
  async run({ args }) {
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
    const includeSessions = getHyphenatedBoolean(args, "include-sessions");
    const result = await akmSearch({
      query,
      type,
      limit,
      source,
      filters,
      includeProposed,
      belief,
      includeSessions,
      disableProjectContext: noProjectContext,
      disableScopedUtility: noProjectContext,
      eventSource: resolveEventSource(),
    });
    output("search", result);
  },
});

export const curateCommand = defineJsonCommand({
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
    const curated = await akmCurate({ query: args.query, type, limit, source, eventSource: resolveEventSource() });
    output("curate", curated);
  },
});

export const showCommand = defineJsonCommand({
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
  },
});
