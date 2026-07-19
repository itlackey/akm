// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import { parseAssetRef } from "../../core/asset/asset-ref";
import { parseRefInput } from "../../core/asset/resolve-ref";
import { loadConfig } from "../../core/config/config";
import { NotFoundError, UsageError } from "../../core/errors";
import { getDbPath } from "../../core/paths";
import { canonicalizeWorkflowName } from "../../core/recognition-util";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { resolveSourcesForOrigin } from "../../registry/origin-resolve";
import { resolveAssetPath } from "../../sources/resolve";
import type { WorkflowParameter, WorkflowStepDefinition } from "../../sources/types";
import { withIndexDb } from "../../storage/repositories/index-db";
import { formatWorkflowErrors } from "../authoring/authoring";
import { parseWorkflow } from "../parser";
import { parseWorkflowProgram } from "../program/parser";
import { isWorkflowProgramPath, projectProgramParameters, projectProgramStepDefinitions } from "../program/project";
import type { WorkflowProgram } from "../program/schema";
import type { WorkflowDocument } from "../schema";

/**
 * A workflow asset projected from its on-disk (or index-cached) document into
 * the shape the run repository needs to start and track a run.
 */
export type WorkflowAsset = {
  ref: string;
  path: string;
  sourcePath: string;
  title: string;
  parameters?: WorkflowParameter[];
  steps: WorkflowStepDefinition[];
  /**
   * The full parsed document, retained so the run engine can compile the
   * plan-graph IR (`workflows/ir/compile.ts`). Present for MARKDOWN
   * workflows only; YAML programs carry `program` instead.
   */
  document?: WorkflowDocument;
  /**
   * Parsed YAML workflow *program* (redesign addendum, R1). Present when the
   * asset is a YAML orchestration program under `workflows/`; undefined for
   * markdown workflows. The freeze boundary compiles and resolves it when a
   * run starts.
   */
  program?: WorkflowProgram;
};

/**
 * Resolve a `workflow:<name>` ref to a fully-projected {@link WorkflowAsset}.
 *
 * Prefers the parsed document cached in `index.db` (fast path) and falls back to
 * reading + parsing the source file from disk. Pure loading/parsing concern —
 * extracted from the run repository so run orchestration no longer owns asset
 * resolution.
 */
export async function loadWorkflowAsset(ref: string): Promise<WorkflowAsset> {
  const parsed = parseRefInput(ref);
  if (parsed.type !== "workflow") {
    throw new UsageError(`Expected a workflow ref (workflow:<name>), got "${ref}".`);
  }

  const config = loadConfig();
  const allSources = resolveSourceEntries(undefined, config);
  const searchSources = resolveSourcesForOrigin(parsed.origin, allSources);
  let assetPath: string | undefined;
  let sourcePath: string | undefined;

  for (const source of searchSources) {
    try {
      assetPath = await resolveAssetPath(source.path, "workflow", parsed.name);
      sourcePath = source.path;
      break;
    } catch {
      /* continue */
    }
  }

  if (!assetPath) {
    throw new NotFoundError(`Workflow not found for ref: workflow:${parsed.name}`);
  }

  const resolvedSourcePath = sourcePath ?? config.stashDir ?? assetPath;
  // Canonicalize the stored ref: `workflow:foo.yaml` and `workflow:foo`
  // resolve to the same file, so they MUST share one run identity. The raw
  // `parsed.name` (with any extension) is what drives file resolution above;
  // only the persisted/queried ref is collapsed (matches the index entry key,
  // which is keyed by the extension-stripped canonical name).
  const canonicalName = canonicalizeWorkflowName(parsed.name);
  const fullRef = `${parsed.origin ? `${parsed.origin}//` : ""}workflow:${canonicalName}`;

  // Format detection by extension: `.yaml`/`.yml` is a YAML workflow program
  // (redesign addendum, R1); everything else is the markdown document format.
  if (isWorkflowProgramPath(assetPath)) {
    const program = loadWorkflowProgramFromDisk(assetPath);
    return projectProgramAsset(program, fullRef, assetPath, resolvedSourcePath);
  }

  const cached = readWorkflowDocumentFromIndex(resolvedSourcePath, fullRef);
  const document = cached ?? loadWorkflowDocumentFromDisk(assetPath);
  return projectAsset(document, fullRef, assetPath, resolvedSourcePath);
}

/**
 * Resolve the `entries.id` for an indexed workflow, or null when the index
 * database does not yet exist or has no matching entry.
 */
export function resolveWorkflowEntryId(sourcePath: string, ref: string): number | null {
  if (!fs.existsSync(getDbPath())) return null;

  const parsed = parseAssetRef(ref);
  const entryKey = `${sourcePath}:${parsed.type}:${parsed.name}`;
  return withIndexDb((db) => {
    const row = db
      .prepare(
        `SELECT id
         FROM entries
         WHERE entry_type = 'workflow'
            AND entry_key = ?
          LIMIT 1`,
      )
      .get(entryKey) as { id: number } | undefined;
    return row?.id ?? null;
  });
}

function loadWorkflowProgramFromDisk(assetPath: string): WorkflowProgram {
  const content = fs.readFileSync(assetPath, "utf8");
  const result = parseWorkflowProgram(content, { path: assetPath });
  if (!result.ok) {
    throw new UsageError(formatWorkflowErrors(assetPath, result.errors));
  }
  return result.program;
}

function loadWorkflowDocumentFromDisk(assetPath: string): WorkflowDocument {
  const content = fs.readFileSync(assetPath, "utf8");
  const result = parseWorkflow(content, { path: assetPath });
  if (!result.ok) {
    throw new UsageError(formatWorkflowErrors(assetPath, result.errors));
  }
  return result.document;
}

function readWorkflowDocumentFromIndex(sourcePath: string, ref: string): WorkflowDocument | null {
  if (!fs.existsSync(getDbPath())) return null;

  const parsed = parseAssetRef(ref);
  const entryKey = `${sourcePath}:${parsed.type}:${parsed.name}`;
  return withIndexDb((db) => {
    const row = db
      .prepare(
        `SELECT wd.document_json AS document_json
           FROM workflow_documents wd
           JOIN entries e ON e.id = wd.entry_id
          WHERE e.entry_type = 'workflow' AND e.entry_key = ?
          LIMIT 1`,
      )
      .get(entryKey) as { document_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.document_json) as WorkflowDocument;
    } catch {
      return null;
    }
  });
}

function projectAsset(doc: WorkflowDocument, ref: string, assetPath: string, sourcePath: string): WorkflowAsset {
  return {
    ref,
    path: assetPath,
    sourcePath,
    title: doc.title,
    ...(doc.parameters
      ? {
          parameters: doc.parameters.map((p) => ({
            name: p.name,
            ...(p.description ? { description: p.description } : {}),
          })),
        }
      : {}),
    steps: doc.steps.map((s) => ({
      id: s.id,
      title: s.title,
      instructions: s.instructions.text,
      ...(s.completionCriteria ? { completionCriteria: s.completionCriteria.map((c) => c.text) } : {}),
      sequenceIndex: s.sequenceIndex,
    })),
    document: doc,
  };
}

/**
 * Project a parsed YAML program into the run-repository asset shape. Step
 * instructions carry the RAW `${{ … }}` templates — resolution happens in
 * the engine against the frozen plan, never here.
 */
function projectProgramAsset(
  program: WorkflowProgram,
  ref: string,
  assetPath: string,
  sourcePath: string,
): WorkflowAsset {
  const parameters = projectProgramParameters(program);
  return {
    ref,
    path: assetPath,
    sourcePath,
    title: program.name,
    ...(parameters ? { parameters } : {}),
    steps: projectProgramStepDefinitions(program),
    program,
  };
}
