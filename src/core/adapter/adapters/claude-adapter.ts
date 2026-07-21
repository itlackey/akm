// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `claude` tool-directory adapter — akm 0.9.0 format-family work item (#46).
 *
 * Recognizes a Claude Code `.claude` layout (spec §6/§7, real-world:
 * https://code.claude.com/docs/en/claude-directory): a root `CLAUDE.md` →
 * `instruction`, `commands/*.md` → `command`, `agents/*.md` → `agent`,
 * `skills/<name>/SKILL.md` → `skill` (item = the dir; bundled resources abstain),
 * and ABSTAINS on runtime config (`settings.json`, `.mcp.json`). The component
 * id is the PROVENANCE `.claude`; the ref prefix is the bundle id (`c.id`).
 *
 * All behavior lives in the shared tool-dir codec ({@link makeToolDirAdapter});
 * this module supplies only the `.claude` layout + the install-time probe.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/claude/` + goldens
 * `tests/fixtures/format-family-goldens/claude/{recognition,placement,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { BundleAdapter } from "../bundle-adapter";
import { makeToolDirAdapter, type ToolDirLayout } from "./tool-dir-shared";

const LAYOUT: ToolDirLayout = {
  adapterId: "claude",
  componentId: ".claude",
  instructionFile: "CLAUDE.md",
  instructionConceptId: "CLAUDE",
  commandDirs: new Set(["commands"]),
  agentDirs: new Set(["agents"]),
  skillDirs: new Set(["skills"]),
};

/** True when `root` carries a directory. */
function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Install-time probe (§1.2): a root is a `.claude` tool dir when it carries a
 * root `CLAUDE.md` AND at least one of the `commands/`/`agents/`/`skills/` tool
 * dirs. The tool-dir requirement keeps a bare project `CLAUDE.md` (no `.claude`
 * structure) from being mistaken for a claude bundle, and — because it demands
 * `CLAUDE.md`, which an akm workspace / okf / wiki root never carries — the
 * probe is registered AHEAD of `akm` so a `.claude` root (whose `commands/`
 * etc. also look like akm stash subdirs) is claimed by `claude`, not shadowed.
 */
function claudeLooksLikeRoot(root: string): boolean {
  try {
    if (!fs.existsSync(path.join(root, "CLAUDE.md"))) return false;
  } catch {
    return false;
  }
  return ["commands", "agents", "skills"].some((d) => dirExists(path.join(root, d)));
}

export const claudeAdapter: BundleAdapter = makeToolDirAdapter(LAYOUT, claudeLooksLikeRoot);
