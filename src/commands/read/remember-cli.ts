// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getStringArg } from "../../cli/parse-args";
import { defineJsonCommand, output, parseAllFlagValues } from "../../cli/shared";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveUsageEventSource, type UsageEventSource } from "../../indexer/usage/usage-events";
import type { SourceSearchHit } from "../../sources/types";
import {
  buildMemoryFrontmatter,
  parseDuration,
  readMemoryContent,
  resolveRememberContentArg,
  runAutoHeuristics,
  runLlmEnrich,
} from "../remember";
import {
  assertFlatAssetName,
  inferAssetName,
  resolveSupersedesForWrite,
  resolveXrefsForWrite,
  writeMarkdownAsset,
} from "./knowledge";
import { akmSearch } from "./search";

// ── Helper: similar memory search ────────────────────────────────────────────

/**
 * Best-effort top-3 similar memory search for `--show-similar`.
 * Scoped to memory: type; excludes the just-written ref.
 */
async function fetchSimilarMemories(
  query: string,
  excludeRef: string,
  eventSource: UsageEventSource,
): Promise<Array<{ ref: string; title?: string }>> {
  try {
    const result = await akmSearch({
      query,
      type: "memory",
      limit: 4,
      eventSource,
      attributionProjection: "brief",
    });
    return (result.hits ?? [])
      .filter((h): h is SourceSearchHit => "ref" in h && (h as { ref: string }).ref !== excludeRef)
      .slice(0, 3)
      .map((h) => ({ ref: h.ref, ...(h.name ? { title: h.name } : {}) }));
  } catch {
    return [];
  }
}

// ── Command definition ────────────────────────────────────────────────────────

export const rememberCommand = defineJsonCommand({
  meta: {
    name: "remember",
    description: "Record a memory in the default stash",
  },
  args: {
    content: {
      type: "positional",
      description: "Memory content. Omit to read markdown from stdin.",
      required: false,
    },
    name: {
      type: "string",
      description: "Memory name (flat, no '/'; defaults to a slug from the content). Use --path for a subdirectory.",
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under memories/ to place the memory in (e.g. 'personal/projects'). The filename still comes from --name or the content slug.",
    },
    force: {
      type: "boolean",
      description: "Overwrite an existing memory with the same name",
      default: false,
    },
    description: {
      type: "string",
      description: "Short description written to frontmatter (persisted as the memory's description field)",
    },
    tag: {
      type: "string",
      description: "Tag to add to the memory (repeatable: --tag foo --tag bar)",
    },
    expires: {
      type: "string",
      description: "Expiry duration shorthand — e.g. 30d, 12h, 5m (minutes), 3M (months). Resolved to an ISO date.",
    },
    source: {
      type: "string",
      description: "Source reference (URL, asset ref, file path, or any free-form string)",
    },
    xref: {
      type: "string",
      description:
        "Cross-reference ref recorded in the memory's `xrefs:` frontmatter (repeatable: --xref knowledge:auth-flow --xref memory:vpn-note). Each ref must resolve in the write target or a configured source; an unresolvable ref aborts the write.",
    },
    supersedes: {
      type: "string",
      description:
        "Ref of an existing asset this memory corrects (repeatable: --supersedes memory:projectA/old-note). Writes the correction with an xref to the old asset AND demotes the old asset (`beliefState: superseded` + `supersededBy`, a metadata-only edit) so ranking prefers the correction and `--belief current` hides the stale version. An unresolvable or self-referencing ref aborts the write; a ref outside the write target and working stash still writes the correction but skips the demotion (reported as applied: false).",
    },
    auto: {
      type: "boolean",
      description: "Apply heuristic tagging (code, subjective, source, observed_at) from the body",
      default: false,
    },
    enrich: {
      type: "boolean",
      description: "Call the configured LLM to propose tags and description (requires LLM config)",
      default: false,
    },
    target: {
      type: "string",
      description:
        "Override the write destination. Accepts a source name from your config; falls back to defaultWriteTarget then the working stash.",
    },
    user: {
      type: "string",
      description: "Scope this memory to a user id (persisted as `scope_user` frontmatter)",
    },
    agent: {
      type: "string",
      description: "Scope this memory to an agent id (persisted as `scope_agent` frontmatter)",
    },
    run: {
      type: "string",
      description: "Scope this memory to a run id (persisted as `scope_run` frontmatter)",
    },
    channel: {
      type: "string",
      description: "Scope this memory to a channel name (persisted as `scope_channel` frontmatter)",
    },
    showSimilar: {
      type: "boolean",
      description: "Return top-3 similar existing memories in output (opt-in)",
    },
  },
  async run({ args }) {
    const body = readMemoryContent(resolveRememberContentArg(args.content));
    const eventSource = resolveUsageEventSource();

    // `--name` is a flat name; subdirectory placement is `--path`'s job.
    assertFlatAssetName(args.name);

    // Determine if the user has requested any structured metadata mode.
    // Collect all --tag occurrences directly from process.argv because citty
    // only exposes the last value for repeated string flags.
    const rawTags = parseAllFlagValues("--tag");

    // Collect and validate --xref occurrences (repeatable, same argv pattern
    // as --tag). Validation happens BEFORE any write: an unresolvable ref is
    // input validation (UsageError → exit 2) and must leave the stash
    // untouched. Refs resolvable only in a configured extra stash source are
    // accepted (cross-stash provenance).
    const xrefs = resolveXrefsForWrite(parseAllFlagValues("--xref"), args.target);

    // Collect and validate --supersedes occurrences (repeatable). Same
    // before-any-write validation contract: an unresolvable ref exits 2 with
    // nothing written AND nothing demoted (no partial correction). The
    // superseded refs fold into the new memory's xrefs automatically
    // (correction provenance per the back-linking conventions); the demotion
    // itself runs inside writeMarkdownAsset, ordered before the git boundary
    // commit.
    const supersedes = resolveSupersedesForWrite(parseAllFlagValues("--supersedes"), args.target);
    for (const s of supersedes) {
      if (!xrefs.includes(s.ref)) xrefs.push(s.ref);
    }

    // Collect scope flags. Scope alone counts as structured metadata so we
    // emit frontmatter, but it does NOT trigger the "tags required" check —
    // memory + scope (no tags) is a valid combination for multi-tenant use.
    const scopeFields: { user?: string; agent?: string; run?: string; channel?: string } = {};
    for (const k of ["user", "agent", "run", "channel"] as const) {
      const v = getStringArg(args, k);
      if (v) scopeFields[k] = v;
    }
    const hasScope = Object.keys(scopeFields).length > 0;

    const hasTagRequiringArgs = rawTags.length > 0 || !!args.expires || !!args.source || !!args.description;
    // --xref counts as structured metadata (it must land in frontmatter) but,
    // like scope, does NOT trigger the tags-required check — provenance
    // without tags is a valid write.
    const hasStructuredArgs = hasTagRequiringArgs || hasScope || args.auto || xrefs.length > 0;

    if (!hasStructuredArgs) {
      // Phase 1B / Rec 7: even the zero-flag hot-path emits
      // `captureMode: hot` + `beliefState: asserted` so user-supplied
      // memories outrank background-derived ones during ranking.
      const frontmatterBlock = buildMemoryFrontmatter({
        captureMode: "hot",
        beliefState: "asserted",
      });
      const contentWithFrontmatter = `${frontmatterBlock}\n${body}`;
      // Derive the asset slug from the body (not the frontmatter block);
      // otherwise inferAssetName would key off the leading `---` delimiter.
      const result = await writeMarkdownAsset({
        type: "memory",
        content: contentWithFrontmatter,
        name: args.name,
        fallbackPrefix: "memory",
        preferredName: inferAssetName(body, "memory"),
        force: args.force,
        target: args.target,
        path: args.path,
        supersedes,
      });
      appendEvent({
        eventType: "remember",
        ref: result.ref,
        metadata: { path: result.path, force: args.force === true },
      });
      if (args.showSimilar) {
        const similar = await fetchSimilarMemories(body.slice(0, 500), result.ref, eventSource);
        output("remember", { ok: true, ...result, similar });
      } else {
        output("remember", { ok: true, ...result });
      }
      return;
    }

    // ── Accumulate metadata from all three modes ──────────────────────────

    // Start with CLI args (Mode 1: always)
    const tags = [...rawTags];
    // --description is persisted as-is; LLM enrichment may fill it if absent.
    let description: string | undefined = args.description || undefined;
    let source: string | undefined = args.source;
    let observed_at: string | undefined;
    let expires: string | undefined;
    let subjective: boolean | undefined;

    // Resolve --expires to an ISO date string
    if (args.expires) {
      const durationMs = parseDuration(args.expires);
      const expiresDate = new Date(Date.now() + durationMs);
      expires = expiresDate.toISOString().slice(0, 10);
    }

    // Mode 2: --auto heuristics
    if (args.auto) {
      const auto = runAutoHeuristics(body);
      for (const t of auto.tags) {
        if (!tags.includes(t)) tags.push(t);
      }
      if (!source && auto.source) source = auto.source;
      if (!observed_at && auto.observed_at) observed_at = auto.observed_at;
      if (!subjective && auto.subjective) subjective = auto.subjective;
    }

    // Mode 3: --enrich LLM (fail-soft)
    if (args.enrich) {
      const enriched = await runLlmEnrich(body);
      for (const t of enriched.tags) {
        if (!tags.includes(t)) tags.push(t);
      }
      if (!description && enriched.description) description = enriched.description;
      if (!observed_at && enriched.observed_at) observed_at = enriched.observed_at;
    }

    // ── Required-field check (before any write) ───────────────────────────
    // Tags remain required when the user explicitly asked for tag-bearing
    // metadata (--tag / --enrich / --description / --source / --expires).
    // `--auto` alone is allowed even when its heuristics derive zero tags.
    // Scope-only writes (`akm remember "..." --user u1`) also skip this
    // check — scope is independent metadata and a memory with only scope is
    // valid.
    const missing: string[] = [];
    if (hasTagRequiringArgs && tags.length === 0) missing.push("tags");

    if (missing.length > 0) {
      throw new UsageError(
        `Memory is missing required frontmatter field(s): ${missing.join(", ")}. ` +
          "Provide them via --tag <value>, --auto (heuristics), or --enrich (LLM).",
      );
    }

    // ── Build frontmatter and write ───────────────────────────────────────
    // Phase 1B / Rec 7: the hot-path CLI write always marks the memory as
    // `captureMode: hot` and `beliefState: asserted`. Ranking applies a
    // hot-capture boost so user-supplied memories outrank otherwise-equal
    // background-derived ones.
    const frontmatterBlock = buildMemoryFrontmatter({
      description,
      tags,
      source,
      xrefs,
      observed_at,
      expires,
      subjective,
      captureMode: "hot",
      beliefState: "asserted",
      ...(hasScope ? { scope: scopeFields } : {}),
    });

    const contentWithFrontmatter = `${frontmatterBlock}\n${body}`;

    // Derive the asset slug from the body, exactly like the hot path above:
    // `contentWithFrontmatter` starts with the `---` fence, which
    // inferAssetName would slugify to "" and fall back to a random
    // memory-<epoch>-<rand> name.
    const result = await writeMarkdownAsset({
      type: "memory",
      content: contentWithFrontmatter,
      name: args.name,
      fallbackPrefix: "memory",
      preferredName: inferAssetName(body, "memory"),
      force: args.force,
      target: args.target,
      path: args.path,
      supersedes,
    });
    appendEvent({
      eventType: "remember",
      ref: result.ref,
      metadata: {
        path: result.path,
        force: args.force === true,
        tagCount: tags.length,
        enriched: args.enrich === true,
        auto: args.auto === true,
        ...(hasScope ? { scope: scopeFields } : {}),
      },
    });
    if (args.showSimilar) {
      const similar = await fetchSimilarMemories((body ?? args.content ?? "").slice(0, 500), result.ref, eventSource);
      output("remember", { ok: true, ...result, similar });
    } else {
      output("remember", { ok: true, ...result });
    }
  },
});
