// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm show` plain-text renderer.
 *
 * Split out of `helpers.ts` (formerly 1418 lines / 59 fns) as its own
 * sibling module: `formatShowPlain` is the single largest formatter in the
 * file. Agent-directive emission (APPLY / show-loop / workflow-active
 * blocks) lives in the sibling `show-directives.ts`.
 */

import type { DetailLevel } from "../context";
import { appendShowDirectives } from "./show-directives";

export function formatShowPlain(r: Record<string, unknown>, detail: DetailLevel): string | null {
  const lines: string[] = [];
  if (r.type || r.name) {
    lines.push(`# ${String(r.type ?? "asset")}: ${String(r.name ?? "unknown")}`);
  }
  if (r.path && r.editable !== false) {
    lines.push(`file: ${String(r.path)}`);
  }
  if (r.origin !== undefined) lines.push(`# origin: ${String(r.origin)}`);
  if (r.action) lines.push(`# ${String(r.action)}`);
  if (r.description) lines.push(`description: ${String(r.description)}`);
  if (r.workflowTitle) lines.push(`workflowTitle: ${String(r.workflowTitle)}`);
  if (r.agent) lines.push(`agent: ${String(r.agent)}`);
  if (Array.isArray(r.parameters) && r.parameters.length > 0) lines.push(`parameters: ${r.parameters.join(", ")}`);
  if (Array.isArray(r.workflowParameters) && r.workflowParameters.length > 0) {
    lines.push("workflowParameters:");
    for (const parameter of r.workflowParameters as Array<Record<string, unknown>>) {
      const name = typeof parameter.name === "string" ? parameter.name : "unknown";
      const description =
        typeof parameter.description === "string" && parameter.description.trim() ? `: ${parameter.description}` : "";
      lines.push(`  - ${name}${description}`);
    }
  }
  if (r.modelHint != null) lines.push(`modelHint: ${String(r.modelHint)}`);
  if (r.toolPolicy != null) lines.push(`toolPolicy: ${JSON.stringify(r.toolPolicy)}`);
  if (r.run) lines.push(`run: ${String(r.run)}`);
  if (r.setup) lines.push(`setup: ${String(r.setup)}`);
  if (r.cwd) lines.push(`cwd: ${String(r.cwd)}`);
  if (detail === "full") {
    if (r.path) lines.push(`path: ${String(r.path)}`);
    if (r.editable !== undefined) lines.push(`editable: ${String(r.editable)}`);
    if (r.editHint) lines.push(`editHint: ${String(r.editHint)}`);
    if (r.schemaVersion !== undefined) lines.push(`schemaVersion: ${String(r.schemaVersion)}`);
  }
  const related =
    typeof r.related === "object" && r.related !== null ? (r.related as Record<string, unknown>) : undefined;
  const relatedHits = related && Array.isArray(related.hits) ? (related.hits as Array<Record<string, unknown>>) : [];
  if (related) {
    lines.push("");
    lines.push(`related: ${String(related.total ?? relatedHits.length)}`);
    for (const hit of relatedHits) {
      lines.push(`  - ${String(hit.type ?? "?")}: ${formatRelatedLabel(hit)}`);
      const shared = Array.isArray(hit.sharedEntities) ? (hit.sharedEntities as unknown[]).map(String) : [];
      if (shared.length > 0) lines.push(`    shared: ${shared.join(", ")}`);
      lines.push(`    relationCount: ${String(hit.relationCount ?? 0)}`);
    }
  }
  const payloads = [r.content, r.template, r.prompt].filter((value) => value != null).map(String);
  if (Array.isArray(r.steps) && r.steps.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("steps:");
    for (const [index, step] of (r.steps as Array<Record<string, unknown>>).entries()) {
      const title = typeof step.title === "string" ? step.title : "Untitled step";
      const id = typeof step.id === "string" ? step.id : "unknown";
      lines.push(`  ${index + 1}. ${title} [${id}]`);
      if (typeof step.instructions === "string" && step.instructions.trim()) {
        const instrLines = step.instructions.trim().split("\n");
        lines.push(`     instructions: ${instrLines[0]}`);
        for (const instrLine of instrLines.slice(1)) lines.push(`       ${instrLine}`);
      }
      if (Array.isArray(step.completionCriteria) && step.completionCriteria.length > 0) {
        lines.push("     completion:");
        for (const criterion of step.completionCriteria) {
          lines.push(`       - ${String(criterion)}`);
        }
      }
    }
  }
  if (payloads.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(...payloads);
  }

  appendShowDirectives(lines, r);

  return lines.length > 0 ? lines.join("\n") : null;
}

function formatRelatedLabel(hit: Record<string, unknown>): string {
  const ref = typeof hit.ref === "string" ? hit.ref : undefined;
  if (ref) return ref;
  const pathValue = typeof hit.path === "string" ? hit.path : "?";
  return pathValue.split("/").pop() ?? pathValue;
}
