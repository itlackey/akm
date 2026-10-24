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
 * Legitimate disagreements exist by design — a `knowledge/` file containing
 * `$ARGUMENTS` is deliberately a `command`, and an `agents/` file with an
 * `agent:` frontmatter key is deliberately a `command` (both asserted in
 * `tests/integration/commands/show.test.ts`). So this is never a hard
 * failure: every disagreement is reported with a `winner` naming which
 * classifier signal produced the resolved type, so a deliberate override
 * reads differently from an unexplained one.
 */

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import type { HealthCheckResult } from "./types";

/**
 * Directory → declared-type map, mirroring `DIR_TYPE_MAP` in
 * `src/indexer/walk/matchers.ts` minus its per-directory extension test —
 * this check only needs "which type does this directory declare", not which
 * extensions it accepts. Keep in sync if `DIR_TYPE_MAP` gains, renames, or
 * removes a directory.
 */
const DECLARED_DIR_TYPES: Readonly<Record<string, string>> = {
  memories: "memory",
  knowledge: "knowledge",
  commands: "command",
  agents: "agent",
  workflows: "workflow",
  facts: "fact",
  lessons: "lesson",
  sessions: "session",
  instructions: "instruction",
  scripts: "script",
  env: "env",
  secrets: "secret",
  tasks: "task",
};

/** The minimal shape this check needs from an indexed `entries` row. */
export interface TypeDirectoryEntry {
  filePath: string;
  type: string;
}

export interface TypeDirectoryDisagreement {
  path: string;
  resolved: string;
  expected: string;
  /** Which classifier signal produced `resolved`, or "unknown" when none was found. */
  winner: string;
  /** True for the two documented deliberate-override contracts (and their frontmatter siblings). */
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
 * The type a file's directory declares, mirroring the `classifyByDirectory` /
 * `classifyByParentDirHint` precedence in matchers.ts: the immediate parent
 * directory wins when it is itself typed (parentDirHint, specificity 15);
 * otherwise the outermost typed ancestor wins (directoryMatcher, specificity
 * 10, which walks root-to-leaf and returns on the first hit).
 */
function declaredTypeForPath(absPath: string): { dir: string; type: string } | undefined {
  const segments = path
    .dirname(absPath)
    .split(path.sep)
    .filter((seg) => seg.length > 0);
  const immediateParent = segments.at(-1);
  if (immediateParent) {
    const parentType = DECLARED_DIR_TYPES[immediateParent];
    if (parentType) return { dir: immediateParent, type: parentType };
  }
  for (const seg of segments) {
    const type = DECLARED_DIR_TYPES[seg];
    if (type) return { dir: seg, type };
  }
  return undefined;
}

/**
 * Best-effort explanation for why `classifyBySmartMd` (matchers.ts) would
 * have produced `resolvedType` for this content, in the SAME precedence
 * order the real function checks them. Returns `undefined` when no known
 * override signal is found — that absence is itself the accident signal:
 * nothing in the file explains why its type disagrees with its directory.
 *
 * The numeric-placeholder branch is flagged `knownGoodOverride: false` on
 * purpose: since #826, that heuristic is guarded to never fire when the file
 * sits under a declared-type directory, so seeing it win here would mean the
 * guard regressed, not that this is a sanctioned override.
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
    return { winner: "smart-md:$ARGUMENTS", knownGoodOverride: true };
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
 * directory declares (see {@link DECLARED_DIR_TYPES}), and return one
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
    const declared = declaredTypeForPath(entry.filePath);
    if (!declared || declared.type === entry.type) continue;
    const content = readFile(entry.filePath);
    const explanation = content === undefined ? undefined : explainOverride(entry.type, content);
    disagreements.push({
      path: entry.filePath,
      resolved: entry.type,
      expected: declared.type,
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
