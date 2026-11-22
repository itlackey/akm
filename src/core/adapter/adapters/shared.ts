// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared helpers for the concrete `BundleAdapter` implementations under
 * `src/core/adapter/adapters/`.
 *
 * ── Base checks ──
 *
 * The base asset checks (unquoted-colon, missing-updated, stale-path, missing-ref,
 * redacted-content) have one implementation, `runBaseChecks`
 * (`src/commands/lint/base-linter.ts`), and one decision on whether a rule applies to a
 * file, `ruleApplies` (`core/asset/lint-text.ts`). {@link createBaseChecker} is an
 * adapter's way in: it hands `runBaseChecks` the file's text and the bundle's scope and
 * returns what it finds. `validate` never writes, so it never asks for a fix.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { runBaseChecks } from "../../../commands/lint/base-linter";
import { lintScope } from "../../../commands/lint/scope";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { RuleScope } from "../../asset/lint-text";
import { toPosix } from "../../common";
import { loadConfig } from "../../config/config";
import type { FileChange } from "../../file-change";
import type { Bundle, Diagnostic, ValidateContext } from "../types";

// ── Small pure helpers, reused across the concrete adapters ──────────────────

/** Content hash feeding `IndexDocument.hash` (incrementality/fingerprints, `types.ts` doc comment). */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Trim a possibly-non-string frontmatter value down to a non-empty string or `undefined` (mirrors `core/common.ts#asNonEmptyString`, duplicated locally to avoid importing a cycle-participant module for a 4-line helper). */
export function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Read a frontmatter `tags:` array down to its non-empty string entries, or `undefined` when there are none (mirrors `output/renderers.ts#readFrontmatterTags`). */
export function readTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0);
  return tags.length > 0 ? tags : undefined;
}

/** Reserved files (case-insensitive) every concrete adapter recognizes but never indexes as a concept. */
export const RESERVED_FILES = new Set(["index.md", "log.md"]);

/** The parsed shape the base checks need: `parseFrontmatter`'s return shape plus the file's text. */
export interface ParsedForValidate {
  raw: string;
  data: Record<string, unknown>;
  content: string;
  frontmatter: string | null;
  /** File line the body starts on. */
  bodyStartLine: number;
}

/** The result of `parseFrontmatter(raw)`, with the text it parsed. */
export function parseForValidate(raw: string): ParsedForValidate {
  const { data, content, frontmatter, bodyStartLine } = parseFrontmatter(raw);
  return { raw, data, content, frontmatter, bodyStartLine };
}

/** What a context with no way to read recorded moves offers. */
const noMoves = (): [] => [];

/** The base checks of one bundle's files. */
export interface BaseChecker {
  /** What `runBaseChecks` reports for one file; `skip` is the rules this adapter leaves out for it, on top of the bundle's `lint.skip`. */
  check(relPath: string, parsed: ParsedForValidate, skip?: readonly string[]): Diagnostic[];
  /** What decides whether a rule applies to the file, for the rules an adapter runs itself (see `ruleApplies`). */
  rulesFor(relPath: string, skip?: readonly string[]): RuleScope;
}

/** The base checks for the files of the bundle at `componentRoot`, among the bundles and with the settings `ctx` names (the settings are read once, here, only when `ctx` carries none). The scope (other bundles, moved refs, stale-path roots, LLM Wikis) is read once. */
export function createBaseChecker(componentRoot: string, ctx: ValidateContext): BaseChecker {
  const scope = lintScope(componentRoot, ctx.config ?? loadConfig(), ctx.sources ?? [], ctx.readMoves ?? noMoves);
  const rulesFor = (relPath: string, skip: readonly string[] = []): RuleScope => ({
    relPath,
    llmWiki: scope.inLlmWiki(relPath),
    skip: [...skip, ...scope.bundleSkip(relPath)],
  });
  return {
    rulesFor,
    check: (relPath, parsed, skip) => {
      const { llmWiki, skip: lintSkip } = rulesFor(relPath, skip);
      return runBaseChecks({
        filePath: path.join(componentRoot, relPath),
        relPath,
        raw: parsed.raw,
        data: parsed.data,
        body: parsed.content,
        frontmatter: parsed.frontmatter,
        bodyStartLine: parsed.bodyStartLine,
        fix: false,
        stashRoot: scope.stashRoot,
        stalePathRoots: scope.stalePathRoots,
        extraStashRoots: scope.extraStashRoots,
        bundleRoots: scope.bundleRoots,
        moves: scope.moves,
        llmWiki,
        lintSkip,
      });
    },
  };
}

/**
 * Shared per-change loop: for every non-delete change with readable content,
 * parse frontmatter and run the base checks. Adapters with extra per-type checks
 * (e.g. `okf`'s missing-type / OKF-link warnings) run their own loop and call
 * {@link createBaseChecker} directly instead.
 */
export async function validateChangesWithBaseChecks(
  c: Bundle,
  changes: FileChange[],
  ctx: ValidateContext,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const { check } = createBaseChecker(c.root, ctx);
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    diagnostics.push(...check(toPosix(change.path), parseForValidate(raw)));
  }
  return diagnostics;
}
