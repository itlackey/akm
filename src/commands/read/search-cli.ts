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
import { getOutputMode } from "../../output/context";
import { deliverRendered } from "../../output/html-render";
import type { FragmentContextMode, ShowDetailLevel } from "../../sources/types";
import { akmCurate, type CuratePackResult, packCuratedHits } from "./curate";
import { akmSearch, parseBeliefFilterMode, parseScopeFilterFlags, parseSearchSource } from "./search";
import { akmShowUnified } from "./show";

/**
 * `--source` was renamed to `--from` on `search`/`curate` in 0.9 (S8). citty
 * is non-strict, so the retired spelling is silently absorbed rather than
 * rejected — the command then runs against the DEFAULT `--from` value
 * (local) instead of the source the caller named, with exit 0 and no error.
 * Reject it explicitly instead.
 *
 * Exported so `akm task list` (`../tasks/tasks-cli.ts`, #951) — a pure
 * delegating alias for `akm search --type task` — applies the identical
 * guard rather than a second copy of it; a task-list-scoped `--source` must
 * fail exactly like `search`'s does, not fall through to citty's silent
 * unknown-flag absorption.
 */
export function rejectRetiredSourceFlag(): void {
  if (!getParsedInvocation().hasFlag("--source")) return;
  throw new UsageError(
    "`--source` was renamed to `--from` in 0.9. Use `--from local|registry|all` instead.",
    "INVALID_FLAG_VALUE",
  );
}

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
    // Declared as the POSITIVE name with `default: true` so citty's native
    // `--no-<name>` negation (it strips a leading `--no-` from ANY token and
    // negates the remainder BEFORE consulting the declared-args table — see
    // node_modules/citty/dist/index.mjs) does the work, the same pattern
    // `sync --push/--no-push` uses. A flag DECLARED as `no-project-context`
    // can never be negated: `--no-project-context` parses as "negate
    // `project-context`", a name nothing declared, leaving the real key at
    // its default `false` forever (F1/A1).
    "project-context": {
      type: "boolean",
      default: true,
      description:
        "Automatic project-context ranking boost: assets whose name/tags/aliases match the current working " +
        "directory's project get a small score boost, and this search's usage also feeds the scoped-utility " +
        "ranking signal. Default: on. Use --no-project-context to disable BOTH the project-context boost and " +
        "the scoped-utility signal for this search only.",
    },
    "include-sessions": {
      type: "boolean",
      description:
        "Include session assets (excluded from default search results via config.search.defaultExcludeTypes).",
      default: false,
    },
    // Declared as the POSITIVE name with `default: true` for the same reason
    // as `project-context` above — never declare a flag whose NAME starts
    // with `no-`.
    "track-usage": {
      type: "boolean",
      default: true,
      description:
        "A successful search updates ranking signals (usage-events telemetry and the MemRL utility-score bump " +
        "used to prioritize future results). Default: on. Use --no-track-usage to run a read-only search that " +
        "does not influence future ranking.",
    },
  },
  async run({ args }) {
    rejectRetiredSourceFlag();
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
    const disableProjectContext = args["project-context"] === false;
    const skipLogging = args["track-usage"] === false;
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
      disableProjectContext,
      disableScopedUtility: disableProjectContext,
      skipLogging,
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
    // Declared as the POSITIVE name with `default: true` — see the
    // `project-context` comment on `searchCommand` above for why a flag NAME
    // must never start with `no-`.
    "track-usage": {
      type: "boolean",
      default: true,
      description:
        "A successful curate updates ranking signals (usage-events telemetry for the curated items and the " +
        "underlying search). Default: on. Use --no-track-usage to run a read-only curate that does not " +
        "influence future ranking.",
    },
  },
  async run({ args }) {
    rejectRetiredSourceFlag();
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
    const source = parseSearchSource(args.from ?? "local");
    const skipLogging = args["track-usage"] === false;
    const outputMode = getOutputMode();
    const packBudget = parsePositiveIntFlag(args.pack ?? undefined, "--pack");
    const curated = await akmCurate({
      query: args.query,
      type,
      limit,
      source,
      skipLogging,
      eventSource: resolveUsageEventSource(),
      attributionProjection: outputMode.shape === "agent" ? "agent" : outputMode.detail,
    });
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

/** Human-readable rendering for `akm curate --pack`: concatenated content per hit under a `## <ref>` header. */
function formatCuratePackText(packed: CuratePackResult): string {
  if (packed.items.length === 0) {
    return `No packed content for "${packed.query}" (budget ${packed.budget} tokens).`;
  }
  return packed.items.map((item) => `## ${item.ref}\n\n${item.content}`).join("\n\n");
}

/**
 * Reject `--scope` (either spelling) on `akm show` (E-3). `--scope` was
 * removed in favor of `--filter` (R-047, guardrail 6 — no alias, must keep
 * failing loudly, not silently). It is deliberately NOT a declared flag on
 * this command, which means citty's default behavior for an undeclared flag
 * kicks in — and that default is silent acceptance:
 *
 *   - `--scope=user=nobody` (equals form): citty consumes it as an unknown
 *     flag's own inline value. It never reaches `args._`, so nothing downstream
 *     ever notices — the command runs to completion and exits 0, having
 *     silently ignored the caller's (unsatisfied) scope request. This is the
 *     dangerous case: the caller believes a read was scoped when it was not,
 *     and it directly violates guardrail 6's "removed spelling must fail
 *     loudly, not silently".
 *   - `--scope user=nobody` (space form): citty treats `--scope` as boolean
 *     and pushes `user=nobody` into `args._` as a stray positional, which
 *     incidentally trips `rejectExtraShowPositionals`'s arity check below —
 *     but with the wrong diagnosis (it blames the unrelated retired
 *     `toc|section|lines|frontmatter|full` view-mode grammar).
 *
 * This check runs FIRST, before the positional check, so both spellings are
 * caught by one explicit, correctly-worded error — it does NOT make `--scope`
 * work, it only makes the failure loud and the diagnosis accurate.
 *
 * NOTE (general issue, out of scope here): citty silently accepts ANY
 * undeclared flag on ANY command (e.g. `akm info --totallybogus` exits 0) —
 * this same silent-ignore failure mode applies repo-wide, not just to
 * `--scope` on `show`. Fixing that generally is a separate, wide-blast-radius
 * owner decision (same family as E-2, `akm list --type skill`); this function
 * only closes the `--scope`/`show` instance of it.
 */
function rejectRemovedScopeFlag(ref: string): void {
  const usedScopeFlag = getParsedInvocation().userArgs.some(
    (token) => token === "--scope" || token.startsWith("--scope="),
  );
  if (!usedScopeFlag) return;
  throw new UsageError(
    "akm show has no --scope flag — it was removed in 0.9.0. Use --filter instead: " +
      "--filter user=<id> --filter agent=<id> --filter run=<id> --filter channel=<name>.",
    "INVALID_FLAG_VALUE",
    `\`akm show ${ref} --filter user=<id>\` narrows resolution to assets whose frontmatter scope matches.`,
  );
}

/**
 * Reject any positional after the ref. The
 * `akm show <ref> toc|section "H"|lines A B|frontmatter|full` view grammar was
 * removed in 0.9.0; its keywords used to be rewritten into hidden flags before
 * citty saw argv, so without this guard a stale invocation would silently
 * render the whole item instead of the view the caller asked for.
 *
 * `--scope` is handled separately, and earlier, by {@link rejectRemovedScopeFlag}
 * — by the time this runs, a `--scope`-caused stray positional has already
 * been intercepted with the correct diagnosis, so this function's generic
 * message is reached only by genuine leftover view-grammar tokens.
 */
function rejectExtraShowPositionals(positionals: unknown, ref: string): void {
  const extra = (Array.isArray(positionals) ? (positionals as unknown[]).map(String) : []).slice(1);
  if (extra.length === 0) return;
  throw new UsageError(
    `akm show takes a single ref, but got ${extra.map((token) => `"${token}"`).join(" ")} after "${ref}". ` +
      "The view-mode grammar (toc|section|lines|frontmatter|full) was removed in 0.9.0 — use " +
      `\`akm show ${ref}#<heading-slug>\` to read one section, or \`akm show ${ref}\` for the whole item.`,
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
    // Declared as the POSITIVE name with `default: true` — see the
    // `project-context` comment on `searchCommand` above for why a flag NAME
    // must never start with `no-`.
    "track-usage": {
      type: "boolean",
      default: true,
      description:
        "A successful show updates ranking signals (usage-events telemetry, including the search-selection " +
        "linkage when this show follows a recent search). Default: on. Use --no-track-usage to run a " +
        "read-only show that does not influence future ranking.",
    },
  },
  async run({ args }) {
    // `[origin//]meta[:name]` targets the stash `.meta/` convention, which is
    // not a typed asset ref — skip ref validation and let akmShowUnified
    // direct-read it. (the ref parser would reject the non-type `meta`.)
    if (!parseMetaRef(args.ref)) parseBundleRef(args.ref);
    rejectRemovedScopeFlag(args.ref);
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
    const skipLogging = args["track-usage"] === false;
    const result = await akmShowUnified({
      ref: args.ref,
      detail: showDetail,
      contextMode,
      maxContextChars,
      scope,
      skipLogging,
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
