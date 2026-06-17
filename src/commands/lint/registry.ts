// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { AgentLinter } from "./agent-linter";
import { CommandLinter } from "./command-linter";
import { DefaultLinter } from "./default-linter";
import { KnowledgeLinter } from "./knowledge-linter";
import { MemoryLinter } from "./memory-linter";
import { SkillLinter } from "./skill-linter";
import { TaskLinter } from "./task-linter";
import type { AssetLinter } from "./types";
import { WorkflowLinter } from "./workflow-linter";

// Singleton instances — one per type, shared across all lint runs.
const LINTERS: AssetLinter[] = [
  new AgentLinter(),
  new MemoryLinter(),
  new WorkflowLinter(),
  new CommandLinter(),
  new KnowledgeLinter(),
  new SkillLinter(),
  new TaskLinter(),
];

// Single shared DefaultLinter instance — used both as the explicit "lessons"
// handler and as the fallback for any unrecognised asset type.
const DEFAULT_LINTER = new DefaultLinter();

const LINTER_MAP = new Map<string, AssetLinter>();
for (const linter of LINTERS) {
  for (const t of linter.types) {
    LINTER_MAP.set(t, linter);
  }
}
// Register "lessons" explicitly so there is only one DefaultLinter instance.
LINTER_MAP.set("lessons", DEFAULT_LINTER);

/**
 * Return the appropriate linter for the given stash subdirectory name.
 * Falls back to `DefaultLinter` for unknown types.
 */
export function getLinterForType(subdir: string): AssetLinter {
  return LINTER_MAP.get(subdir) ?? DEFAULT_LINTER;
}
