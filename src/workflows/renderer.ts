// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Show + indexing renderers for workflow assets.
 *
 * Two formats, one asset type:
 *
 *   - `workflow-md` — reads the classic linear markdown via `parseWorkflow`
 *     and projects the validated `WorkflowDocument` down to the public
 *     `ShowResponse` shape (which still uses the flat
 *     `WorkflowStepDefinition` type for backwards compatibility) and into
 *     search hints for the indexer.
 *   - `workflow-program-yaml` — reads a YAML workflow *program* (redesign
 *     addendum, R1) via `parseWorkflowProgram` and projects it through
 *     `program/project.ts`, including a compact orchestration summary per
 *     step (runner/model, `fanOut.over` expression, route table).
 */

import { makeAssetRef } from "../core/asset/asset-ref";
import { UsageError } from "../core/errors";
import type { IndexDocument } from "../indexer/passes/metadata";
import { registerMetadataContributor } from "../indexer/passes/metadata-contributors";
import type { AssetRenderer, RenderContext } from "../indexer/walk/file-context";
import type { ShowResponse } from "../sources/types";
import { parseWorkflow } from "./parser";
import { parseWorkflowProgram } from "./program/parser";
import {
  programStepInstructions,
  projectProgramParameters,
  summarizeProgramStepOrchestration,
  WORKFLOW_PROGRAM_RENDERER_NAME,
} from "./program/project";
import type { WorkflowProgram } from "./program/schema";
import { cacheWorkflowDocument } from "./runtime/document-cache";
import type { WorkflowDocument } from "./schema";

export { WORKFLOW_PROGRAM_RENDERER_NAME };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildWorkflowAction(ref: string): string {
  return `Resume the active run or start a new run with \`akm workflow next ${shellQuote(ref)}\`.`;
}

function deriveName(ctx: RenderContext): string {
  const metaName = ctx.matchResult.meta?.name;
  if (typeof metaName === "string" && metaName) return metaName;
  const ext = ctx.relPath.lastIndexOf(".");
  return ext > 0 ? ctx.relPath.slice(0, ext) : ctx.relPath;
}

function loadDocument(ctx: RenderContext): WorkflowDocument {
  const result = parseWorkflow(ctx.content(), { path: ctx.relPath });
  if (result.ok) return result.document;
  const summary = result.errors.map((e) => `${ctx.relPath}:${e.line} — ${e.message}`).join("\n");
  throw new UsageError(`Workflow has errors:\n${summary}`);
}

export const workflowMdRenderer: AssetRenderer = {
  name: "workflow-md",

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const doc = loadDocument(ctx);
    const ref = makeAssetRef("workflow", name, ctx.origin);
    return {
      type: "workflow",
      name,
      path: ctx.absPath,
      action: buildWorkflowAction(ref),
      description: doc.description,
      workflowTitle: doc.title,
      parameters: doc.parameters?.map((p) => p.name),
      workflowParameters: doc.parameters?.map((p) => ({ name: p.name, description: p.description })),
      steps: doc.steps.map((s) => ({
        id: s.id,
        title: s.title,
        instructions: s.instructions.text,
        ...(s.completionCriteria ? { completionCriteria: s.completionCriteria.map((c) => c.text) } : {}),
        sequenceIndex: s.sequenceIndex,
      })),
    };
  },
};

function loadProgram(ctx: RenderContext): WorkflowProgram {
  const result = parseWorkflowProgram(ctx.content(), { path: ctx.relPath });
  if (result.ok) return result.program;
  const summary = result.errors.map((e) => `${ctx.relPath}:${e.line} — ${e.message}`).join("\n");
  throw new UsageError(`Workflow has errors:\n${summary}`);
}

/** Show renderer for YAML workflow programs — mirrors `workflowMdRenderer`. */
export const workflowProgramRenderer: AssetRenderer = {
  name: WORKFLOW_PROGRAM_RENDERER_NAME,

  buildShowResponse(ctx: RenderContext): ShowResponse {
    const name = deriveName(ctx);
    const program = loadProgram(ctx);
    const ref = makeAssetRef("workflow", name, ctx.origin);
    const parameters = projectProgramParameters(program);
    return {
      type: "workflow",
      name,
      path: ctx.absPath,
      action: buildWorkflowAction(ref),
      description: program.description,
      workflowTitle: program.name,
      ...(parameters ? { parameters: parameters.map((p) => p.name), workflowParameters: parameters } : {}),
      steps: program.steps.map((step, index) => {
        const orchestration = summarizeProgramStepOrchestration(step, program.defaults);
        return {
          id: step.id,
          title: step.title ?? step.id,
          instructions: programStepInstructions(step),
          ...(step.gate ? { completionCriteria: [...step.gate.criteria] } : {}),
          sequenceIndex: index,
          ...(orchestration ? { orchestration } : {}),
        };
      }),
    };
  },
};

registerMetadataContributor({
  name: "workflow-document-metadata",
  appliesTo: ({ rendererName }) => rendererName === "workflow-md",
  contribute(entry: IndexDocument, { renderContext }: { renderContext: RenderContext }) {
    const doc = loadDocument(renderContext);
    const hints = new Set<string>(entry.searchHints ?? []);
    hints.add(doc.title);
    for (const step of doc.steps) {
      hints.add(step.title);
      hints.add(step.id);
      hints.add(step.instructions.text);
      for (const criterion of step.completionCriteria ?? []) {
        hints.add(criterion.text);
      }
    }
    entry.searchHints = Array.from(hints).filter(Boolean);
    if (doc.parameters?.length) {
      entry.parameters = doc.parameters.map((p) => ({
        name: p.name,
        ...(p.description ? { description: p.description } : {}),
      }));
    }
    cacheWorkflowDocument(entry, doc);
  },
});

registerMetadataContributor({
  name: "workflow-program-metadata",
  appliesTo: ({ rendererName }) => rendererName === WORKFLOW_PROGRAM_RENDERER_NAME,
  contribute(entry: IndexDocument, { renderContext }: { renderContext: RenderContext }) {
    // Parse failures throw, which the metadata pass turns into a
    // skip-with-warning — broken programs never land in the index, mirroring
    // markdown workflows. No workflow_documents cache row is written: YAML
    // programs are re-parsed from disk by the runtime loader.
    const program = loadProgram(renderContext);
    const hints = new Set<string>(entry.searchHints ?? []);
    hints.add(program.name);
    for (const step of program.steps) {
      hints.add(step.id);
      if (step.title) hints.add(step.title);
      hints.add(programStepInstructions(step));
      for (const criterion of step.gate?.criteria ?? []) {
        hints.add(criterion);
      }
    }
    entry.searchHints = Array.from(hints).filter(Boolean);
    if (!entry.description && program.description) {
      entry.description = program.description;
    }
    const parameters = projectProgramParameters(program);
    if (parameters?.length) {
      entry.parameters = parameters;
    }
  },
});
