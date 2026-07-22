// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared helpers for the concrete `BundleAdapter` implementations under
 * `src/core/adapter/adapters/` — akm 0.9.0 chunk-2, WI-A (the `okf` adapter).
 *
 * ── Cycle-safety (chunk-2 "cycle-safety watch") ──
 *
 * The base-check logic below is a PORT, not an import, of
 * `src/commands/lint/base-linter.ts`'s `runBaseChecks` (the 4 checks every
 * non-`DefaultLinter` class inherits: unquoted-colon, missing-updated,
 * stale-path, missing-ref). Importing `base-linter.ts` directly would add a
 * new `src/core/adapter` -> `src/commands/lint` edge; `base-linter.ts`
 * itself imports `core/asset/asset-spec.ts` (a baseline cycle participant,
 * `scripts/lint-import-cycles.ts`) and `commands/lint/markdown-insertion.ts`
 * — pulling either into `src/core/adapter/`'s import graph risks adding a
 * 19th cycle participant against the zero-tolerance ratchet (baseline 18).
 * Per the brief's explicit instruction ("copy the pure logic to a leaf ...
 * do NOT use dynamic import to launder"), the pure regex/string logic is
 * duplicated here, adapted to `Diagnostic`/`ValidateContext`. Verified
 * cycle-safe: `bun scripts/lint-import-cycles.ts` stays at 18 with this file
 * present (see the WI-A report).
 *
 * ── What did NOT get ported ──
 *
 * `bundle-adapter.ts`'s own doc comment is explicit that `validate()`
 * "MUST NOT write and MUST NOT read the live filesystem" — reads go through
 * `ValidateContext`, which serves the run snapshot WITH pending changes
 * overlaid. `stale-path`'s legacy check called `fs.existsSync` directly on
 * arbitrary absolute paths found in content; here it goes through
 * `ctx.readFile(candidate)` instead (a `null` result means "does not
 * exist") — the interface-compliant translation of the same check, not a
 * behavior change for any path that genuinely exists or doesn't.
 *
 * The `refs:`-frontmatter-array authoritative-list carve-out (session-
 * checkpoint memories; `base-linter.ts`'s `extractFrontmatterRefs`) is NOT
 * ported here — it is memory/session-specific and no OKF concept uses it. A
 * later memory/note adapter should extend `extractProseRefTokens`'s caller with
 * that carve-out when it ports memory/session.
 *
 * The fence-strip (`stripFencedBlocksSimple` below) is a simplified,
 * same-INTENT reimplementation of `markdown-insertion.ts`'s
 * `findFenceRegions` (which is also table/HTML-region aware, because it
 * additionally powers safe line INSERTION, a concern this module doesn't
 * have) — not byte-identical on every edge case, but sufficient for "don't
 * flag a ref/path inside a ``` example," which is the only thing this
 * module needs the strip for.
 */

import { createHash } from "node:crypto";
import { parseFrontmatter } from "../../asset/frontmatter";
import type { FileChange } from "../../file-change";
import type { BundleComponent, Diagnostic, ValidateContext } from "../types";

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

// ── Base validate checks (port of `BaseLinter.runBaseChecks`) ────────────────

function checkUnquotedColon(frontmatterText: string | null): string | null {
  if (!frontmatterText) return null;
  for (const line of frontmatterText.split(/\r?\n/)) {
    const match = line.match(/^description:\s*(.*)/);
    if (!match) continue;
    const value = match[1]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return null;
    }
    if (value.includes(":")) {
      return `description value contains unquoted colon: ${value}`;
    }
  }
  return null;
}

function checkMissingUpdated(data: Record<string, unknown>, frontmatterText: string | null): boolean {
  return frontmatterText !== null && !("updated" in data);
}

function findStalePathCandidates(body: string): string[] {
  const pathRe = /(?:\/home\/|\/tmp\/|\/var\/|\/root\/|\/opt\/)[^\s"'`)\]>,\n]+/g;
  const out: string[] = [];
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = pathRe.exec(body)) !== null) out.push(match[0]);
  return out;
}

/** See file header: same intent as `markdown-insertion.ts#findFenceRegions`, not byte-identical. */
function stripFencedBlocksSimple(body: string): string {
  const lines = body.split(/\r?\n/);
  let inFence = false;
  const out = lines.map((line) => {
    if (/^\s*```/.test(line)) {
      const wasInFence = inFence;
      inFence = !inFence;
      return wasInFence || inFence ? "" : line;
    }
    return inFence ? "" : line;
  });
  return out.join("\n");
}

// Ref-token grammar — copied from `base-linter.ts`'s `BUNDLE_REF_RE`
// (`core/asset/asset-ref.ts`, spec §11.1 / ref-grammar decision D-R3) as a VALUE,
// not an import (same cycle-avoidance rationale as the file header — the source
// string is duplicated so no new `core/adapter` -> `core/asset` edge is added for
// this scan). Recognizes the 0.9.0 FULLY-QUALIFIED `<bundle>//<concept-id>
// [#fragment]` prose body-ref anchored form ONLY. Per D-R3, a bare short
// conceptId in prose is NOT a ref, so it is never flagged here (it is a ref only
// in the ref-LIST channels — {@link refTokenFromListValue}). The pre-0.9.0
// `<type>:<slug>` colon grammar is gone from every recognition surface.
const BUNDLE_BODY_REF_RE_SRC = "(?:^|[\\s`\"'(,[])([^\\s:.#/`\"'()[\\],<>]+\\/\\/[^\\s\"'`)\\]>,\\n]+)";

/**
 * A conceptId that is a lint false positive rather than a real ref — mirrors the
 * `isNonRefName` guards `base-linter.ts` applies deep in its existence check:
 * template placeholders (`skills/<name>`) and degenerate/incomplete tokens.
 */
function isNonRefConceptId(conceptId: string): boolean {
  const id = conceptId.split("#", 1)[0]!; // drop the export #fragment selector
  if (!id || id.length <= 1 || id === "**") return true;
  if (id.includes("<")) return true; // template placeholder, e.g. `skills/<name>`
  return false;
}

/**
 * Extract the fully-qualified `bundle//conceptId` refs from PROSE — the flipped
 * `base-linter.ts#checkMissingRefs` semantics (`BUNDLE_REF_RE`, qualified-only;
 * bare short conceptIds are NOT refs, D-R3). Fenced code is stripped first so
 * example refs inside ``` are not flagged; shell-substitution (`$(`/`${`) and
 * ACP (`::`) false positives are dropped.
 */
function extractProseRefTokens(text: string): string[] {
  const re = new RegExp(BUNDLE_BODY_REF_RE_SRC, "gm");
  const scanBody = stripFencedBlocksSimple(text);
  const refs: string[] = [];
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = re.exec(scanBody)) !== null) {
    const token = match[1]!;
    if (token.includes("$(") || token.includes("${") || token.includes("::")) continue;
    if (isNonRefConceptId(token.slice(token.indexOf("//") + 2))) continue;
    refs.push(token);
  }
  return refs;
}

/**
 * Recognize a single frontmatter ref-LIST value (`xrefs:`/`supersededBy:`/
 * `contradictedBy:`) as a whole ref — the flipped `base-linter.ts#
 * checkMissingRefsInList` semantics. Unlike prose, a bare short `conceptId` IS a
 * ref here (the value's whole purpose is to name one asset). Returns the ref
 * token, or `null` for a false positive or a legacy `origin//type:name` value
 * (the colon-grammar is retired — D-R3).
 */
function refTokenFromListValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("$(") || trimmed.includes("${") || trimmed.includes("::")) return null;
  const boundary = trimmed.indexOf("//");
  // Qualified `bundle//conceptId`: a colon in the tail marks a legacy/remote
  // `origin//type:name` — not the 0.9.0 grammar — so skip it. Un-prefixed values
  // are a 0.9.0 short conceptId; a colon there is likewise the retired grammar.
  const conceptId = boundary >= 0 ? trimmed.slice(boundary + 2) : trimmed;
  if (conceptId.includes(":") || isNonRefConceptId(conceptId)) return null;
  return trimmed;
}

const XREF_FRONTMATTER_KEYS = ["xrefs", "supersededBy", "contradictedBy"] as const;

function readRefStringOrArray(value: unknown): string[] | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : null;
  }
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  return out.length > 0 ? out : null;
}

/** The parsed shape `runBaseValidateChecks` needs — a subset of `parseFrontmatter`'s return shape (`{data, content, frontmatter}`). */
export interface ParsedForValidate {
  data: Record<string, unknown>;
  content: string;
  frontmatter: string | null;
}

/**
 * Port of `BaseLinter.runBaseChecks`, adapted to the read-only
 * `ValidateContext`/`Diagnostic` shapes (adapter spec §12.1). Reproduces
 * unquoted-colon / missing-updated / stale-path / missing-ref for ONE file's
 * already-parsed content.
 *
 * `fixed` is always `false`: `BundleAdapter.validate` MUST NOT write the
 * filesystem, so there is no fix-apply mechanism at this layer — a documented,
 * intentional behavior narrowing from the legacy `--fix`-capable linter.
 *
 * `componentRoot` is `BundleComponent.root` — used only for the stale-path
 * "portable form" hint (mirrors legacy `ctx.stashRoot`-relative substitution;
 * no I/O).
 */
export async function runBaseValidateChecks(
  relPath: string,
  parsed: ParsedForValidate,
  componentRoot: string,
  ctx: ValidateContext,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const { data, content: body, frontmatter } = parsed;

  const unquotedColonDetail = checkUnquotedColon(frontmatter);
  if (unquotedColonDetail) {
    diagnostics.push({ file: relPath, issue: "unquoted-colon", detail: unquotedColonDetail, fixed: false });
  }

  if (checkMissingUpdated(data, frontmatter)) {
    diagnostics.push({
      file: relPath,
      issue: "missing-updated",
      detail: "no updated field in frontmatter",
      fixed: false,
    });
  }

  const staleCandidates = [
    ...findStalePathCandidates(body),
    ...(frontmatter ? findStalePathCandidates(frontmatter) : []),
  ];
  for (const candidate of staleCandidates) {
    const found = await ctx.readFile(candidate);
    if (found !== null) continue;
    const portableHint = candidate.startsWith(componentRoot)
      ? ` (portable form: $AKM_STASH_DIR${candidate.slice(componentRoot.length)})`
      : "";
    diagnostics.push({
      file: relPath,
      issue: "stale-path",
      detail: `nonexistent path: ${candidate}${portableHint}`,
      fixed: false,
    });
  }

  for (const ref of extractProseRefTokens(body)) {
    const { exists } = await ctx.resolveRef(ref);
    if (!exists) diagnostics.push({ file: relPath, issue: "missing-ref", detail: `missing ref: ${ref}`, fixed: false });
  }
  if (frontmatter !== null) {
    for (const key of XREF_FRONTMATTER_KEYS) {
      const values = readRefStringOrArray(data[key]);
      if (values === null) continue;
      for (const value of values) {
        const ref = refTokenFromListValue(value);
        if (ref === null) continue;
        const { exists } = await ctx.resolveRef(ref);
        if (!exists) {
          diagnostics.push({
            file: relPath,
            issue: "missing-ref",
            detail: `missing ref: ${ref} (frontmatter ${key})`,
            fixed: false,
          });
        }
      }
    }
  }

  return diagnostics;
}

/**
 * Shared per-change loop: for every non-delete change with readable content,
 * parse frontmatter and run {@link runBaseValidateChecks}. Adapters with extra
 * per-type checks (e.g. `okf`'s missing-type / OKF-link warnings) run their own
 * loop and call {@link runBaseValidateChecks} directly instead.
 */
export async function validateChangesWithBaseChecks(
  c: BundleComponent,
  changes: FileChange[],
  ctx: ValidateContext,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    const parsed = parseFrontmatter(raw);
    diagnostics.push(...(await runBaseValidateChecks(change.path, parsed, c.root, ctx)));
  }
  return diagnostics;
}
