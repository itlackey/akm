// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { getStringArg, PROJECT_ARG } from "../../cli/parse-args";
import { defineJsonCommand, output, parseAllFlagValues } from "../../cli/shared";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { appendEvent } from "../../core/events";
import { resolveProject } from "../../core/projects";
import { resolveUsageEventSource, type UsageEventSource } from "../../indexer/usage/usage-events";
import type { SourceSearchHit } from "../../sources/types";
import {
  buildMemoryFrontmatter,
  parseDuration,
  readMemoryContent,
  runAutoHeuristics,
  runLlmEnrich,
  synthesizeMemoryDescription,
} from "../remember";
import {
  assertFlatAssetName,
  inferAssetName,
  resolveSupersedesForWrite,
  resolveSupersedesWriteTarget,
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
      attributionProjection: "ref",
    });
    return (result.results ?? [])
      .filter((h): h is SourceSearchHit => "ref" in h && (h as { ref: string }).ref !== excludeRef)
      .slice(0, 3)
      .map((h) => ({ ref: h.ref, ...(h.name ? { title: h.name } : {}) }));
  } catch {
    return [];
  }
}

/** The flag `remember` takes for its destination, as its errors spell it. */
const TARGET_FLAG = "--bundle";

// ── Command definition ────────────────────────────────────────────────────────

export const rememberCommand = defineJsonCommand({
  meta: {
    name: "remember",
    description: "Record a memory in the default bundle",
  },
  args: {
    content: {
      type: "positional",
      description: "Memory content. Omit to read markdown from stdin.",
      required: false,
    },
    name: {
      type: "string",
      description: "Memory name (flat; default: slug of the content)",
    },
    path: {
      type: "string",
      description: "Subdirectory under memories/ (e.g. 'personal/projects')",
    },
    force: {
      type: "boolean",
      description: "Overwrite an existing memory with the same name",
      default: false,
    },
    description: {
      type: "string",
      description: "Short description for frontmatter",
    },
    tag: {
      type: "string",
      description: "Tag to add to the memory (repeatable: --tag foo --tag bar)",
    },
    expires: {
      type: "string",
      description: "Expiry, e.g. 30d, 12h, 5m (minutes), 3M (months)",
    },
    source: {
      type: "string",
      description: "Source (URL, asset ref, file path or text)",
    },
    xref: {
      type: "string",
      description: "Asset ref to cross-reference in `xrefs:` (repeatable); it must resolve",
    },
    supersedes: {
      type: "string",
      description: "Ref of an asset this memory corrects (repeatable); the old asset is marked superseded",
    },
    auto: {
      type: "boolean",
      description: "Tag heuristically from the body",
      default: false,
    },
    enrich: {
      type: "boolean",
      description: "Propose tags and description with the configured LLM",
      default: false,
    },
    bundle: {
      type: "string",
      description: "Write destination: a source name (default: project write.bundle, then defaultBundle)",
    },
    ...PROJECT_ARG,
    user: {
      type: "string",
      description: "Scope to a user id",
    },
    agent: {
      type: "string",
      description: "Scope to an agent id",
    },
    run: {
      type: "string",
      description: "Scope to a run id",
    },
    channel: {
      type: "string",
      description: "Scope to a channel name",
    },
    "show-similar": {
      type: "boolean",
      // Canonical spelling is kebab-case. citty also accepts the camelCase
      // `--showSimilar` for any declared flag, so no alias is declared: an
      // alias is advertised in --help with ONE dash (`-showSimilar`), which
      // parseArgs reads as bundled short flags and is rejected.
      description: "Return the top 3 similar memories",
    },
  },
  async run({ args }) {
    // A body that starts with its own frontmatter block: that block's keys merge under akm's.
    const { data: bodyFrontmatter, content: body } = parseFrontmatter(readMemoryContent(args.content));
    // The project's write defaults: its metadata sits under the body's own keys, which win.
    const project = resolveProject(loadConfig(), { project: getStringArg(args, "project") });
    const leading = project ? { ...project.write.metadata, ...bodyFrontmatter } : bodyFrontmatter;
    // Its description fills in for a missing --description, ahead of a derived one.
    const leadingDescription =
      typeof bodyFrontmatter.description === "string" && bodyFrontmatter.description.trim()
        ? bodyFrontmatter.description
        : undefined;
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
    const rawSupersedes = parseAllFlagValues("--supersedes");
    // The project's bundle is only a default: a `--bundle` or a `--supersedes` ref decides first.
    const writeTarget = resolveSupersedesWriteTarget(rawSupersedes, args.bundle, TARGET_FLAG) ?? project?.write.bundle;
    const xrefs = resolveXrefsForWrite(parseAllFlagValues("--xref"), writeTarget, TARGET_FLAG);

    // Collect and validate --supersedes occurrences (repeatable). Same
    // before-any-write validation contract: an unresolvable ref exits 2 with
    // nothing written AND nothing demoted (no partial correction). The
    // superseded refs fold into the new memory's xrefs automatically
    // (correction provenance per the back-linking conventions); the demotion
    // itself runs inside writeMarkdownAsset, ordered before the git boundary
    // commit.
    const supersedes = resolveSupersedesForWrite(rawSupersedes, writeTarget, TARGET_FLAG);
    for (const s of supersedes) {
      if (!xrefs.includes(s.ref)) xrefs.push(s.ref);
    }

    // Collect scope flags. Scope alone counts as structured metadata so we
    // emit frontmatter, but it does NOT trigger the "tags required" check —
    // memory + scope (no tags) is a valid combination for multi-tenant use.
    const scopeFields: { user?: string; agent?: string; run?: string; channel?: string } = {};
    for (const k of ["user", "agent", "run", "channel"] as const) {
      const v = getStringArg(args, k) ?? (k === "run" ? undefined : project?.write[k]);
      if (v) scopeFields[k] = v;
    }
    const hasScope = Object.keys(scopeFields).length > 0;

    const hasTagRequiringArgs = rawTags.length > 0 || !!args.expires || !!args.source || !!args.description;
    // --xref counts as structured metadata (it must land in frontmatter) but,
    // like scope, does NOT trigger the tags-required check — provenance
    // without tags is a valid write.
    // --enrich is structured (it must reach the Mode-3 dispatch below, not the
    // zero-flag hot path) but, like --auto, never tag-requiring: enrichment is
    // fail-soft and a zero-tag outcome still writes.
    const hasStructuredArgs = hasTagRequiringArgs || hasScope || args.auto || args.enrich || xrefs.length > 0;

    if (!hasStructuredArgs) {
      // Phase 1B / Rec 7: even the zero-flag hot-path emits
      // `captureMode: hot` + `beliefState: asserted` so user-supplied
      // memories outrank background-derived ones during ranking.
      // #834: `description` is synthesized deterministically (see synthesizeMemoryDescription) so the memory is indexable.
      const frontmatterBlock = buildMemoryFrontmatter({
        description: leadingDescription ?? synthesizeMemoryDescription(body),
        captureMode: "hot",
        beliefState: "asserted",
        leading,
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
        target: writeTarget,
        targetFlag: TARGET_FLAG,
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
    let description: string | undefined = args.description || leadingDescription;
    let source: string | undefined = args.source;
    let observed_at: string | undefined;
    let expires: string | undefined;
    let subjective: boolean | undefined;
    let executionNotices: Awaited<ReturnType<typeof runLlmEnrich>>["notices"];

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
      executionNotices = enriched.notices;
    }

    // #834: no --description and no --enrich-derived one — synthesize deterministically (see zero-flag path above).
    if (!description) description = synthesizeMemoryDescription(body);

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
      leading,
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
      target: writeTarget,
      targetFlag: TARGET_FLAG,
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
        ...(executionNotices && executionNotices.length > 0 ? { notices: executionNotices } : {}),
        ...(hasScope ? { scope: scopeFields } : {}),
      },
    });
    if (args.showSimilar) {
      const similar = await fetchSimilarMemories((body ?? args.content ?? "").slice(0, 500), result.ref, eventSource);
      output("remember", {
        ok: true,
        ...result,
        similar,
        ...(executionNotices && executionNotices.length > 0 ? { notices: executionNotices } : {}),
      });
    } else {
      output("remember", {
        ok: true,
        ...result,
        ...(executionNotices && executionNotices.length > 0 ? { notices: executionNotices } : {}),
      });
    }
  },
});
