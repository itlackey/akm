// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm search`, `akm curate`, and `akm show` command family. Extracted verbatim
 * from src/cli.ts (WS6) so the God Module shrinks; the `main.subCommands.search`,
 * `.curate`, and `.show` keys and every command's args/output shape are
 * byte-identical. The three commands form a clean cluster: they share the
 * usage-event provenance and the `parseScopeFilterFlags`
 * search-source parsers. Handlers whose body is a plain
 * `runWithJsonErrors(async () => { … })` are migrated to `defineJsonCommand`,
 * which emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * form.
 */

import { getParsedInvocation } from "../../cli/invocation";
import { parsePositiveIntFlag } from "../../cli/parse-args";
import { defineJsonCommand, output, parseAllFlagValues } from "../../cli/shared";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { parseMetaRef } from "../../core/asset/stash-meta";
import { UsageError } from "../../core/errors";
import { resolveUsageEventSource } from "../../indexer/usage/usage-events";
import { getOutputMode, type OutputMode } from "../../output/context";
import { deliverRendered } from "../../output/html-render";
import type { FragmentContextMode, ShowDetailLevel } from "../../sources/types";
import { akmCurate, type CuratePackResult, type CurateResponse, packCuratedHits } from "./curate";
import { akmSearch, parseBeliefFilterMode, parseScopeFilterFlags, parseSearchSource } from "./search";
import { akmShowUnified } from "./show";

export const searchCommand = defineJsonCommand({
  meta: { name: "search", description: "Search the bundle" },
  args: {
    query: {
      type: "positional",
      description:
        'Search query (omit to list all assets). A conceptId-prefix query — "memories/projecta/", "bundle//", "bundle//skills/" — enumerates that subtree instead of keyword-matching; a trailing "/" is required, and an explicit --type wins over the prefix.',
      required: false,
      default: "",
    },
    type: {
      type: "string",
      description:
        "Asset type filter — free-form, exact match, unvalidated; an unknown type returns no hits (default: any). Built-ins: skill, command, agent, knowledge, workflow, script, memory, lesson, task, session, fact, env, secret, instruction — plus any adapter-defined type (e.g. website, wiki-source, a wiki pageKind). Use workflow to find step-by-step task assets.",
    },
    limit: { type: "string", description: "Maximum number of results" },
    from: { type: "string", description: "Search source (local|registry|all)", default: "local" },
    assets: {
      type: "boolean",
      description: "Include asset-level search results (only meaningful with --from registry|all)",
      default: false,
    },
    filter: {
      type: "string",
      description:
        "Scope filter (repeatable): --filter user=<id> --filter agent=<id> --filter run=<id> --filter channel=<name>. Narrows results without changing ranking.",
    },
    "include-proposed": {
      type: "boolean",
      description: 'Include entries with quality:"proposed" in the result set. Excluded by default.',
      default: false,
    },
    belief: {
      type: "string",
      description:
        "Memory belief filter: all|current|historical. current keeps active memory beliefs; historical keeps contradicted/superseded/archived memory beliefs.",
      default: "all",
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
    const type = args.type as string | undefined;
    const limit = parsePositiveIntFlag(args.limit ?? undefined);
    const source = parseSearchSource(args.from);
    // Repeatable; citty exposes only the last `--filter` value, so read all
    // occurrences directly from argv (same pattern as `--tag`).
    const filterTokens = parseAllFlagValues("--filter");
    const filters = parseScopeFilterFlags(filterTokens, "--filter");
    const includeProposed = args["include-proposed"] === true;
    const belief = parseBeliefFilterMode(typeof args.belief === "string" ? args.belief : undefined);
    const includeSessions = args["include-sessions"];
    const assets = args.assets === true;
    const outputMode = getOutputMode();
    const result = await akmSearch({
      query,
      type,
      limit,
      source,
      filters,
      includeProposed,
      belief,
      includeSessions,
      assets,
      eventSource: resolveUsageEventSource(),
      attributionProjection: outputMode.shape === "agent" ? "agent" : outputMode.detail,
    });
    output("search", result);
  },
});

export const curateCommand = defineJsonCommand({
  meta: {
    name: "curate",
    description:
      "Pick the assets worth loading for a task. Unlike `akm search`, this attaches a preview and run details per hit, adds related support refs, and summarizes the set — the usual starting point for an agent.",
  },
  args: {
    // Optional in citty so run() is invoked when omitted; we re-validate
    // below to surface a structured UsageError (exit 2) instead of citty's
    // default help-banner exit-0.
    query: { type: "positional", description: "Task or prompt to curate assets for", required: false },
    type: {
      type: "string",
      description:
        "Asset type filter — free-form, exact match, unvalidated; an unknown type returns no hits (default: any). Built-ins: skill, command, agent, knowledge, workflow, script, memory, lesson, task, session, fact, env, secret, instruction — plus any adapter-defined type (e.g. website, wiki-source, a wiki pageKind). Use workflow to curate step-by-step task assets.",
    },
    limit: { type: "string", description: "Maximum number of curated results", default: "4" },
    from: { type: "string", description: "Search source (local|registry|all)", default: "local" },
    pack: {
      type: "string",
      description:
        "Pack the ranked stash hits' full content into a single token-budgeted blob instead of returning refs " +
        "to follow up on individually — value is the max token budget, e.g. --pack 4000 (~4 chars/token, same " +
        "estimator as embedding). Content is resolved the same way `akm show` resolves it, so a ref#fragment " +
        "hit packs just that section. Registry hits (--from registry|all) are never packed. Not to be confused " +
        "with a workflow asset's own `budget` field (a run-cost cap) — this is a context-size target for this " +
        "one curate call.",
    },
  },
  async run({ args }) {
    const packBudget = parsePositiveIntFlag(args.pack ?? undefined, "--pack");
    const outputMode = getOutputMode();
    const curated = await runCurate(
      { query: args.query, type: args.type as string | undefined, limit: args.limit, from: args.from },
      outputMode,
    );
    if (packBudget !== undefined) {
      const packed = await packCuratedHits(curated, packBudget);
      deliverRendered(
        outputMode.format === "text" ? formatCuratePackText(packed) : JSON.stringify(packed.items, null, 2),
        outputMode.outputPath,
      );
      return;
    }
    output("curate", curated);
  },
});

/**
 * Validate the curate arguments and run the curation. The one path both
 * `akm curate` and the in-process `curate()` of `src/api.ts` go through, so
 * argument errors and ranking cannot drift between them. Takes the output
 * mode explicitly (it only picks the attribution projection) instead of
 * reading the process-level singleton.
 */
export async function runCurate(
  args: { query?: string; type?: string; limit?: string; from?: string },
  outputMode: Pick<OutputMode, "detail" | "shape">,
): Promise<CurateResponse> {
  if (!args.query || !String(args.query).trim()) {
    throw new UsageError(
      'A curate query is required. Usage: akm curate "<task or prompt>" [--type <type>] [--limit <n>]',
      "MISSING_REQUIRED_ARGUMENT",
      'Describe the task you want assets for, e.g. `akm curate "deploy to prod"`.',
    );
  }
  const limitParsed = parsePositiveIntFlag(args.limit ?? undefined);
  return akmCurate({
    query: args.query,
    type: args.type,
    limit: limitParsed && limitParsed > 0 ? limitParsed : 4,
    source: parseSearchSource(args.from ?? "local"),
    eventSource: resolveUsageEventSource(),
    attributionProjection: outputMode.shape === "agent" ? "agent" : outputMode.detail,
  });
}

/** Human-readable rendering for `akm curate --pack`: concatenated content per hit under a `## <ref>` header. */
function formatCuratePackText(packed: CuratePackResult): string {
  if (packed.items.length === 0) {
    return `No packed content for "${packed.query}" (budget ${packed.budget} tokens).`;
  }
  return packed.items.map((item) => `## ${item.ref}\n\n${item.content}`).join("\n\n");
}

/**
 * Reject any positional after the ref: `akm show` takes one ref, and a stray
 * token would otherwise silently render the whole item instead of what the
 * caller asked for.
 */
function rejectExtraShowPositionals(positionals: unknown, ref: string): void {
  const extra = (Array.isArray(positionals) ? (positionals as unknown[]).map(String) : []).slice(1);
  if (extra.length === 0) return;
  throw new UsageError(
    `akm show takes a single ref, but got ${extra.map((token) => `"${token}"`).join(" ")} after "${ref}". ` +
      `Use \`akm show ${ref}#<heading-slug>\` to read one section, or \`akm show ${ref}\` for the whole item.`,
    "INVALID_FLAG_VALUE",
    "An unmatched #fragment lists the available slugs.",
  );
}

export const showCommand = defineJsonCommand({
  meta: {
    name: "show",
    description: "Show a bundle asset by ref (e.g. akm show knowledge/guide.md, akm show knowledge/guide.md#auth)",
  },
  args: {
    ref: {
      type: "positional",
      description:
        "Asset ref ([bundle//]conceptId[#fragment]). On a markdown document `#fragment` selects one section by heading slug, and an unmatched fragment lists the available slugs. Example: `akm show knowledge/guide.md#auth`.",
      required: true,
    },
    filter: {
      type: "string",
      description:
        "Scope filter (repeatable): --filter user=<id> --filter agent=<id> --filter run=<id> --filter channel=<name>. Narrows resolution to assets whose frontmatter scope matches. Same axis as `akm search --filter`.",
    },
    context: {
      type: "string",
      description:
        "Fragment presentation: exact (default) returns only the selected section; lead returns bounded indexed-safe document lead plus the explicitly labelled selected match.",
    },
    "max-tokens": {
      type: "string",
      description:
        "Approximate context budget in tokens (four characters per token). Requires --context lead; mutually exclusive with --max-chars.",
    },
    "max-chars": {
      type: "string",
      description: "Exact context budget in characters. Requires --context lead; mutually exclusive with --max-tokens.",
    },
  },
  async run({ args }) {
    // `[origin//]meta[:name]` targets the stash `.meta/` convention, which is
    // not a typed asset ref — skip ref validation and let akmShowUnified
    // direct-read it. (the ref parser would reject the non-type `meta`.)
    if (!parseMetaRef(args.ref)) parseBundleRef(args.ref);
    rejectExtraShowPositionals(args._, args.ref);
    const invocation = getParsedInvocation();
    const cliShape = getOutputMode().shape;
    // F6/R-021 — `show` deliberately does NOT inherit `output.detail` from
    // config the way `search`/`curate` do via `getOutputMode().detail`
    // (which merges an explicit `--detail` flag with the config default,
    // "brief" out of the box). A bare `akm show <ref>` must always return
    // the FULL asset body regardless of `config.output.detail` — that is
    // the point of the command. This is a deliberate, permanent exemption,
    // not an oversight, so it is resolved through exactly one path here:
    // read the raw `--detail` flag directly (bypassing the config-merged
    // output mode on purpose) and only ever narrow the response when the
    // caller EXPLICITLY passed `--detail brief` on this invocation.
    // `--detail full` (explicit or, since it's also the implicit default,
    // omitted) and any other value fall through to the full response.
    const explicitDetail = invocation.getFlagValue("--detail");
    // `--shape summary` selects the compact metadata projection for show.
    // `--detail brief` forces the brief response regardless of shape.
    const showDetail: ShowDetailLevel | undefined =
      explicitDetail === "brief"
        ? "brief"
        : explicitDetail === "full"
          ? "full"
          : cliShape === "summary"
            ? "summary"
            : undefined;
    // `--filter` is repeatable — citty only exposes the last value, so read
    // every occurrence directly from argv (same helper as `akm search`; the two
    // commands share one spelling for the scope-narrowing axis).
    const scopeTokens = parseAllFlagValues("--filter");
    const scope = parseScopeFilterFlags(scopeTokens, "--filter");
    const contextMode = parseFragmentContextMode(typeof args.context === "string" ? args.context : undefined);
    const maxTokens = parsePositiveIntFlag(args["max-tokens"] ?? undefined, "--max-tokens");
    const maxChars = parsePositiveIntFlag(args["max-chars"] ?? undefined, "--max-chars");
    if (maxTokens !== undefined && maxChars !== undefined) {
      throw new UsageError("--max-tokens and --max-chars are mutually exclusive.", "INVALID_FLAG_VALUE");
    }
    const maxContextChars = maxChars ?? (maxTokens !== undefined ? maxTokens * 4 : undefined);
    if (maxContextChars !== undefined && !Number.isSafeInteger(maxContextChars)) {
      throw new UsageError("Fragment context budget is too large.", "INVALID_FLAG_VALUE");
    }
    const result = await akmShowUnified({
      ref: args.ref,
      detail: showDetail,
      contextMode,
      maxContextChars,
      scope,
      eventSource: resolveUsageEventSource(),
    });
    output("show", result);
  },
});

export function parseFragmentContextMode(raw: string | undefined): FragmentContextMode {
  const normalized = raw?.trim().toLowerCase() || "exact";
  if (normalized === "exact" || normalized === "lead") return normalized;
  throw new UsageError(`Invalid --context value: "${raw}". Expected exact or lead.`, "INVALID_FLAG_VALUE");
}
