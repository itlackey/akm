// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `type-directory-disagreement` advisory for `akm health` (#831).
 *
 * The invariant "a file's directory declares its type" is load-bearing for
 * refs, namespace listings, and `akm show` paths (see #824: three files
 * written to `memories/` were indexed as `type: command`, moved their refs
 * under `commands/memories/<slug>`, and silently vanished from the
 * `memories/` namespace — nothing on any normal surface said so). This
 * advisory re-checks that invariant against every currently indexed entry.
 *
 * Legitimate disagreements exist by design — an `agents/` file with an
 * `agent:` frontmatter key explicitly declares a `command`. So this is never a hard
 * failure: every disagreement is reported with a `winner` naming which
 * classifier signal produced the resolved type, so a deliberate override
 * reads differently from an unexplained one.
 */

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { buildFileContext } from "../../indexer/walk/file-context";
import { declaredTypeForPath } from "../../indexer/walk/matchers";
import type { HealthCheckResult } from "./types";

/** The minimal shape this check needs from an indexed `entries` row. */
export interface TypeDirectoryEntry {
  filePath: string;
  type: string;
  /** Component root the entry was indexed under; directory intent is read only from inside it. */
  root: string;
  /** Owning adapter; only the `akm` adapter declares stash directory rules. */
  adapterId: string;
}

/**
 * The type the entry's location declares under the `akm` stash rules, derived
 * with the indexer's own directory predicates (see `declaredTypeForPath`).
 * Other adapters, and paths outside the component root, declare nothing.
 */
function declaredTypeFor(entry: TypeDirectoryEntry): string | undefined {
  if (entry.adapterId !== "akm" || !entry.root) return undefined;
  const rel = path.relative(entry.root, entry.filePath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return declaredTypeForPath(buildFileContext(entry.root, entry.filePath));
}

export interface TypeDirectoryDisagreement {
  path: string;
  resolved: string;
  expected: string;
  /** Which classifier signal produced `resolved`, or "unknown" when none was found. */
  winner: string;
  /** True for documented explicit frontmatter overrides, never body placeholders. */
  knownGoodOverride: boolean;
}

/** Injectable file-read seam so the pure collector never needs a real filesystem in tests. */
export type ReadFileFn = (absPath: string) => string | undefined;

const realReadFile: ReadFileFn = (absPath) => {
  try {
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * Best-effort explanation for why the current or an older `classifyBySmartMd`
 * (matchers.ts) produced `resolvedType` for this content, in the SAME precedence
 * order the real function checks them. Returns `undefined` when no known
 * override signal is found — that absence is itself the accident signal:
 * nothing in the file explains why its type disagrees with its directory.
 *
 * Body placeholders cannot override a directory declaration. Seeing one win
 * here indicates a stale index or a classifier regression, not a sanctioned
 * override.
 */
function explainOverride(
  resolvedType: string,
  content: string,
): { winner: string; knownGoodOverride: boolean } | undefined {
  const fm = parseFrontmatter(content).data;

  if (fm.type === "workflow" && resolvedType === "workflow") {
    return { winner: "smart-md:workflow-frontmatter", knownGoodOverride: true };
  }
  if ("agent" in fm && resolvedType === "command") {
    return { winner: "smart-md:agent-frontmatter", knownGoodOverride: true };
  }
  if (resolvedType === "command" && content.includes("$ARGUMENTS")) {
    return { winner: "smart-md:$ARGUMENTS", knownGoodOverride: false };
  }
  if (resolvedType === "command" && /\$[123](?!\d|[.,]\d)/.test(content)) {
    return { winner: "smart-md:numeric-placeholder", knownGoodOverride: false };
  }
  if ("model" in fm && resolvedType === "agent") {
    return { winner: "smart-md:model-frontmatter", knownGoodOverride: true };
  }
  return undefined;
}

/**
 * Compare every indexed entry's resolved type against the type its
 * directory declares (see {@link declaredTypeFor}), and return one
 * {@link TypeDirectoryDisagreement} per mismatch, sorted by path. Entries
 * outside any declared-type directory are not checked — this is only the
 * "directory declares type" invariant.
 */
export function collectTypeDirectoryDisagreements(
  entries: readonly TypeDirectoryEntry[],
  readFile: ReadFileFn = realReadFile,
): TypeDirectoryDisagreement[] {
  const disagreements: TypeDirectoryDisagreement[] = [];
  for (const entry of entries) {
    const declared = declaredTypeFor(entry);
    if (!declared || declared === entry.type) continue;
    const content = readFile(entry.filePath);
    const explanation = content === undefined ? undefined : explainOverride(entry.type, content);
    disagreements.push({
      path: entry.filePath,
      resolved: entry.type,
      expected: declared,
      winner: explanation?.winner ?? "unknown",
      knownGoodOverride: explanation?.knownGoodOverride ?? false,
    });
  }
  return disagreements.sort((a, b) => a.path.localeCompare(b.path));
}

const MAX_DETAIL_LINES = 10;

/**
 * Build the `type-directory-disagreement` advisory, or `undefined` when
 * every indexed entry agrees with its directory. Always `status: "warn"`
 * (never `"fail"`) — a deliberate override is still a disagreement worth
 * seeing, just not a gate.
 */
export function buildTypeDirectoryAdvisory(
  entries: readonly TypeDirectoryEntry[],
  readFile: ReadFileFn = realReadFile,
  displayPath: (absPath: string) => string = (p) => p,
): HealthCheckResult | undefined {
  const disagreements = collectTypeDirectoryDisagreements(entries, readFile);
  if (disagreements.length === 0) return undefined;

  const lines = disagreements.slice(0, MAX_DETAIL_LINES).map((d) => {
    const note = d.knownGoodOverride ? " (known-good override)" : "";
    return `${displayPath(d.path)} resolved=${d.resolved} expected=${d.expected} winner=${d.winner}${note}`;
  });
  if (disagreements.length > MAX_DETAIL_LINES) {
    lines.push(`+${disagreements.length - MAX_DETAIL_LINES} more`);
  }

  return {
    name: "type-directory-disagreement",
    kind: "deterministic",
    status: "warn",
    confidence: "high",
    message: `${disagreements.length} indexed asset(s) have a resolved type that disagrees with the type their directory declares: ${lines.join("; ")}`,
    evidence: {
      disagreements: disagreements.map((d) => ({ ...d, path: displayPath(d.path) })),
    },
  };
}
