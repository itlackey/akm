// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ONE core {@link ValidateContext} implementation — akm 0.9.0 chunk-2/lint
 * follow-up ("make `validate()` genuinely load-bearing").
 *
 * `BundleAdapter.validate()` (`./bundle-adapter.ts`) is a REQUIRED interface
 * method whose contract is explicit and normative (`./bundle-adapter.ts:96-100`
 * / the format-neutral spec §12.1): the adapter MUST NOT write and MUST NOT
 * read the live filesystem — `ctx` serves the run's on-disk SNAPSHOT WITH the
 * caller's pending {@link FileChange}s overlaid, plus a read-only `resolveRef`
 * for link/xref existence. That overlay is meant to be built ONCE, centrally —
 * "one core overlay implementation, not one per adapter" (the interface's own
 * words) — so every `validate()` caller shares identical overlay semantics
 * rather than each hand-rolling its own (as every adapter's own test suite has
 * done up to now, see e.g. `tests/core/adapter/okf-adapter.test.ts`'s
 * `overlayCtx`/`diskCtx`).
 *
 * The two production callers wired onto this factory:
 *   - `akm lint`'s non-akm adapter dispatch (`commands/lint/index.ts`) — a
 *     plain sweep with NO pending changes, so the overlay is empty and every
 *     read falls straight through to disk.
 *   - the proposal promotion preflight (`commands/proposal/repository.ts`
 *     `preflightProposalPromotion`) — the one proposal's own `changes` are the
 *     overlay, so `validate()` sees the bundle AS IT WOULD LOOK the instant
 *     after the transaction commits, without that transaction ever touching
 *     disk.
 *
 * ── resolveRef ──
 *
 * A bare (unqualified) `conceptId` is resolved as BOTH:
 *   1. the AKM placement-derived path (`typeNameFromConceptId` + `stashDirFor`
 *      + `assetPathForName` — the exact derivation `commands/lint/base-linter.ts
 *      #refToRelPath` already uses for the akm-native `missing-ref` check); and
 *   2. the DIRECT component-relative spelling (`<conceptId>.md`, and the bare
 *      `<conceptId>` for an extensionless asset) — the form every non-akm
 *      adapter's OWN conceptId already IS (OKF: path − `.md`; llm-wiki: same).
 * A `bundle//conceptId`-qualified ref has its bundle prefix stripped before
 * resolution — mirroring `base-linter.ts#classifyConceptRef`'s existing
 * behavior (the legacy resolver has never scoped-by-bundle-name either; it
 * searches every configured stash root for the bare conceptId). Existence is
 * checked against the PRIMARY root (with the pending-changes overlay applied)
 * first, then each extra root (disk only — a pending transaction never
 * targets more than one bundle).
 */

import fs from "node:fs";
import path from "node:path";
import { assetPathForName, stashDirFor } from "../asset/asset-placement";
import { typeNameFromConceptId } from "../asset/resolve-ref";
import { toPosix } from "../common";
import type { FileChange } from "../file-change";
import type { ValidateContext } from "./types";

/** `null` = the overlay DELETES this path (never satisfies a read/exists check). */
type OverlayValue = string | null;

/** Build the overlay map, keyed by POSIX path relative to `root`. */
function buildOverlay(root: string, changes: readonly FileChange[]): Map<string, OverlayValue> {
  const overlay = new Map<string, OverlayValue>();
  for (const change of changes) {
    const relKey = toPosix(path.isAbsolute(change.path) ? path.relative(root, change.path) : change.path);
    if (!relKey || relKey.startsWith("..")) continue; // outside root — not this context's concern
    if (change.op === "delete") {
      overlay.set(relKey, null);
      continue;
    }
    if (change.after !== undefined) overlay.set(relKey, change.after);
  }
  return overlay;
}

function readDisk(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function existsOnDiskOrOverlay(relPath: string, root: string, overlay: Map<string, OverlayValue> | null): boolean {
  const key = toPosix(relPath);
  // Overlay entries are pending file contents by construction, so a present
  // non-null entry is always a file.
  if (overlay?.has(key)) return overlay.get(key) !== null;
  try {
    // `isFile()`, not `existsSync()`: a ref naming a DIRECTORY (e.g. a
    // `pages/foo/` dir alongside no `pages/foo.md`) must not count as a
    // resolved target — that would silently suppress a real
    // `missing-ref`/`broken-xref` diagnostic.
    return fs.statSync(path.join(root, relPath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Refs come from bundle CONTENT (link targets, xrefs, `sources:` entries), so
 * they are untrusted input. A ref must stay inside the bundle root: reject
 * absolute paths and any `..` segment before joining, so content can never
 * probe for existence outside its own bundle (nor report a resolved `path`
 * pointing there). Mirrors the `isWithin` containment rule the write path
 * already enforces in `core/write-source.ts`.
 */
function refEscapesBundle(conceptId: string): boolean {
  if (path.isAbsolute(conceptId) || conceptId.startsWith("/")) return true;
  return toPosix(conceptId)
    .split("/")
    .some((segment) => segment === "..");
}

/**
 * Every on-disk relative path a bare `conceptId` might resolve to: the AKM
 * placement-derived path (when the leading segment names a known placement
 * stash-subdir) and the direct component-relative spellings every non-akm
 * adapter's own conceptId already uses. Order doesn't matter — the caller
 * checks all of them.
 */
function candidateRelPaths(conceptId: string): string[] {
  const candidates: string[] = [];
  const parts = typeNameFromConceptId(conceptId);
  if (parts !== undefined) {
    const typeDir = stashDirFor(parts.type);
    if (typeDir !== undefined) candidates.push(assetPathForName(parts.type, typeDir, parts.name));
  }
  candidates.push(`${conceptId}.md`);
  candidates.push(conceptId);
  return candidates;
}

/** Strip an optional `#fragment` (export selector) — never part of the on-disk identity. */
function stripFragment(ref: string): string {
  const hashIdx = ref.indexOf("#");
  return hashIdx >= 0 ? ref.slice(0, hashIdx) : ref;
}

/**
 * Strip an optional `bundle//` qualifier. Mirrors `base-linter.ts
 * #classifyConceptRef`'s existing behavior: the legacy missing-ref checker has
 * never resolved a qualifier against a NAMED bundle either — it searches every
 * configured stash root for the bare conceptId. Keeping that same leniency
 * here means this resolver's answers agree with today's `akm lint` for every
 * ref shape that already worked.
 */
function stripBundlePrefix(ref: string): string {
  const boundary = ref.indexOf("//");
  return boundary >= 0 ? ref.slice(boundary + 2) : ref;
}

export interface ValidateContextOptions {
  /** The primary root `changes` paths are relative to (a component's root, or a lint sweep's stash root). */
  root: string;
  /** Additional stash roots consulted (disk only) for cross-bundle ref existence — mirrors `akmLint`'s `extraStashRoots`. */
  extraRoots?: readonly string[];
  /** Pending changes to overlay onto the snapshot. Empty (or omitted) for a plain sweep with nothing pending. */
  changes?: readonly FileChange[];
}

/**
 * Build the ONE core {@link ValidateContext}: reads/lookups served from the
 * on-disk snapshot rooted at `options.root` (+ `options.extraRoots` for
 * cross-bundle ref existence) WITH `options.changes` overlaid on `options.root`
 * — never a write, never a live-FS read beyond that snapshot.
 */
export function createValidateContext(options: ValidateContextOptions): ValidateContext {
  const root = options.root;
  const extraRoots = options.extraRoots ?? [];
  const overlay = buildOverlay(root, options.changes ?? []);

  async function readFile(p: string): Promise<string | Uint8Array | null> {
    // An absolute candidate (e.g. a `stale-path` scan hit, which is always an
    // absolute host path) bypasses the overlay — it can never name a pending
    // change's stash-relative path, and reads straight from disk (the base
    // checks' existing "does this literal absolute path exist" question).
    if (path.isAbsolute(p)) return readDisk(p);
    const key = toPosix(p);
    if (overlay.has(key)) return overlay.get(key) ?? null;
    return readDisk(path.join(root, p));
  }

  async function list(dir: string): Promise<string[]> {
    const abs = path.isAbsolute(dir) ? dir : path.join(root, dir);
    const relDir = toPosix(path.isAbsolute(dir) ? path.relative(root, dir) : dir);
    const names = new Set<string>();
    try {
      for (const entry of fs.readdirSync(abs)) names.add(entry);
    } catch {
      // directory may not exist on disk yet — the overlay can still populate it
    }
    const prefix = relDir === "." || relDir === "" ? "" : `${relDir}/`;
    for (const [key, value] of overlay) {
      if (prefix.length > 0 && !key.startsWith(prefix)) continue;
      const rest = prefix.length > 0 ? key.slice(prefix.length) : key;
      if (rest.length === 0 || rest.includes("/")) continue; // only direct children
      if (value === null) names.delete(rest);
      else names.add(rest);
    }
    return [...names];
  }

  async function resolveRef(ref: string): Promise<{ exists: boolean; path?: string }> {
    const conceptId = stripBundlePrefix(stripFragment(ref)).trim();
    if (!conceptId) return { exists: false };
    if (refEscapesBundle(conceptId)) return { exists: false };
    const candidates = candidateRelPaths(conceptId);
    const roots: Array<{ root: string; usesOverlay: boolean }> = [
      { root, usesOverlay: true },
      ...extraRoots.map((r) => ({ root: r, usesOverlay: false })),
    ];
    for (const { root: candidateRoot, usesOverlay } of roots) {
      for (const relPath of candidates) {
        if (existsOnDiskOrOverlay(relPath, candidateRoot, usesOverlay ? overlay : null)) {
          return { exists: true, path: path.join(candidateRoot, relPath) };
        }
      }
    }
    return { exists: false };
  }

  return { readFile, list, resolveRef };
}
