// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `stale-path` rule, shared by every lint surface: which absolute paths
 * this machine can judge, and what an agent needs to find and correct one.
 * Only the current user's home, a configured bundle or project root, and
 * `/tmp` are judged; any other path belongs to some other host or user.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundleContentRoots } from "../config/config-sources";
import type { AkmConfig } from "../config/config-types";
import { expandProjectPath } from "../config/schema/projects";
import { findCurrentPathReferences } from "./lint-text";

/** Why a path is stale: gone from the home, a bundle or a project, or a `/tmp` file that no longer exists. */
export type StalePathReason = "missing" | "ephemeral";

/** What a stale-path finding says about the path, so a caller can find the line and correct it. */
export interface StalePathFields {
  path: string;
  /** The line the path is on, trimmed. */
  lineText: string;
  /** The deepest existing directory above the path. */
  nearestExisting: string;
  reason: StalePathReason;
}

/** A stale-path finding: its fields, the 1-based line in the file, and the text lint prints. */
export interface StalePathFinding extends StalePathFields {
  line: number;
  detail: string;
}

/** The roots that make a path judgeable: the user's home, every configured bundle and project, and `extraRoots`. */
export function stalePathRoots(config: AkmConfig, ...extraRoots: string[]): string[] {
  const projectPaths = Object.values(config.projects ?? {}).flatMap((project) => project.paths ?? []);
  return [
    os.homedir(),
    ...bundleContentRoots(config).map((bundle) => bundle.contentRoot),
    ...projectPaths.map(expandProjectPath),
    ...extraRoots,
  ];
}

function isUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function nearestExistingDirectory(candidate: string): string {
  let dir = path.dirname(candidate);
  while (dir !== path.dirname(dir) && !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    dir = path.dirname(dir);
  }
  return dir;
}

/**
 * The stale paths in `text` (whose first line is file line `firstLine`): paths presented as current
 * guidance that do not exist and that this machine can judge. `bundleRoot` is the bundle the text
 * belongs to; a path under it also gets its portable `$AKM_BUNDLE_DIR` spelling in the detail.
 */
export function findStalePaths(
  text: string,
  firstLine: number,
  roots: readonly string[],
  bundleRoot: string,
): StalePathFinding[] {
  const findings: StalePathFinding[] = [];
  for (const { path: candidate, line, lineText } of findCurrentPathReferences(text, firstLine)) {
    const managed = roots.some((root) => isUnder(candidate, root));
    const ephemeral = !managed && candidate.startsWith("/tmp/");
    if (!managed && !ephemeral) continue;
    if (fs.existsSync(candidate)) continue;
    const portable = isUnder(candidate, bundleRoot)
      ? ` (portable form: $AKM_BUNDLE_DIR${candidate.slice(bundleRoot.length)})`
      : "";
    findings.push({
      path: candidate,
      line,
      lineText,
      nearestExisting: nearestExistingDirectory(candidate),
      reason: ephemeral ? "ephemeral" : "missing",
      detail: `${ephemeral ? "ephemeral" : "nonexistent"} path: ${candidate}${portable}`,
    });
  }
  return findings;
}
