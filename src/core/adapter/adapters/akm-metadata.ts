// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Index-time metadata fold for the `akm` adapter's `recognize` — akm 0.9.0
 * chunk-2, WI-C, implementing spec §2 ("the nine index-time metadata
 * contributors move into recognize") + the workflow contributor.
 *
 * This leaf reproduces the 11 `registerMetadataContributor` sites keyed on the
 * winning RENDERER name (exactly how each contributor's `appliesTo({ rendererName })`
 * selects):
 *
 *   - `output/renderers.ts` (9): toc-metadata (knowledge-md),
 *     lesson-frontmatter-metadata, memory-frontmatter-metadata,
 *     script-comment-metadata, env-file-metadata, secret-file-metadata,
 *     task-yaml-metadata, session-md-metadata, fact-md-metadata;
 *   - `workflows/renderer.ts` (1): workflow-document-metadata (the historical
 *     `workflow-md` renderer id now presents both peer workflow sources).
 *
 * ── Cycle-safety (chunk-2 ratchet, baseline 18) ──
 *
 * Imported ONLY by `akm-adapter.ts` (itself imported by nothing in `src/` — see
 * that file's header), so this leaf can never gain an inbound edge from a cycle
 * participant and therefore can never JOIN a cycle. It VALUE-imports the pure
 * parsers each contributor already uses so the fold cannot drift from them:
 * `parseFrontmatter`, `parseMarkdownToc`, the peer-source
 * `compileWorkflowSource` frontend/projection, and env key-name scanning.
 * `output/renderers.ts` / `workflows/renderer.ts` are the
 * cycle-sensitive modules whose contributor bodies live in this port — their
 * ONE non-importable helper (`metadata.ts#extractDescriptionFromComments`, a
 * heavy cycle-participant module) is copied verbatim below as
 * {@link extractDescriptionFromComments} rather than imported. Verified:
 * `bun scripts/lint-import-cycles.ts` stays at 18.
 *
 * ── What is folded, and where it lands on the IndexDocument ──
 *
 * The contributors mutate a `IndexDocument`; {@link foldRecognizedMetadata} returns
 * the same fields as a plain {@link FoldedMetadata}, which `recognize` maps onto
 * `IndexDocument` first-class fields (`tags`/`searchHints`/`description`/
 * `confidence`) and, for the fields without a first-class home
 * (`toc`/`parameters`/`source`), onto `documentJson` (opaque adapter extras).
 * The seed is a MINIMAL entry (name+type only): this isolates exactly what the
 * contributors add, which is what the parity test compares against
 * `applyMetadataContributors` run on the same minimal seed.
 *
 * ── Tolerance note ──
 *
 * Every contributor that reads/parses content is reproduced with the SAME
 * try/catch tolerance it has today (toc/memory/session/fact/task swallow parse
 * errors). Workflow source compilation fails closed in the drain (a broken
 * workflow is dropped); here the compile/projection is wrapped
 * so a broken workflow yields no folded metadata instead of throwing out of the
 * synchronous `recognize` — the drop-the-entry behavior is an index-drain
 * concern (Chunk 4/5), not recognition's. On the valid Chunk-0b fixture this
 * distinction never triggers.
 */

import { scanEnvKeyNames } from "../../../commands/env/env";
import type { IndexDocument } from "../../../indexer/passes/metadata";
import type { FileContext } from "../../../indexer/walk/file-context";
import { parseTaskSource } from "../../../tasks/source/parse-task-source";
import { compileWorkflowSource } from "../../../workflows/source-ir/compile";
import { sourceStepInstructions } from "../../../workflows/source-ir/program";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { TocHeading } from "../../asset/markdown";
import { parseMarkdownToc } from "../../asset/markdown";
import { nonEmptyString } from "./shared";

/** The contributor-produced metadata fields, mirrored from the `IndexDocument` fields the 11 contributors mutate. */
export interface FoldedMetadata {
  tags?: string[];
  searchHints?: string[];
  description?: string;
  confidence?: number;
  source?: string;
  toc?: TocHeading[];
  parameters?: Array<{ name: string; description?: string }>;
}

/**
 * Verbatim copy of `indexer/passes/metadata.ts#extractDescriptionFromComments`
 * (`:1510-1552`) — `metadata.ts` is a heavy cycle-participant module, so the
 * one non-importable helper `applyScriptMetadata` needs is copied here (the
 * others are imported). Reads a leading JSDoc block or hash-comment run from the
 * script file; returns `null` on read/parse miss.
 */
function extractDescriptionFromComments(content: string): string | null {
  const lines = content.split(/\r?\n/).slice(0, 50);

  const blockStart = lines.findIndex((l) => /^\s*\/\*\*/.test(l));
  if (blockStart >= 0) {
    const desc: string[] = [];
    for (let i = blockStart; i < lines.length; i++) {
      const line = lines[i]!;
      if (i > blockStart && /\*\//.test(line)) break;
      const cleaned = line
        .replace(/^\s*\/?\*\*?\s?/, "")
        .replace(/\*\/\s*$/, "")
        .trim();
      if (cleaned) desc.push(cleaned);
    }
    if (desc.length > 0) return desc.join(" ");
  }

  let start = 0;
  if (lines[0]?.startsWith("#!")) start = 1;
  const hashLines: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith("#") && !line.startsWith("#!")) {
      hashLines.push(line.replace(/^#+\s*/, "").trim());
    } else if (line === "") {
    } else {
      break;
    }
  }
  if (hashLines.length > 0) return hashLines.join(" ");

  return null;
}

/**
 * Reproduce `applyFrontmatterDescriptionAndTags` (`output/renderers.ts:668-684`):
 * set description/source/confidence from frontmatter (only when not already set)
 * and merge frontmatter `tags:` onto the folded tags. Returns nothing — mutates
 * `out`.
 */
function applyFrontmatterDescriptionAndTags(fm: Record<string, unknown>, out: FoldedMetadata): void {
  const desc = nonEmptyString(fm.description);
  if (desc && !out.description) {
    out.description = desc;
    out.source = "frontmatter";
    out.confidence = 0.9;
  }
  if (Array.isArray(fm.tags) && fm.tags.length > 0) {
    const fmTags = fm.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (fmTags.length > 0) {
      out.tags = Array.from(new Set([...(out.tags ?? []), ...fmTags]));
    }
  }
}

/** Collect + finalize a searchHints set the way every contributor does (`Array.from(hints).filter(Boolean)`, assigned only when non-empty). */
function finalizeHints(out: FoldedMetadata, hints: Set<string>): void {
  if (hints.size > 0) out.searchHints = Array.from(hints).filter(Boolean);
}

/**
 * The metadata fold, keyed on the winning renderer NAME. Returns the fields the
 * 11 contributors would add to a MINIMAL (name+type) `IndexDocument`. `recognize`
 * maps the result onto the `IndexDocument`. Reads the live file (index-time, so
 * disk reads are legitimate — unlike `validate`).
 */
export function foldRecognizedMetadata(rendererName: string, file: FileContext): FoldedMetadata {
  const out: FoldedMetadata = {};

  switch (rendererName) {
    // ── toc-metadata (knowledge-md) ──
    case "knowledge-md": {
      try {
        const toc = parseMarkdownToc(file.content());
        if (toc.headings.length > 0) out.toc = toc.headings;
      } catch {
        // Non-fatal: skip TOC if file can't be read
      }
      return out;
    }

    // ── lesson-frontmatter-metadata (lesson-md) ──
    case "lesson-md": {
      try {
        const fm = parseFrontmatter(file.content()).data;
        applyFrontmatterDescriptionAndTags(fm, out);
        const whenToUse = nonEmptyString(fm.when_to_use);
        if (whenToUse) finalizeHints(out, new Set([`when_to_use:${whenToUse}`]));
      } catch {
        // Non-fatal: skip metadata extraction on parse error
      }
      return out;
    }

    // ── memory-frontmatter-metadata (memory-md) ──
    case "memory-md": {
      try {
        const fm = parseFrontmatter(file.content()).data;
        applyFrontmatterDescriptionAndTags(fm, out);
        const hints = new Set<string>();
        // fix-ranking-derived-outranks-primary: `source:` on an ordinary
        // memory is an author-written citation worth indexing as a hint, but
        // on an inferred (`.derived`) twin it is ALWAYS the machine-written
        // provenance backref `memory-inference.ts` writes (`memories/<parent>`
        // — see its `FM_SOURCE`), already captured properly as
        // `entry.derivedFrom` (metadata.ts). Folding that backref into
        // searchHints too means the base memory's own name — almost always a
        // query token whenever the base is relevant — auto-credits the twin
        // via `search-hint-ranking`'s substring match, independent of whether
        // the twin's own content actually matches the query.
        const source = fm.inferred === true ? undefined : nonEmptyString(fm.source);
        if (source) hints.add(source);
        const fmObservedAt = nonEmptyString(fm.observed_at);
        if (fmObservedAt) {
          hints.add(`observed_at:${fmObservedAt}`);
        } else {
          try {
            const isoDate = file.stat().mtime.toISOString().slice(0, 10);
            hints.add(`observed_at:${isoDate}`);
          } catch {
            // Non-fatal: skip mtime fallback on stat error
          }
        }
        const expires = nonEmptyString(fm.expires);
        if (expires) hints.add(`expires:${expires}`);
        if (fm.subjective === true) hints.add("subjective");
        finalizeHints(out, hints);
      } catch {
        // Non-fatal: skip metadata extraction on error
      }
      return out;
    }

    // ── script-comment-metadata (script-source) ──
    case "script-source": {
      if (file.ext === ".md") return out;
      const commentDesc = extractDescriptionFromComments(file.content());
      if (commentDesc && !out.description) {
        out.description = commentDesc;
        out.source = "comments";
        out.confidence = 0.7;
      }
      return out;
    }

    // ── env-file-metadata (env-file) ──
    case "env-file": {
      const keys = scanEnvKeyNames(file.content());
      if (keys.length > 0) out.searchHints = keys;
      out.tags = Array.from(new Set([...(out.tags ?? []), "env", "secrets"]));
      return out;
    }

    // ── secret-file-metadata (secret-file) — tags only, NEVER reads the body ──
    case "secret-file": {
      out.tags = Array.from(new Set([...(out.tags ?? []), "secret", "sensitive"]));
      return out;
    }

    // ── task-yaml-metadata (task-yaml) ──
    case "task-yaml": {
      out.tags = Array.from(new Set([...(out.tags ?? []), "task", "scheduled"]));
      try {
        const parsed = parseTaskSource({ yaml: file.content(), filePath: file.absPath, workspaceRoot: file.stashRoot });
        const v4 = parsed.v4;
        const target = v4.target;
        const hints = new Set<string>();
        for (const binding of v4.schedule) hints.add(`schedule:${binding.cron}`);
        if (target.kind === "uses") {
          if (target.uses.kind === "workflow") hints.add(`workflow:${target.uses.ref}`);
          else if (target.uses.kind === "command") hints.add(`prompt:${target.uses.ref}`);
          else if (target.command?.kind === "inline") hints.add(`prompt:${target.command.content}`);
          else if (target.command?.kind === "stored") hints.add(`prompt:${target.command.ref}`);
          else hints.add(`uses:${target.uses.ref}`);
        } else {
          hints.add(`run:${target.run}`);
        }
        if (v4.description && !out.description) {
          out.description = v4.description;
          out.source = "task-source";
          out.confidence = 0.9;
        }
        if (v4.tags && v4.tags.length > 0) {
          out.tags = Array.from(new Set([...(out.tags ?? []), ...v4.tags]));
        }
        if (v4.when_to_use) hints.add(`when_to_use:${v4.when_to_use}`);
        finalizeHints(out, hints);
      } catch {
        // Non-fatal: skip metadata extraction on parse error
      }
      return out;
    }

    // ── session-md-metadata (session-md) ──
    case "session-md": {
      try {
        const fm = parseFrontmatter(file.content()).data;
        applyFrontmatterDescriptionAndTags(fm, out);
        out.tags = Array.from(new Set([...(out.tags ?? []), "session"]));
        const hints = new Set<string>();
        const harness = nonEmptyString(fm.harness);
        if (harness) hints.add(`harness:${harness}`);
        const project = nonEmptyString(fm.project);
        if (project) hints.add(`project:${project}`);
        const logPath = nonEmptyString(fm.log_path);
        if (logPath) hints.add(`log_path:${logPath}`);
        finalizeHints(out, hints);
      } catch {
        // Non-fatal: skip metadata extraction on parse error
      }
      return out;
    }

    // ── fact-md-metadata (fact-md) ──
    case "fact-md": {
      try {
        const fm = parseFrontmatter(file.content()).data;
        applyFrontmatterDescriptionAndTags(fm, out);
        const tags = new Set<string>([...(out.tags ?? []), "fact"]);
        const hints = new Set<string>();
        const category = nonEmptyString(fm.category);
        if (category) {
          tags.add(category);
          hints.add(`category:${category}`);
        }
        if (fm.pinned === true) {
          tags.add("pinned");
          hints.add("pinned");
        }
        out.tags = Array.from(tags).filter(Boolean);
        finalizeHints(out, hints);
      } catch {
        // Non-fatal: skip metadata extraction on parse error
      }
      return out;
    }

    // ── workflow-document-metadata (historical renderer id `workflow-md`, peer sources) ──
    case "workflow-md": {
      try {
        const result = compileWorkflowSource(file.content(), { path: file.relPath, workspaceRoot: file.stashRoot });
        if (!result.ok) return out;
        const sourceIr = result.ir;
        const hints = new Set<string>();
        if (sourceIr.preamble) hints.add(sourceIr.preamble);
        for (const step of sourceIr.jobs.flatMap((job) => job.steps)) {
          hints.add(step.id);
          hints.add(sourceStepInstructions(step));
          if (step.gate?.rubric) hints.add(step.gate.rubric);
        }
        out.searchHints = Array.from(hints).filter(Boolean);
        if (sourceIr.params) {
          const parameters = Object.entries(sourceIr.params).map(([name, schema]) => {
            const description = schema.description;
            return { name, ...(typeof description === "string" && description ? { description } : {}) };
          });
          if (parameters.length) out.parameters = parameters;
        }
      } catch {
        // See file header: broken workflows drop at drain time, not here.
      }
      return out;
    }

    default:
      // No contributor applies to this renderer (e.g. skill-md/command-md/
      // agent-md — the static-only mappings carry no metadata contributor).
      return out;
  }
}

/**
 * Apply {@link foldRecognizedMetadata}'s output onto a `IndexDocument` with the
 * SAME precedence the live in-place renderer contributors use (Chunk 5 M-b), so
 * `entry.applyPreContributorFields → applyFoldedMetadata → applyPostContributorFields`
 * reproduces `buildEntryFromFile`'s `P1/P2 → contributors → P4` byte-for-byte.
 *
 * Precedence, verified against every case in {@link foldRecognizedMetadata}:
 *  - description/source/confidence travel together and only when the entry has
 *    no description yet (contributors gate on `!entry.description`); a
 *    contributor that sets description WITHOUT source/confidence leaves those
 *    untouched — mirrored by the
 *    `folded.source`/`folded.confidence` guards below;
 *  - tags UNION into the existing set (order-preserving Set dedup), matching the
 *    contributors' `Array.from(new Set([...entry.tags, ...added]))`;
 *  - searchHints / toc / parameters are SET (overwrite), matching the
 *    contributors' direct assignment.
 *
 * The fold computes each field unconditionally from an empty seed; re-gating on
 * `entry` state here is what recovers the in-place precedence (the fold ≡
 * contributors-on-a-minimal-seed is pinned by the akm-adapter fold-parity test).
 */
export function applyFoldedMetadata(entry: IndexDocument, folded: FoldedMetadata): void {
  if (folded.description && !entry.description) {
    entry.description = folded.description;
    if (folded.source) entry.source = folded.source as IndexDocument["source"];
    if (folded.confidence !== undefined) entry.confidence = folded.confidence;
  }
  if (folded.tags && folded.tags.length > 0) {
    entry.tags = Array.from(new Set([...(entry.tags ?? []), ...folded.tags]));
  }
  // searchHints MERGE (not overwrite): every live contributor seeds its hints
  // from `new Set(entry.searchHints ?? [])` before adding, so a frontmatter
  // `searchHints:` set by P2 (applyCuratedFrontmatter) survives and the
  // contributor's hints append to it. The fold computes only the contributor's
  // additions (from an empty seed), so unioning them onto the existing set —
  // existing first, deduped, truthy-filtered — reproduces the live merge exactly.
  if (folded.searchHints) {
    entry.searchHints = Array.from(new Set([...(entry.searchHints ?? []), ...folded.searchHints])).filter(Boolean);
  }
  if (folded.toc) entry.toc = folded.toc;
  if (folded.parameters) entry.parameters = folded.parameters;
}
