// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Proposal diff renderers — extracted verbatim from `repository.ts`
 * (Chunk 6 WI-6.6 decompose). Pure string functions with no repository
 * dependency; `diffProposal` (repository.ts) is the only production caller.
 */

/**
 * Minimal unified-diff renderer. We deliberately avoid pulling a runtime
 * dependency just for this — proposals diffs are usually small (a single
 * lesson / skill file), so the LCS-free greedy renderer below is plenty for
 * humans to review. The output mirrors `git diff --no-index` for the first
 * `@@ … @@` hunk: enough to be familiar, not so detailed that we re-implement
 * a full LCS table.
 */
export function formatUnifiedDiff(left: string, right: string, label: string): string {
  if (left === right) return "";
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const lines: string[] = [`--- ${label} (existing)`, `+++ ${label} (proposed)`];

  // Pad to the longer side so alignment is one-to-one. Real diff tools use
  // LCS to align matching runs; we don't need that fidelity for a review
  // surface — both halves are visible regardless.
  const max = Math.max(leftLines.length, rightLines.length);
  lines.push(`@@ 1,${leftLines.length} 1,${rightLines.length} @@`);
  for (let i = 0; i < max; i += 1) {
    const l = leftLines[i];
    const r = rightLines[i];
    if (l === r && l !== undefined) {
      lines.push(` ${l}`);
      continue;
    }
    if (l !== undefined) lines.push(`-${l}`);
    if (r !== undefined) lines.push(`+${r}`);
  }
  return lines.join("\n");
}

/** Render the all-additions diff for a proposal targeting a new asset. */
export function formatNewAssetDiff(ref: string, content: string): string {
  const lines = [`--- /dev/null`, `+++ ${ref} (proposed, new asset)`];
  lines.push(`@@ 0,0 1,${content.split("\n").length} @@`);
  for (const line of content.split("\n")) {
    lines.push(`+${line}`);
  }
  return lines.join("\n");
}

/**
 * Render the all-removals diff for a retire proposal (#997): the file its
 * accept archives, line by line, and nothing added. Padding the proposed side
 * with an empty string, as {@link formatUnifiedDiff} does, reads as "the whole
 * file replaced by one blank line" — a retirement reviewed as data loss.
 * `existing` is `null` when the retired file is already gone.
 */
export function formatRetireDiff(ref: string, existing: string | null, successorRef?: string): string {
  const destination = `+++ /dev/null (retired: archived${successorRef ? `; successor ${successorRef}` : ""})`;
  if (existing === null) return [`--- ${ref} (missing)`, destination].join("\n");
  const removed = existing.split("\n");
  if (removed[removed.length - 1] === "") removed.pop(); // the newline ending the file is not a line of its own
  return [
    `--- ${ref} (existing)`,
    destination,
    `@@ 1,${removed.length} 0,0 @@`,
    ...removed.map((line) => `-${line}`),
  ].join("\n");
}
