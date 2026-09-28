// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm-task` adapter for task `.yml` sources.
 *
 * A native akm task-YAML bundle (spec §6/§7). A `.yml` file derives
 * `type: task`; conceptId strips the `.yml` extension. Tasks are AKM-native
 * YAML, NOT OKF markdown concepts. Recognition does NOT gate on validity — an
 * invalid task (e.g. `uses` plus `run`) is still RECOGNIZED; the `invalid-task-yaml`
 * violation surfaces only in `validate`.
 *
 * `.yaml` is the one extension `validate` inspects but `recognize` refuses: it
 * is not a task spelling (nothing indexes or schedules it), so it is reported
 * as `invalid-task-yaml` rather than silently skipped (issue #760).
 *
 * ── validate (spec §6 task validation column) ──
 *
 * Validation enters the canonical task source parser (`parseTaskSource`,
 * which reads only task source v4 — a `version: 2` or `version: 3`
 * document fails closed with `TASK_SCHEMA_VERSION_UNSUPPORTED`, naming
 * `akm migrate apply`, which converts it). That parser owns the closed key sets,
 * the executable-selector XOR, hostile YAML policy, the `akm/command`
 * builtin, bounds, and physical `working-directory` containment. The
 * adapter only translates a parser failure into the format-family
 * diagnostic shape.
 *
 * Conformance oracle (authored, DO NOT modify): fixture
 * `tests/fixtures/bundles/akm-task/` + goldens
 * `tests/fixtures/format-family-goldens/akm-task/{recognition,placement,lint,renderer}.json`.
 */

import fs from "node:fs";
import path from "node:path";
import type { FileContext } from "../../../indexer/walk/file-context";
import { readBoundedTaskSourceYaml } from "../../../tasks/source/bounded-document";
import { parseTaskSource, peekTaskSourceVersion } from "../../../tasks/source/parse-task-source";
import {
  TASK_EXTENSION,
  TASK_NEAR_MISS_EXTENSION,
  taskExtensionDetail,
  taskSourceErrorDetail,
} from "../../../tasks/source-v3";
import { toPosix } from "../../common";
import type { FileChange } from "../../file-change";
import type { BundleAdapter } from "../bundle-adapter";
import type { BundleComponent, Diagnostic, IndexDocument, ValidateContext } from "../types";
import { hashContent } from "./shared";

/** A native task bundle is single-component; its one component is `main`. */
const COMPONENT_ID = "main";
/** The task YAML extension (spec §6 task row). */
const TASK_EXT = TASK_EXTENSION;

function recognize(c: BundleComponent, file: FileContext): IndexDocument | null {
  if (file.ext !== TASK_EXT) return null;
  const conceptId = toPosix(file.relPath).replace(/\.yml$/i, "");
  const name = conceptId.split("/").pop() ?? conceptId;
  const raw = file.content();

  return {
    ref: `${c.id}//${conceptId}`,
    bundle: c.id,
    component: COMPONENT_ID,
    conceptId,
    path: file.absPath,
    hash: hashContent(raw),
    adapterId: "akm-task",
    type: "task",
    name,
    content: raw,
  };
}

async function validate(c: BundleComponent, changes: FileChange[], ctx: ValidateContext): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const change of changes) {
    if (change.op === "delete") continue;
    const raw = change.after ?? (await ctx.readFile(change.path));
    if (typeof raw !== "string") continue;
    const ext = path.extname(change.path).toLowerCase();
    // `.yaml` is NOT a task extension — the file never indexes and never runs.
    // It is validated here purely so the near miss is REPORTED rather than
    // skipped the way every other extension is (issue #760).
    if (ext !== TASK_EXT && ext !== TASK_NEAR_MISS_EXTENSION) continue;
    const relPath = toPosix(change.path);
    if (ext === TASK_NEAR_MISS_EXTENSION) {
      diagnostics.push({
        file: relPath,
        issue: "invalid-task-yaml",
        detail: taskExtensionDetail(relPath),
        fixed: false,
      });
      continue;
    }
    try {
      parseTaskSource({ yaml: raw, filePath: relPath, workspaceRoot: c.root });
    } catch (cause) {
      diagnostics.push({
        file: relPath,
        issue: "invalid-task-yaml",
        detail: taskSourceErrorDetail(cause),
        fixed: false,
      });
    }
  }
  return diagnostics;
}

export const akmTaskAdapter: BundleAdapter = {
  id: "akm-task",
  version: "0.9.2",
  // `.yaml` is listed as a COLLECTION hint only — `recognize` still gates on
  // `.yml`, so a `.yaml` file is never indexed as a task. Listing it is what
  // routes the near-miss file into `validate`, where it is reported instead of
  // silently skipped (issue #760).
  extensions: [TASK_EXT, TASK_NEAR_MISS_EXTENSION],

  recognize,
  validate,

  readCandidates(c: BundleComponent, conceptId: string) {
    const posix = toPosix(conceptId).replace(/\.ya?ml$/i, "");
    return [
      { path: path.join(c.root, `${posix}.yml`), conceptId: posix },
      { path: path.join(c.root, `${posix}.yaml`), conceptId: posix },
    ];
  },

  /** A task places to `<conceptId>.yml`; an already-suffixed conceptId is idempotent. */
  placeNew(c: BundleComponent, conceptId: string): string {
    const posix = toPosix(conceptId);
    return path.join(c.root, /\.yml$/i.test(posix) ? posix : `${posix}.yml`);
  },

  /** Tasks live anywhere under the component root. */
  directoryList(): string[] {
    return ["."];
  },

  /**
   * Install-time probe (§1.2): a root holding a top-level, valid task source
   * v4 `.yml` file, or a task v2/v3 file that `akm migrate apply` has yet to
   * convert (the runtime refuses those, so without this the migrator and
   * `akm task sync` would not find them in a bundle whose adapter config does
   * not record). The full parser keeps this disjoint from unrelated YAML and
   * prevents probe semantics from drifting from validation semantics.
   */
  looksLikeRoot(root: string): boolean {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== TASK_EXT) continue;
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(root, entry.name), "utf8");
      } catch {
        continue;
      }
      try {
        parseTaskSource({ yaml: raw, filePath: entry.name, workspaceRoot: root });
        return true;
      } catch {
        if (isLegacyTaskDocument(raw, entry.name)) return true;
        // Continue probing the remaining top-level .yml files.
      }
    }
    return false;
  },
};

/** The executable keys each retired task schema version required one of. */
const LEGACY_TASK_TARGET_KEYS: Readonly<Record<number, readonly string[]>> = {
  2: ["workflow", "prompt", "command"],
  3: ["uses", "run"],
};

/** A task v2/v3 document: its schema version, plus a target key that version used. */
function isLegacyTaskDocument(yaml: string, filePath: string): boolean {
  let root: unknown;
  try {
    root = readBoundedTaskSourceYaml({ yaml, filePath }, { sourceLabel: "task source" }).root;
  } catch {
    return false;
  }
  const keys = LEGACY_TASK_TARGET_KEYS[peekTaskSourceVersion(root) ?? 0];
  return keys !== undefined && keys.some((key) => Object.hasOwn(root as object, key));
}
