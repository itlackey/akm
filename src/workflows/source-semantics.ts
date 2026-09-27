// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Semantic checks shared by the workflow grammars (`parser.ts`, `github-yaml.ts`) and freeze. */

import fs from "node:fs";
import path from "node:path";
import { type ParsedBuiltinCommandAction, parseBuiltinCommandAction } from "../commands/command/builtin-action";
import { classifyTargetRef } from "../execution/target-ref";
import { parseSchedule } from "../tasks/schedule";
import type { WorkflowCommandMode } from "./plan";

/** A `uses:` target: an executable asset ref, or AKM's built-in `akm/command`. */
export type WorkflowUsesTarget =
  | { readonly kind: "command" | "script" | "task" | "workflow"; readonly ref: string }
  | { readonly kind: "builtin-command"; readonly ref: "akm/command" };

export class WorkflowSourceSemanticError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowSourceSemanticError";
  }
}

/** The argv a `run:` string executes under `shell`. */
export function workflowShellCommand(shell: string, content: string): string[] {
  if (shell === "cmd") return ["cmd", "/d", "/s", "/c", content];
  if (shell === "pwsh" || shell === "powershell") return [shell, "-Command", content];
  return [shell, "-c", content];
}

export function canonicalizeWorkflowCron(value: string): string {
  const canonical = value.trim().split(/\s+/).join(" ");
  if (canonical.startsWith("@") || canonical.split(" ").length !== 5) {
    throw new WorkflowSourceSemanticError("invalid-cron", "GitHub schedule cron must use exactly five fields.");
  }
  try {
    parseSchedule(canonical, "cron");
  } catch (cause) {
    throw new WorkflowSourceSemanticError(
      "invalid-cron",
      cause instanceof Error ? cause.message : "Invalid cron schedule.",
    );
  }
  return canonical;
}

export function canonicalizeWorkflowRun(value: string): string {
  if (value.includes("${{")) {
    throw new WorkflowSourceSemanticError(
      "unsupported-github-expression",
      "GitHub expressions and contexts are not supported.",
    );
  }
  if (value.includes("\0")) {
    throw new WorkflowSourceSemanticError("invalid-exec-argv", "Local run may not contain NUL bytes.");
  }
  return value;
}

export function canonicalizeWorkflowWorkingDirectory(value: string, workspaceRoot?: string): string {
  if (hasControlCharacter(value)) {
    throw new WorkflowSourceSemanticError(
      "working-directory-control-character",
      "working-directory may not contain NUL or control characters.",
    );
  }
  if (value === "" || value.trim() === "") {
    throw new WorkflowSourceSemanticError(
      "working-directory-escape",
      "working-directory must be a non-empty relative contained path.",
    );
  }
  const portable = value.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (
    path.posix.isAbsolute(portable) ||
    path.win32.isAbsolute(value) ||
    portable.startsWith("~") ||
    segments.some((segment) => segment === "" || segment === "..")
  ) {
    throw new WorkflowSourceSemanticError(
      "working-directory-escape",
      "working-directory must be relative and contained.",
    );
  }
  const withoutDots = segments.filter((segment) => segment !== ".");
  const canonical = withoutDots.length === 0 ? "." : withoutDots.join("/");
  if (workspaceRoot !== undefined) verifyPhysicalContainment(workspaceRoot, canonical);
  return canonical;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

export function classifyWorkflowStepUses(value: string): WorkflowUsesTarget {
  if (value.includes("${{")) {
    throw new WorkflowSourceSemanticError(
      "unsupported-github-expression",
      "GitHub expressions are unsupported in uses.",
    );
  }
  if (value.length === 0 || value.trim() !== value || /\s/.test(value)) {
    throw new WorkflowSourceSemanticError(
      "unsupported-uses-target",
      "uses must be one exact, non-empty executable ref",
    );
  }
  if (value === "akm/command") return { kind: "builtin-command", ref: "akm/command" };
  try {
    return classifyTargetRef(value);
  } catch (cause) {
    throw usesFailure(value, cause);
  }
}

/**
 * Validate AKM's built-in command action at the shared source/decoder boundary.
 *
 * Inline YAML actions are portable templates and therefore use WP4's one
 * authoritative template validator. Markdown prose is explicitly `literal`,
 * while a stored ref remains resolution-owned because its template bytes are
 * not available until the later resolver loads the command asset.
 */
export function validateWorkflowBuiltinCommand(value: unknown, mode?: WorkflowCommandMode): ParsedBuiltinCommandAction {
  let action: ParsedBuiltinCommandAction;
  try {
    action = parseBuiltinCommandAction(value);
  } catch (cause) {
    throw new WorkflowSourceSemanticError(
      "builtin-command-inputs",
      cause instanceof Error ? cause.message : "Invalid akm/command inputs.",
    );
  }

  const expectedMode: WorkflowCommandMode = action.kind === "stored" ? "stored-ref" : "portable-template";
  const effectiveMode = mode ?? expectedMode;
  if (action.kind === "stored") {
    if (effectiveMode !== "stored-ref") {
      throw new WorkflowSourceSemanticError(
        "builtin-command-inputs",
        "Stored akm/command refs require commandMode stored-ref.",
      );
    }
    return action;
  }
  if (effectiveMode === "stored-ref") {
    throw new WorkflowSourceSemanticError(
      "builtin-command-inputs",
      "Inline akm/command content cannot use commandMode stored-ref.",
    );
  }
  if (effectiveMode === "literal" && action.arguments !== undefined) {
    throw new WorkflowSourceSemanticError(
      "builtin-command-inputs",
      "Literal akm/command content cannot declare arguments because no substitution occurs.",
    );
  }
  return action;
}

function usesFailure(value: string, cause: unknown): WorkflowSourceSemanticError {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = value.startsWith("docker://")
    ? "docker-action-unsupported"
    : value.startsWith("./") || value.startsWith("../") || value.startsWith("/")
      ? "local-action-path-unsupported"
      : /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/\/)?agents\//.test(value)
        ? "non-executable-asset-ref"
        : "unsupported-uses-target";
  return new WorkflowSourceSemanticError(code, message);
}

function verifyPhysicalContainment(workspaceRoot: string, relative: string): void {
  let root: string;
  try {
    root = fs.realpathSync(workspaceRoot);
  } catch {
    throw new WorkflowSourceSemanticError(
      "working-directory-unverifiable",
      "Workspace root cannot be physically verified.",
    );
  }
  const candidate = path.resolve(root, ...relative.split("/"));
  if (!contained(root, candidate)) {
    throw new WorkflowSourceSemanticError("working-directory-escape", "working-directory escapes the workspace.");
  }

  let current = root;
  for (const segment of relative === "." ? [] : relative.split("/")) {
    current = path.join(current, segment);
    try {
      const entry = fs.lstatSync(current);
      if (entry.isSymbolicLink()) {
        let physical: string;
        try {
          physical = fs.realpathSync(current);
        } catch {
          throw new WorkflowSourceSemanticError(
            "working-directory-unverifiable",
            "working-directory contains a dangling or unresolvable symlink.",
          );
        }
        if (!contained(root, physical)) {
          throw new WorkflowSourceSemanticError(
            "working-directory-escape",
            "working-directory resolves through a symlink outside the workspace.",
          );
        }
        let target: fs.Stats;
        try {
          target = fs.statSync(current);
        } catch {
          throw new WorkflowSourceSemanticError(
            "working-directory-unverifiable",
            "working-directory symlink target cannot be physically verified.",
          );
        }
        if (!target.isDirectory()) {
          throw new WorkflowSourceSemanticError(
            "working-directory-unverifiable",
            "working-directory must resolve through directories.",
          );
        }
        continue;
      }
      if (!entry.isDirectory()) {
        throw new WorkflowSourceSemanticError(
          "working-directory-unverifiable",
          "working-directory must resolve through directories.",
        );
      }
      const physical = fs.realpathSync(current);
      if (!contained(root, physical)) {
        throw new WorkflowSourceSemanticError(
          "working-directory-escape",
          "working-directory resolves through a symlink outside the workspace.",
        );
      }
    } catch (cause) {
      if (cause instanceof WorkflowSourceSemanticError) throw cause;
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        // A genuinely absent lexical component is allowed at source time; the
        // runtime dispatch boundary revalidates containment when it appears.
        // `lstat` distinguishes this from a dangling symlink, which fails
        // closed above even before its target can appear.
        return;
      }
      throw new WorkflowSourceSemanticError(
        "working-directory-unverifiable",
        "working-directory cannot be physically verified.",
      );
    }
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
