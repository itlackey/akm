// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A stored record, an index row or a config entry never names a storage detail: no file, path, directory or root.
 * This test lists every `state.db` and `index.db` column and every field of the persisted record types whose name
 * says it does (`path`, `dir`, `root`) and fails on one the allowlist below lacks. It is a ratchet like the asset-io
 * baseline: each entry names the phase of the adapter plan that removes it (`permanent` if none does), and an entry
 * whose field is gone fails until it is deleted.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { openStateDatabase } from "../../../src/core/state-db";
import { openIndexDatabase } from "../../../src/storage/repositories/index-connection";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const STORAGE_NAME = /path|dir|root/i;

/** Field -> the phase that removes it. */
const ALLOWED: Record<string, string> = {
  "state.task_history.log_path": "permanent (a run log is state, not an asset)",
  "state.workflow_run_units.worktree_path": "permanent (a git worktree of a run, not an asset)",
  "state.workflow_run_unit_attempts.worktree_path": "permanent (a git worktree of a run, not an asset)",
  "index.entries.file_path": "permanent (nullable display path, 4f.2)",
  "index.index_dir_state.dir_path": "permanent (directory scan state)",
  "IndexDocument.path": "permanent (display)",
  "InstalledSchedulerBinding.contextPath": "4e.3",
  "InstalledSchedulerBinding.ownerBundlePath": "4e.3",
};

/** The persisted record types: the file that declares each. */
const RECORD_TYPES: Record<string, string[]> = {
  "src/commands/proposal/proposal-types.ts": [
    "Proposal",
    "ProposalChange",
    "RetireAcceptIntent",
    "RetiredArchiveRecord",
  ],
  "src/core/improve-types.ts": ["ArchivedMemoryCleanupRecord"],
  "src/core/adapter/types.ts": ["IndexDocument"],
  "src/tasks/scheduler-binding.ts": ["InstalledSchedulerBinding"],
};

function columnsOf(label: string, db: ReturnType<typeof openStateDatabase>): string[] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return tables.flatMap(({ name }) =>
    (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map(
      (column) => `${label}.${name}.${column.name}`,
    ),
  );
}

/** `Type.field` and `Type.field.nested` for every property of the named interfaces, inline object types included. */
function recordFields(): string[] {
  const fields: string[] = [];
  const walk = (prefix: string, members: ts.NodeArray<ts.TypeElement>) => {
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const name = `${prefix}.${member.name.getText()}`;
      fields.push(name);
      const type = member.type;
      if (type && ts.isTypeLiteralNode(type)) walk(name, type.members);
    }
  };
  for (const [file, names] of Object.entries(RECORD_TYPES)) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (ts.isInterfaceDeclaration(statement) && names.includes(statement.name.text)) {
        walk(statement.name.text, statement.members);
      }
    }
  }
  return fields;
}

describe("persisted fields", () => {
  test("no state.db or index.db column and no stored record field names a path, directory or root outside the allowlist", () => {
    let storage: IsolatedAkmStorage | undefined;
    let found: string[];
    try {
      storage = withIsolatedAkmStorage();
      const state = openStateDatabase();
      const index = openIndexDatabase(path.join(storage.cacheDir, "index.db"));
      try {
        found = [...columnsOf("state", state), ...columnsOf("index", index), ...recordFields()];
      } finally {
        state.close();
        index.close();
      }
    } finally {
      storage?.cleanup();
    }
    const stored = found.filter((field) => STORAGE_NAME.test(field.split(".").at(-1) ?? ""));
    const allowed = Object.keys(ALLOWED);
    expect(stored.filter((field) => !allowed.includes(field))).toEqual([]);
    expect(allowed.filter((field) => !stored.includes(field))).toEqual([]);
  });
});
