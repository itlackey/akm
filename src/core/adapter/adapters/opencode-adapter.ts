// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `opencode` tool-directory adapter — akm 0.9.0 format-family work item
 * (#46).
 *
 * Recognizes an OpenCode `.opencode` layout (spec §6/§7, real-world:
 * https://opencode.ai/docs/{commands,agents,skills,rules}/): a root `AGENTS.md`
 * → `instruction`, `commands/*.md` → `command`, `agents/*.md` → `agent`,
 * `skills/<name>/SKILL.md` → `skill`, and ABSTAINS on `opencode.json` runtime
 * config. Per open-question-6 (RESOLVED, accept BOTH forms) the SINGULAR
 * `command/`/`agent/`/`skill/` dirs are accepted as backwards-compat aliases on
 * READ (the conceptId preserves the on-disk spelling, e.g. `command/legacy`);
 * WRITES normalize to the canonical plural (handled in the shared codec).
 *
 * All behavior lives in the shared tool-dir codec ({@link makeToolDirAdapter});
 * this module supplies only the `.opencode` layout + the install-time probe.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/opencode/` + goldens
 * `tests/fixtures/format-family-goldens/opencode/{recognition,placement,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { BundleAdapter } from "../bundle-adapter";
import { makeToolDirAdapter, type ToolDirLayout } from "./tool-dir-shared";

const LAYOUT: ToolDirLayout = {
  adapterId: "opencode",
  componentId: ".opencode",
  instructionFile: "AGENTS.md",
  instructionConceptId: "AGENTS",
  commandDirs: new Set(["commands", "command"]),
  agentDirs: new Set(["agents", "agent"]),
  skillDirs: new Set(["skills", "skill"]),
};

const CONFIG_FILES = ["opencode.json", "opencode.jsonc"];
const TOOL_DIRS = ["commands", "command", "agents", "agent", "skills", "skill"];

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Install-time probe (§1.2): a root is an `.opencode` tool dir when it carries
 * an `opencode.json`/`opencode.jsonc` config, OR a root `AGENTS.md` plus at
 * least one tool dir. Neither marker exists on an akm/okf/wiki root, so the
 * probe is unambiguous; registered ahead of `akm` so a `.opencode` root (whose
 * plural tool dirs also look like akm stash subdirs) is claimed by `opencode`.
 */
function opencodeLooksLikeRoot(root: string): boolean {
  if (CONFIG_FILES.some((f) => fileExists(path.join(root, f)))) return true;
  if (!fileExists(path.join(root, "AGENTS.md"))) return false;
  return TOOL_DIRS.some((d) => dirExists(path.join(root, d)));
}

export const opencodeAdapter: BundleAdapter = makeToolDirAdapter(LAYOUT, opencodeLooksLikeRoot);
