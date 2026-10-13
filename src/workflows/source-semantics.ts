// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Semantic checks for the Markdown workflow grammar (`parser.ts`). */

import fs from "node:fs";
import path from "node:path";

export class WorkflowSourceSemanticError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowSourceSemanticError";
  }
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
