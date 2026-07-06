// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Show + indexing renderer for workflow assets.
 *
 * Reads the markdown via `parseWorkflow` and projects the validated
 * `WorkflowDocument` down to the public `ShowResponse` shape (which still
 * uses the flat `WorkflowStepDefinition` type for backwards compatibility)
 * and into search hints for the indexer.
 */

import { makeAssetRef } from "../core/asset/asset-ref";
import { UsageError } from "../core/errors";
import type { StashEntry } from "../indexer/passes/metadata";
import { registerMetadataContributor } from "../indexer/passes/metadata-contributors";
import type { AssetRenderer, RenderContext } from "../indexer/walk/file-context";
import type { ShowResponse, WorkflowStepOrchestrationSummary } from "../sources/types";
import { parseWorkflow } from "./parser";
import { cacheWorkflowDocument } from "./runtime/document-cache";
import type { WorkflowDocument, WorkflowStepOrchestration } from "./schema";

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
        ...(s.orchestration ? { orchestration: summarizeOrchestration(s.orchestration) } : {}),
      })),
    };
  },
};

/** Project parsed orchestration into the compact show-facing summary. */
function summarizeOrchestration(orch: WorkflowStepOrchestration): WorkflowStepOrchestrationSummary {
  return {
    ...(orch.runner ? { runner: orch.runner } : {}),
    ...(orch.profile ? { profile: orch.profile } : {}),
    ...(orch.model ? { model: orch.model } : {}),
    ...(orch.timeoutMs !== undefined ? { timeoutMs: orch.timeoutMs } : {}),
    ...(orch.fanOut ? { fanOut: { ...orch.fanOut } } : {}),
    ...(orch.schema ? { hasSchema: true } : {}),
    ...(orch.env ? { env: [...orch.env] } : {}),
    ...(orch.dependsOn ? { dependsOn: [...orch.dependsOn] } : {}),
    ...(orch.route
      ? {
          route: {
            input: orch.route.input,
            branches: orch.route.branches.map((b) => ({ ...b })),
            ...(orch.route.defaultStepId ? { defaultStepId: orch.route.defaultStepId } : {}),
          },
        }
      : {}),
  };
}

registerMetadataContributor({
  name: "workflow-document-metadata",
  appliesTo: ({ rendererName }) => rendererName === "workflow-md",
  contribute(entry: StashEntry, { renderContext }: { renderContext: RenderContext }) {
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
