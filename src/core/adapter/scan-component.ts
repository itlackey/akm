// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The core-owned `scanComponent` walk — akm 0.9.0 chunk-1, WI-1.3 (decision
 * D1-7, `docs/design/execution/chunk-1/brief.md`).
 *
 * `scanComponent(inst, c, adapter)` = core walk (git-aware, symlink-safe,
 * skip-dirs, NESTED-ROOT SUBTRACTION §9.3) x `adapter.recognize` per file —
 * transcribed from the adapter spec's `index?` JSDoc
 * (`akm-0.9.0-bundle-adapter-spec.md:141-149`) and the normative §14.2 scan
 * flow (`akm-format-neutral-bundle-workspace-spec.md:751-769`):
 *
 *   scanComponent (core walk x adapter.recognize, OR adapter.index override)
 *   -> DRAIN the full document stream (any scan error aborts before the
 *      first write) -> one write transaction: DIFF persist
 *
 * `scanComponent` is the core-walk HALF of that flow only. Choosing between
 * this walk and an adapter's own `index()` override is the CALLER's job
 * (§14.2's "or adapter.index override") — `scanComponent` itself never calls
 * `adapter.index`; doing so here would collapse the two paths the spec keeps
 * as alternatives into one and silently double-scan an `index()`-overriding
 * adapter's component.
 *
 * ── PRODUCTION STATUS (adapter-registry wiring WI) ──
 *
 * REMAINS UNWIRED at this HEAD — zero production callers (conformance +
 * scan-component tests only). The registry probe that SELECTS an adapter is now
 * live in production (`installations.ts#detectAdapterId`,
 * `provider-utils.ts#detectStashRoot`), but the SCAN ENGINE still uses the
 * legacy per-dir drain against the hardcoded `akmAdapter.recognize`
 * (`indexer.ts#buildComponentBySource`), so the derived adapter id is currently
 * PROVENANCE-ONLY (persisted to `entries.adapter_id`) and never resolved back to
 * an adapter object to drive recognition. Repointing the indexer scan onto
 * `scanComponent(inst, c, adapterForId(c.adapter))` is the larger "Step-3"
 * scan-engine swap (it must also cover §1.2(4) sub-mount registration and §1.2(1)
 * manifest components, and multi-component nested roots) and is deliberately OUT
 * of this WI's scope. When that site is built it MUST, per spec §4 / §12.6,
 * SKIP a component whose `adapter` id has no `adapterForId` match and emit a
 * warning (an unknown adapter id ⇒ component skipped with a warning) rather than
 * silently falling through — `adapterForId` already returns `undefined` for an
 * unknown id to make that check a one-liner.
 *
 * ── Walk reuse (a core->indexer VALUE import, on top of D1-3's type-only one) ──
 *
 * The git-aware/symlink-safe/skip-dirs walk is NOT reimplemented here. It is
 * reused as-is from `walkStashFlat` (`src/indexer/walk/walker.ts:73-82`),
 * which tries a `git ls-files --cached --others --exclude-standard` walk
 * first (`walkStashGit`, respects `.gitignore`, filters `SKIP_DIRS`
 * `{.git,node_modules,bin,.cache}` + dot-dirs) and falls back to a manual
 * recursive walk (`walkStashManual`) that explicitly skips symlinks
 * ("prevent potential path traversal outside stashRoot", `walker.ts:197-200`)
 * and the same `SKIP_DIRS`/dot-dirs. Both paths already build one
 * `FileContext` per surviving file via `buildFileContext`
 * (`file-context.ts:65-118`) internally — so this module does NOT call
 * `buildFileContext` a second time; the `FileContext`s `walkStashFlat`
 * returns are used as-is. This is the D1-7 DRY choice ("reuse the
 * `walker.ts` primitive shape... DO NOT reimplement").
 *
 * FLAGGED for the maintainer (mirrors D1-3's FileContext flag on
 * `bundle-adapter.ts`): this is a second core->indexer layering import, and
 * unlike D1-3's `import type { FileContext }`, this one is a runtime VALUE
 * import (`walkStashFlat` is called, not just type-referenced). Verified to
 * add no import-cycle participant — `src/core/adapter/` is a new sink at
 * this HEAD (chunk 1), imported only by its own tests, so nothing imports
 * back into it; the cycle ratchet (`bun scripts/lint-import-cycles.ts`)
 * stays at 28 with this file present (see the chunk-1 ledger for the
 * verified gate run). `walker.ts`/`file-context.ts` living under
 * `src/indexer/walk/` while consumed from `src/core/adapter/` is the same
 * "arguably belongs in core long-term" wrinkle D1-3 already flagged; moving
 * them is out of chunk 1's netLoc-0 scope.
 *
 * ── Nested-root subtraction (normative §9.3 — genuinely new logic) ──
 *
 * "Component roots MUST NOT overlap except by strict nesting. When roots are
 * nested, the parent component's file set is its tree minus every other
 * configured component root" (`akm-format-neutral-bundle-workspace-spec.md:
 * 382-388`). No existing code implements this (chunk-1 anchors.md §B.3): the
 * pre-0.9.0 model is single-stash-root, walked once, with no concept of
 * component nesting at all.
 *
 * Implemented as: resolve every OTHER component's root (by `id`, from
 * `inst.components`) that is STRICTLY nested under `c`'s resolved root (a
 * proper descendant — `c.root` itself does not count as nested under
 * itself, and a sibling/unrelated/ancestor root does not count either);
 * then, for every file the walk yields, skip it if its absolute path lies
 * under ANY of those nested other-roots. A file directly under `c.root`
 * that is not under any nested child root belongs to `c` — this is the "own
 * tree minus every other configured root" rule applied per file, computed
 * once per `scanComponent` call (mirroring the "computed once at mount
 * registration" persistence normative §9.3 describes — chunk 1 has no mount-
 * registration cache yet, so the per-call computation is the scan-time
 * analog). The walk itself is unmodified (still descends into nested
 * subtrees via `walkStashFlat`); subtraction is a post-walk filter, not a
 * pre-pruned traversal — simpler, and still correct, given the "do not
 * touch the walker" constraint.
 *
 * Path containment (`isPathUnder`, below) is computed via `path.relative`,
 * not string prefixing: a path is "under" a root when the relative path
 * from that root neither starts with `..` nor is itself absolute (a
 * different-drive case on non-POSIX systems). Both component roots and file
 * paths are `path.resolve()`d before comparison so trailing slashes / `.`
 * segments cannot defeat the check.
 */

import path from "node:path";
import { walkStashFlat } from "../../indexer/walk/walker";
import type { BundleAdapter } from "./bundle-adapter";
import type { BundleComponent, BundleInstallation, IndexDocument } from "./types";

/**
 * True when `target` (an absolute, resolved path) is a proper descendant of
 * `root` (an absolute, resolved directory path) — used both to decide which
 * other components are "nested under `c`" and, per file, whether that
 * file's path falls under one of those nested roots.
 */
function isPathUnder(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve the set of OTHER components' roots (absolute, normalized) that
 * are strictly nested under `c`'s root — the normative §9.3 subtraction
 * set. Components sharing `c`'s own `id` are never "other"; a component
 * whose root is NOT a proper descendant of `c.root` (a sibling, an
 * ancestor, or `c.root` itself) is not nested and is not subtracted.
 */
function nestedOtherRoots(inst: BundleInstallation, c: BundleComponent): string[] {
  const parentRoot = path.resolve(c.root);
  const nested: string[] = [];
  for (const other of inst.components) {
    if (other.id === c.id) continue;
    const otherRoot = path.resolve(other.root);
    if (isPathUnder(otherRoot, parentRoot)) nested.push(otherRoot);
  }
  return nested;
}

/**
 * Walk one component's root (git-aware, symlink-safe, skip-dirs — reused
 * from `walkStashFlat`), subtract every other configured component's root
 * that is strictly nested inside `c.root` (normative §9.3), and apply
 * `adapter.recognize` per surviving file. Yields only non-null
 * recognitions — a `null` return is an adapter abstention and is silently
 * skipped, the same contract `runMatchers`'s "no matcher claims the file"
 * case had.
 *
 * This is the CORE-WALK half of §14.2's scan flow only: it never calls
 * `adapter.index`. Choosing the core walk vs. an adapter's `index()`
 * override is the CALLER's decision (§14.2: "scanComponent ... or
 * adapter.index override").
 */
export async function* scanComponent(
  inst: BundleInstallation,
  c: BundleComponent,
  adapter: BundleAdapter,
): AsyncIterable<IndexDocument> {
  const nestedRoots = nestedOtherRoots(inst, c);
  const files = walkStashFlat(c.root);

  for (const file of files) {
    if (nestedRoots.some((root) => isPathUnder(file.absPath, root))) continue;
    const doc = adapter.recognize(c, file);
    if (doc !== null) yield doc;
  }
}
