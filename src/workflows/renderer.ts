/**
 * Show + indexing renderer for workflow assets.
 *
 * Reads the markdown via `parseWorkflow` and projects the validated
 * `WorkflowDocument` down to the public `ShowResponse` shape (which still
 * uses the flat `WorkflowStepDefinition` type for backwards compatibility)
 * and into search hints for the indexer.
 */

import { makeAssetRef } from "../core/asset-ref";
import { UsageError } from "../core/errors";
import type { AssetRenderer, RenderContext } from "../indexer/file-context";
import type { StashEntry } from "../indexer/metadata";
import type { ShowResponse } from "../sources/types";
import { cacheWorkflowDocument } from "./document-cache";
import { parseWorkflow } from "./parser";
import type { WorkflowDocument } from "./schema";

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

  extractMetadata(entry: StashEntry, ctx: RenderContext): void {
    const doc = loadDocument(ctx);
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
};
