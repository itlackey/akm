// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { adapterForId, getAdapters } from "./registry";
import type { BundleComponent } from "./types";

/**
 * Tool-dir-shaped adapters (#908): their install-time probe recognizes only a
 * BOUNDED slice of the root — `claude`/`opencode`'s own `commands`/`agents`/
 * `skills` tool dirs, or `agent-skills`' own `<name>/SKILL.md` packages. A
 * bundle that ALSO carries ordinary akm content (`knowledge/`, `workflows/`,
 * a stray `content/` folder of Markdown, …) alongside one of these layouts had
 * that content SILENTLY dropped: the narrow adapter won the ordered probe and
 * indexed only its own three-dir slice, with no warning that anything else
 * was there (issue #908 — 73 documents disappeared from one real bundle).
 *
 * `okf` / `llm-wiki` / `dotenv` / `website-snapshot` / `akm-workflow` /
 * `akm-task` are deliberately NOT in this set: each carries its own tight,
 * disjoint marker (a root index document, `schema.md`+`pages/`, an env/secrets-only
 * layout, `manifest.json`, a workflow/task-shaped top-level file) that is not
 * at risk of firing merely because a FEW directory names happen to overlap
 * with akm's own stash subdirs — narrowing the fix to the three families the
 * issue is actually about keeps this from touching adapters it was never
 * about.
 */
const SHADOWABLE_ADAPTER_IDS = new Set(["agent-skills", "claude", "opencode"]);

/**
 * True when `root` — already claimed by `winnerId` (one of
 * {@link SHADOWABLE_ADAPTER_IDS}) — ALSO carries a top-level directory the
 * `akm` adapter's own probe recognizes as its workspace shape (spec §1.2) and
 * that `winnerId` does not own (its `directoryList()`, or — for `agent-skills`,
 * which owns no fixed directory names — a root-level `<name>/SKILL.md`
 * package) but which holds at least one real file. Cheap by design: only
 * shallow `readdirSync` calls, one level into each candidate top-level dir —
 * no recursive walk, no file content read, no git spawn — so this never adds
 * meaningful cost to the install-time probe it augments.
 */
function hasExtraAkmContent(root: string, winnerId: string): boolean {
  const akm = adapterForId("akm");
  if (akm?.looksLikeRoot?.(root) !== true) return false;

  const winner = adapterForId(winnerId);
  const stubComponent: BundleComponent = { id: "detect", adapter: winnerId, root, writable: false };
  const ownedDirs = new Set(winner?.directoryList?.(stubComponent) ?? []);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (ownedDirs.has(entry.name)) continue;
    if (winnerId === "agent-skills") {
      // A root-level `<name>/SKILL.md` package IS agent-skills' own recognized
      // surface even though it has no fixed directoryList — not "extra" content.
      try {
        if (fs.statSync(path.join(root, entry.name, "SKILL.md")).isFile()) continue;
      } catch {
        // Not a skill package — fall through to the candidate-file check below.
      }
    }
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true });
    } catch {
      continue;
    }
    if (children.some((child) => child.isFile() && !child.name.startsWith("."))) return true;
  }
  return false;
}

/**
 * Select the first built-in adapter whose ordered root probe claims `root`.
 *
 * A mixed-layout bundle (#908) that both a tool-dir-shaped adapter AND the
 * `akm` adapter would claim detects as `akm` — the superset, which still
 * indexes the narrower layout's own files correctly (`agent-skills`'
 * `<name>/SKILL.md` packages, `claude`/`opencode`'s `commands`/`agents`/
 * `skills`) while also picking up whatever else is in the bundle. A bundle
 * that carries ONLY the narrow layout (no extra content) is unaffected.
 */
export function detectAdapterId(root: string, fallback = "akm"): string {
  for (const adapter of getAdapters()) {
    try {
      if (adapter.looksLikeRoot?.(root) === true) {
        if (SHADOWABLE_ADAPTER_IDS.has(adapter.id) && hasExtraAkmContent(root, adapter.id)) {
          return "akm";
        }
        return adapter.id;
      }
    } catch {
      // An unreadable or racing probe does not claim the bundle.
    }
  }
  return fallback;
}
