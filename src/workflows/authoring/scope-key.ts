// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isWithin, resolveStashDir, safeRealpath, toPosix } from "../../core/common";

const PROJECT_CONFIG_RELATIVE_PATH = path.join(".akm", "config.json");

export function getCurrentWorkflowScopeKey(): string {
  const anchor = resolveWorkflowScopeAnchor(process.cwd());
  const normalized = normalizeScopePath(anchor);
  const digest = createHash("sha256").update(normalized).digest("hex");
  return `dir:v1:${digest}`;
}

export function resolveWorkflowScopeAnchor(startDir: string): string {
  const cwd = safeRealpath(startDir);
  const projectRoot = findNearestProjectConfigRoot(cwd);
  if (projectRoot) return projectRoot;

  const gitRoot = findNearestGitRoot(cwd);
  if (gitRoot) return gitRoot;

  try {
    const stashDir = safeRealpath(resolveStashDir({ readOnly: true }));
    if (isWithin(cwd, stashDir)) return stashDir;
  } catch {
    // Ignore stash resolution failures and fall back to cwd.
  }

  return cwd;
}

function findNearestProjectConfigRoot(startDir: string): string | null {
  let currentDir = startDir;
  while (true) {
    const configPath = path.join(currentDir, PROJECT_CONFIG_RELATIVE_PATH);
    if (isFile(configPath)) {
      return safeRealpath(currentDir);
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function findNearestGitRoot(startDir: string): string | null {
  let currentDir = startDir;
  while (true) {
    const gitPath = path.join(currentDir, ".git");
    if (exists(gitPath)) {
      return safeRealpath(currentDir);
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function exists(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function normalizeScopePath(value: string): string {
  const posix = toPosix(value);
  return process.platform === "win32" ? posix.toLowerCase() : posix;
}
