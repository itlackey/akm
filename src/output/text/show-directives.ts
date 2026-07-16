// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm show` agent-directive emission.
 *
 * Extracted from `formatShowPlain` (formerly the largest function in
 * `helpers.ts`): once the base show content is assembled, this module
 * appends the REC-01/REC-09 APPLY / show-loop / workflow-active directive
 * blocks that tell the calling agent how to act on the rendered asset.
 * Directive strings are byte-identical to the pre-extraction version —
 * only the seam moved.
 */

/**
 * Append the type-specific agent directive block to an in-progress
 * `formatShowPlain` render. Mutates `lines` in place (matches the original
 * inline behavior — push/unshift/splice all operate on the same array the
 * caller continues to join afterward).
 */
export function appendShowDirectives(lines: string[], r: Record<string, unknown>): void {
  // REC-01 / REC-09: Append a type-specific directive so agents apply the
  // content rather than substituting training-data approximations.
  const assetType = typeof r.type === "string" ? r.type : null;
  const assetRef = typeof r.name === "string" && assetType ? `${assetType}:${r.name}` : null;

  // Show-loop detection: if the agent has shown this asset 3+ times without
  // writing anything, surface a warning so it stops cycling and acts.
  const showLoopCount = typeof r.showLoopWarning === "number" ? r.showLoopWarning : 0;
  if (showLoopCount >= 3) {
    lines.push("");
    lines.push(`WARNING: You have shown this asset ${showLoopCount} times without completing the task.`);
    lines.push("Stop re-reading — you have the information you need. Act on it now:");
    lines.push("  - Write your output file using the content above.");
    lines.push(
      `  - If this asset does not contain what you need, run \`akm feedback '${assetRef ?? "<ref>"}' --negative\` and search for a different asset.`,
    );
  }

  if (assetType === "skill" || assetType === "knowledge") {
    const activeRun = r.activeRun as { runId: string; stepId: string | null; workflowRef: string } | null | undefined;
    if (activeRun) {
      // Active workflow: redirect agent to workflow commands instead of direct apply
      lines.unshift(
        `  akm workflow complete '${activeRun.runId}'${activeRun.stepId ? ` --step '${activeRun.stepId}'` : ""}`,
      );
      lines.unshift(
        "Read this schema, then follow your workflow step's instructions to edit the workspace file. When done, mark the step complete:",
      );
      lines.unshift(`WORKFLOW ACTIVE — schema shown as reference (run: ${activeRun.runId})`);
      lines.unshift("---");
      lines.unshift("");
      // Still show feedback line at the end but skip the APPLY directive
      lines.push("");
      lines.push(
        `Run \`akm feedback ${assetRef ? `'${assetRef}'` : "<ref>"} --positive\` if the step succeeds, or \`--negative\` if this schema did not help.`,
      );
    } else {
      // No active workflow: show the APPLY directive. Branch on whether this
      // skill primarily teaches CLI commands (shell output) vs YAML schema.
      const preApplyLines = [...lines];
      lines.push("");
      lines.push("---");
      if (isCommandOutputSkill(preApplyLines)) {
        lines.push("APPLY (only if no workflow step is required for this task):");
        lines.push("  1. Identify the output file from README.md (typically commands.txt).");
        lines.push(
          "  2. Write the exact command syntax from the code blocks above — replace every placeholder (`<name>`, `<value>`) with a real, concrete value from your task context. Do not write placeholder text.",
        );
        lines.push(
          "  3. Each command should be on a single line (no backslash line continuation unless the verifier expects it).",
        );
        lines.push(
          `Run \`akm feedback ${assetRef ? `'${assetRef}'` : "<ref>"} --positive\` after the task succeeds, or \`--negative\` if this reference did not contain the needed command syntax.`,
        );
      } else {
        lines.push("APPLY (only if no workflow step is required for this task):");
        lines.push(
          "  1. Identify the target file from README.md — write or edit it. If the file does not yet exist, CREATE it with the full structure from this schema.",
        );
        lines.push("  2. Add/edit the fields shown above using the exact field names from this schema.");
        lines.push(
          "  3. COPY the exact YAML structure and field names from the code blocks above — do not substitute synonyms or invent nesting. Replace every placeholder value with a real, concrete value from your task context. Do not leave any field as null, empty, or a placeholder.",
        );
        lines.push(
          `Run \`akm feedback ${assetRef ? `'${assetRef}'` : "<ref>"} --positive\` after the task succeeds, or \`--negative\` if the task fails after following this guidance.`,
        );
      }
    }
  } else if (assetType === "workflow") {
    const workflowName = typeof r.name === "string" ? r.name : null;
    const workflowRef = workflowName ? `workflow:${workflowName}` : "<ref>";
    // Insert action directive BEFORE the workflow content by prepending to lines at the
    // separator position. We find where the header ends and insert after the first `---`.
    // Since lines already contain the full content at this point, we locate the insertion
    // index: right after the first `---` separator if present, otherwise after the header.
    const separatorIdx = lines.indexOf("---");
    const insertIdx = separatorIdx >= 0 ? separatorIdx + 1 : r.type || r.name ? 1 : 0;
    const actionDirective = [
      `ACTION REQUIRED: Do not execute steps manually from this output.`,
      `Run \`akm workflow next '${workflowRef}'\` to get your current step with exact instructions.`,
      "---",
    ];
    lines.splice(insertIdx, 0, "", ...actionDirective);
    lines.push("");
    lines.push("---");
    lines.push(`NEXT STEP: Run \`akm workflow next '${workflowRef}'\` to see the current workflow step.`);
    lines.push("Do not edit workspace files before completing each step with `akm workflow complete`.");
  }
}

/**
 * Detect whether a skill's rendered content primarily teaches CLI commands
 * rather than YAML schema. Used to select the right APPLY directive variant.
 *
 * Heuristic: count code-block lines that start with known shell command
 * prefixes vs lines that look like YAML key-value pairs. If CLI lines
 * outnumber YAML lines (and there is at least one CLI line), treat the
 * skill as command-output.
 */
function isCommandOutputSkill(lines: string[]): boolean {
  const codeLines = lines.filter((l) => l.startsWith("  ") || l.startsWith("\t") || /^`/.test(l));
  const cliPattern = /^(az |kubectl |docker |git |helm |terraform |aws |gcloud )/;
  const yamlPattern = /^\s+\w+:/;
  const cliCount = codeLines.filter((l) => cliPattern.test(l.trim())).length;
  const yamlCount = codeLines.filter((l) => yamlPattern.test(l)).length;
  return cliCount > yamlCount && cliCount > 0;
}
