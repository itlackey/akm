// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm search`, `akm curate`, and `akm show` command family. Extracted verbatim
 * from src/cli.ts (WS6) so the God Module shrinks; the `main.subCommands.search`,
 * `.curate`, and `.show` keys and every command's args/output shape are
 * byte-identical. The three commands form a clean cluster: they share the
 * usage-event provenance and the `parseScopeFilterFlags`
 * search-source parsers. `show` takes a ref and applies no filter. Handlers whose body is a plain
 * `runWithJsonErrors(async () => { … })` are migrated to `defineJsonCommand`,
 * which emits the same JSON envelope (stdout/stderr/exit-code) as the inline
 * form.
 */

import { getParsedInvocation } from "../../cli/invocation";
import { getStringArg, PROJECT_ARG, parsePositiveIntFlag } from "../../cli/parse-args";
import { defineJsonCommand, output, parseAllFlagValues } from "../../cli/shared";
import type { ScopeFilters } from "../../core/adapter/types";
import { parseBundleRef } from "../../core/asset/asset-ref";
import { parseMetaRef } from "../../core/asset/stash-meta";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { type IncludeSelectors, normalizeInclude } from "../../core/include";
import { projectView, type ResolvedProject, resolveProject, withProjectLine } from "../../core/projects";
import { isoDay } from "../../core/time";
import type { ProjectContext } from "../../indexer/search/db-search";
import { resolveUsageEventSource, type UsageEventSource } from "../../indexer/usage/usage-events";
import { getOutputMode, type OutputMode } from "../../output/context";
import { deliverRendered } from "../../output/stdout";
import type { FragmentContextMode, ShowDetailLevel } from "../../sources/types";
import { akmCurate, type CuratePackResult, type CurateResponse, packCuratedHits } from "./curate";
import { akmSearch, parseBeliefFilterMode, parseScopeFilterFlags, parseSearchSource } from "./search";
import { akmShowUnified } from "./show";

const scopeFilterArg = {
  type: "string",
  description:
    "Frontmatter key=value filter (repeatable); a repeated key matches any value, different keys must all match",
} as const;
const scopePreferArg = {
  type: "string",
  description: "Like --filter, but matching assets rank slightly higher instead of being required",
} as const;
const beliefArg = {
  type: "string",
  description: "all|current|historical; historical keeps deprecated, contradicted, superseded and archived assets",
} as const;

export const searchCommand = defineJsonCommand({
  meta: { name: "search", description: "Search the bundle" },
  args: {
    query: {
      type: "positional",
      description:
        'Search query (omit to list all). A query ending in "/" (memories/projecta/, bundle//) lists that subtree',
      required: false,
      default: "",
    },
    type: {
      type: "string",
      description: "Asset type, exact match (e.g. skill, memory, knowledge, workflow); default: any",
    },
    limit: { type: "string", description: "Maximum number of results" },
    from: {
      type: "string",
      description: "local|registry|all or a bundle name (repeatable). Default: local, or the project's from",
    },
    include: {
      type: "string",
      description: "Relax a default exclusion: quality=proposed or type=<asset-type> (repeatable)",
    },
    filter: scopeFilterArg,
    prefer: scopePreferArg,
    ...PROJECT_ARG,
    "include-proposed": {
      type: "boolean",
      description: 'Include entries with quality:"proposed"',
      default: false,
    },
    belief: { ...beliefArg, default: "current" },
    since: {
      type: "string",
      description: "Only local assets dated on or after this day (YYYY-MM-DD)",
    },
    until: {
      type: "string",
      description: "Only local assets dated on or before this day (YYYY-MM-DD)",
    },
    "include-sessions": {
      type: "boolean",
      description: "Include session assets",
      default: false,
    },
    "by-usage": {
      type: "boolean",
      description:
        "List the assets shown in the project (any project with --project none), most shown first, instead of searching; the query is ignored and no usage is recorded",
      default: false,
    },
  },
  async run({ args }) {
    const query = (args.query ?? "").trim();
    const type = args.type as string | undefined;
    const limit = parsePositiveIntFlag(args.limit ?? undefined);
    // Repeatable; citty exposes only the last `--filter` value, so read all
    // occurrences directly from argv (same pattern as `--tag`).
    const filterTokens = parseAllFlagValues("--filter");
    const project = resolveProject(loadConfig(), { project: getStringArg(args, "project") });
    const { source, filters, prefer, include, view } = withProjectDefaults(project, {
      source: fromValues(args.from),
      include: parseIncludeFlags(cliIncludeTokens()),
      filters: parseScopeFilterFlags(filterTokens, "--filter"),
      prefer: parseScopeFilterFlags(parseAllFlagValues("--prefer"), "--prefer"),
    });
    const includeProposed = args["include-proposed"] === true;
    const belief = parseBeliefFilterMode(typeof args.belief === "string" ? args.belief : undefined);
    const includeSessions = args["include-sessions"];
    const since = parseDayFlag(args.since, "--since");
    const until = parseDayFlag(args.until, "--until");
    const outputMode = getOutputMode();
    const result = await akmSearch({
      query,
      type,
      limit,
      source,
      filters,
      prefer,
      since,
      until,
      includeProposed,
      include,
      belief,
      includeSessions,
      eventSource: resolveUsageEventSource(),
      attributionProjection: outputMode.shape === "agent" ? "agent" : outputMode.detail,
      project: projectContext(project, filters),
      byUsage: args["by-usage"] === true,
    });
    output("search", view ? { ...result, project: view } : result);
  },
});

/** The value a project's writes carry as `project`: what its rules and usage are matched against. */
function stampedProject(project: ResolvedProject | undefined): string | undefined {
  const value = project?.write.metadata.project;
  return value === undefined ? undefined : String(value);
}

/** The project a search or curate runs under; a `project` filter in force has already decided eligibility. */
function projectContext(project: ResolvedProject | undefined, filters: ScopeFilters | undefined): ProjectContext {
  return {
    name: stampedProject(project),
    ...(filters && Object.hasOwn(filters, "project") ? { byFilter: true } : {}),
  };
}

/**
 * The read defaults a call runs with: each kind the caller gave replaces the
 * project's value for that kind, and a kind neither gave stays at today's default.
 * `view` is the project as applied: the same effective values, for the response to report.
 */
function withProjectDefaults(
  project: ResolvedProject | undefined,
  explicit: { source?: string | string[]; filters?: ScopeFilters; prefer?: ScopeFilters; include?: IncludeSelectors },
) {
  const include = explicit.include ?? project?.include;
  const from = explicit.source ?? project?.from;
  const filters = explicit.filters ?? project?.filters;
  const prefer = explicit.prefer ?? project?.prefer;
  return {
    source: parseSearchSource(from),
    include,
    filters,
    prefer,
    view: project && projectView({ ...project, from, filters, include, prefer: prefer ?? project.prefer }),
  };
}

/** `--from` is repeatable; citty keeps only the last value, so read every occurrence from argv. */
function fromValues(parsed: unknown): string | string[] | undefined {
  const all = parseAllFlagValues("--from");
  return all.length > 1 ? all : (parsed as string | undefined);
}

function parseDayFlag(raw: unknown, flag: string): string | undefined {
  if (raw === undefined) return undefined;
  const day = typeof raw === "string" ? isoDay(raw) : undefined;
  if (day) return day;
  throw new UsageError(
    `Invalid value for ${flag}: ${String(raw)}. Expected a date as YYYY-MM-DD.`,
    "INVALID_FLAG_VALUE",
  );
}

export const curateCommand = defineJsonCommand({
  meta: {
    name: "curate",
    description:
      "Pick the assets worth loading for a task. Unlike `akm search`, this attaches a preview and run details per hit, adds related support refs, and summarizes the set — the usual starting point for an agent. `--pack <tokens>` returns the hits' content as one token-budgeted bundle.",
  },
  args: {
    // Optional in citty so run() is invoked when omitted; we re-validate
    // below to surface a structured UsageError (exit 2) instead of citty's
    // default help-banner exit-0.
    query: { type: "positional", description: "Task or prompt to curate assets for", required: false },
    type: {
      type: "string",
      description: "Asset type, exact match (e.g. skill, memory, knowledge, workflow); default: any",
    },
    limit: { type: "string", description: "Maximum number of curated results", default: "4" },
    from: {
      type: "string",
      description: "local|registry|all or a bundle name (repeatable). Default: local, or the project's from",
    },
    include: {
      type: "string",
      description: "Relax a default exclusion: quality=proposed or type=<asset-type> (repeatable)",
    },
    filter: scopeFilterArg,
    prefer: scopePreferArg,
    ...PROJECT_ARG,
    belief: { ...beliefArg, default: "current" },
    "max-tokens": {
      type: "string",
      description: "Pack full content within this shared token budget (alias for --pack)",
    },
    pack: {
      type: "string",
      description:
        "Pack the hits' full content into one blob within this token budget, e.g. --pack 4000 (registry hits are never packed)",
    },
  },
  async run({ args }) {
    const legacyBudget = parsePositiveIntFlag(args.pack ?? undefined, "--pack");
    const maxTokens = parsePositiveIntFlag(args["max-tokens"], "--max-tokens");
    if (legacyBudget !== undefined && maxTokens !== undefined && legacyBudget !== maxTokens) {
      throw new UsageError("--max-tokens and --pack specify conflicting budgets.", "INVALID_FLAG_VALUE");
    }
    const packBudget = maxTokens ?? legacyBudget;
    const outputMode = getOutputMode();
    const curated = await runCurate(
      {
        query: args.query,
        type: args.type as string | undefined,
        limit: args.limit,
        from: fromValues(args.from),
        filters: parseAllFlagValues("--filter"),
        include: cliIncludeTokens(),
        prefer: parseAllFlagValues("--prefer"),
        belief: args.belief,
        project: getStringArg(args, "project"),
      },
      outputMode,
    );
    if (packBudget !== undefined) {
      const packed = await packCuratedHits(curated, packBudget);
      if (outputMode.format === "text" || outputMode.format === "md") {
        deliverRendered(withProjectLine(formatCuratePackText(packed), curated.project), outputMode.outputPath);
      } else {
        output("curate-pack", packed.items);
      }
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
  args: {
    query?: string;
    type?: string;
    limit?: string;
    from?: string | string[];
    filters?: string[];
    include?: string[];
    prefer?: string[];
    belief?: string;
    /** In-process callers (an agent's tool) name the run's source; the CLI reads `AKM_EVENT_SOURCE`. */
    eventSource?: UsageEventSource;
    /** The project to use (`--project`); absent: the one `cwd` selects. */
    project?: string;
    /** The working directory that selects a project; default: the process's. */
    cwd?: string;
  },
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
  const project = resolveProject(loadConfig(), { project: args.project, cwd: args.cwd });
  const { source, filters, prefer, include, view } = withProjectDefaults(project, {
    source: args.from,
    include: parseIncludeFlags(args.include),
    filters: parseScopeFilterFlags(args.filters ?? [], "--filter"),
    prefer: parseScopeFilterFlags(args.prefer ?? [], "--prefer"),
  });
  const curated = await akmCurate({
    query: args.query,
    type: args.type,
    limit: limitParsed && limitParsed > 0 ? limitParsed : 4,
    source,
    filters,
    prefer,
    include,
    belief: parseBeliefFilterMode(args.belief ?? "current"),
    eventSource: args.eventSource ?? resolveUsageEventSource(),
    attributionProjection: outputMode.shape === "agent" ? "agent" : outputMode.detail,
    project: projectContext(project, filters),
  });
  return view ? { ...curated, project: view } : curated;
}

/** Human-readable rendering for `akm curate --pack`: concatenated content per hit under a `## <ref>` header. */
function formatCuratePackText(packed: CuratePackResult): string {
  if (packed.items.length === 0) {
    return `No packed content for "${packed.query}" (budget ${packed.budget} tokens).`;
  }
  return packed.items
    .map((item) => `## ${item.ref}\n\n${item.reason ? `${item.reason}\n\n` : ""}${item.content}`)
    .join("\n\n");
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
    `Run \`akm show ${ref} --detail brief\` for the document's outline (\`toc\`, no body).`,
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
        "Asset ref [bundle//]conceptId[#fragment]; `--outline` returns the outline (`toc`, each heading's slug)",
      required: true,
    },
    outline: {
      type: "boolean",
      description: "Show the outline and brief metadata without the body (alias for --detail brief)",
    },
    lead: {
      type: "boolean",
      description: "Add the document lead to a Markdown fragment (alias for --context lead)",
    },
    context: {
      type: "string",
      description: "Fragment presentation: exact (default) or lead (adds the document lead)",
    },
    "max-tokens": {
      type: "string",
      description: "Body budget estimated at four characters per token (not with --max-chars)",
    },
    "max-chars": {
      type: "string",
      description: "Context budget in characters (needs --context lead; not with --max-tokens)",
    },
    project: {
      type: "string",
      description:
        "Project to record on this read's usage event instead of the one the working directory selects (`none`: no project); changes nothing else",
    },
  },
  async run({ args }) {
    // `[origin//]meta[:name]` targets the stash `.meta/` convention, which is
    // not a typed asset ref — skip ref validation and let akmShowUnified
    // direct-read it. (the ref parser would reject the non-type `meta`.)
    if (args.outline && parseMetaRef(args.ref)) {
      throw new UsageError(
        "--outline is unavailable for direct .meta reads; omit --outline to read the document.",
        "INVALID_FLAG_VALUE",
      );
    }
    if (!parseMetaRef(args.ref)) parseBundleRef(args.ref);
    rejectExtraShowPositionals(args._, args.ref);
    const invocation = getParsedInvocation();
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
    // `--detail brief` forces the brief response regardless of projection.
    const showDetail: ShowDetailLevel | undefined =
      args.outline || explicitDetail === "brief" ? "brief" : explicitDetail === "full" ? "full" : undefined;
    const explicitContext = typeof args.context === "string" ? parseFragmentContextMode(args.context) : undefined;
    if (args.lead && explicitContext === "exact") {
      throw new UsageError("--lead conflicts with --context exact.", "INVALID_FLAG_VALUE");
    }
    const contextMode = args.lead ? "lead" : (explicitContext ?? "exact");
    const maxTokens = parsePositiveIntFlag(args["max-tokens"] ?? undefined, "--max-tokens");
    const maxChars = parsePositiveIntFlag(args["max-chars"] ?? undefined, "--max-chars");
    if (maxTokens !== undefined && maxChars !== undefined) {
      throw new UsageError("--max-tokens and --max-chars are mutually exclusive.", "INVALID_FLAG_VALUE");
    }
    if (args.outline && explicitDetail !== undefined && explicitDetail !== "brief") {
      throw new UsageError("--outline conflicts with --detail normal, full or agent.", "INVALID_FLAG_VALUE");
    }
    if (args.outline && (contextMode === "lead" || maxTokens !== undefined || maxChars !== undefined)) {
      throw new UsageError("--outline cannot be combined with lead context or a content budget.", "INVALID_FLAG_VALUE");
    }
    // `--detail brief --context lead [--max-chars|--max-tokens]` worked in 0.10.261118 and still does; only the
    // new forms are refused: `--lead`, or a `--max-tokens` body budget without lead context.
    if (explicitDetail === "brief" && (args.lead || (maxTokens !== undefined && contextMode === "exact"))) {
      throw new UsageError(
        "A content budget or --lead requires body output; omit --detail brief.",
        "INVALID_FLAG_VALUE",
      );
    }
    const result = await akmShowUnified({
      ref: args.ref,
      detail: showDetail,
      contextMode,
      ...(args.lead ? { contextFlag: "--lead" as const } : {}),
      maxContextChars: maxChars,
      maxTokens,
      eventSource: resolveUsageEventSource(),
      project: stampedProject(resolveProject(loadConfig(), { project: getStringArg(args, "project") })),
    });
    output("show", result);
  },
});

export function parseFragmentContextMode(raw: string | undefined): FragmentContextMode {
  const normalized = raw?.trim().toLowerCase() || "exact";
  if (normalized === "exact" || normalized === "lead") return normalized;
  throw new UsageError(`Invalid --context value: "${raw}". Expected exact or lead.`, "INVALID_FLAG_VALUE");
}

/** CLI absence inherits the project; an explicitly empty API list overrides it. */
function cliIncludeTokens(): string[] | undefined {
  const tokens = parseAllFlagValues("--include");
  return tokens.length ? tokens : undefined;
}

function parseIncludeFlags(tokens: string[] | undefined): IncludeSelectors | undefined {
  if (tokens === undefined) return undefined;
  return normalizeInclude(parseScopeFilterFlags(tokens, "--include") ?? {});
}
