// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config";
import { loadConfig } from "../../core/config";
import { parseFrontmatter } from "../../core/frontmatter";
import { resolveSourceEntries } from "../../indexer/search-source";
import { getLinterForType } from "./registry";
import type { LintIssue } from "./types";
import { checkVaultForDangerousKeys } from "./vault-key-rules";

// ── Public API types (re-exported for consumers) ──────────────────────────────

export type { LintIssue, LintIssueType } from "./types";

export interface AkmLintResult {
  ok: boolean;
  fixed: LintIssue[];
  flagged: LintIssue[];
  summary: { fixed: number; flagged: number };
}

export interface AkmLintOptions {
  fix?: boolean;
  dir?: string;
  config?: AkmConfig;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STASH_SUBDIRS = [
  "agents",
  "commands",
  "memories",
  "skills",
  "workflows",
  "lessons",
  "tasks",
  "knowledge",
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectYamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectYamlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".yml")) {
      results.push(full);
    }
  }
  return results;
}

function collectMarkdownFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

function collectEnvFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...collectEnvFiles(full));
      else if (entry.isFile() && entry.name.endsWith(".env")) results.push(full);
    }
  } catch {
    /* dir may not exist */
  }
  return results;
}

/** True when the issue represents a file deletion that was successfully applied. */
function isFileDeletion(issue: LintIssue): boolean {
  return issue.fixed === true && (issue.issue === "orphaned-stub" || issue.issue === "placeholder-stub");
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function akmLint(options: AkmLintOptions = {}): AkmLintResult {
  const stashRoot = options.dir ?? options.config?.stashDir ?? resolveStashDir();

  // Collect secondary stash roots from configured filesystem sources so that
  // cross-stash refs (e.g. referencing assets in dimm-city/agent-stash) are
  // not falsely flagged as missing-ref.
  const cfg = options.config ?? loadConfig();
  const extraStashRoots = resolveSourceEntries(stashRoot, cfg)
    .map((s) => s.path)
    .filter((p) => p !== stashRoot && fs.existsSync(p));

  const fix = options.fix ?? false;
  const fixed: LintIssue[] = [];
  const flagged: LintIssue[] = [];

  for (const subdir of STASH_SUBDIRS) {
    const dirPath = path.join(stashRoot, subdir);
    // Tasks are .yml files; everything else is .md
    const files = subdir === "tasks" ? collectYamlFiles(dirPath) : collectMarkdownFiles(dirPath);
    const linter = getLinterForType(subdir);

    // If the linter supports directory-level checks, run them for each direct
    // subdirectory once before the per-file loop.
    if (typeof linter.lintDirectory === "function" && fs.existsSync(dirPath)) {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const subdirIssues = linter.lintDirectory(path.join(dirPath, entry.name), stashRoot);
          for (const issue of subdirIssues) {
            if (issue.fixed) {
              fixed.push(issue);
            } else {
              flagged.push(issue);
            }
          }
        }
      }
    }

    for (const filePath of files) {
      const relPath = path.relative(stashRoot, filePath);
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }

      let data: Record<string, unknown>;
      let body: string;
      let frontmatter: string | null;

      if (subdir === "tasks") {
        // Task files are pure YAML — parseFrontmatter returns empty data for them.
        try {
          const parsed = parseYaml(raw);
          data =
            parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
        } catch {
          data = {};
        }
        body = raw;
        frontmatter = null;
      } else {
        ({ data, content: body, frontmatter } = parseFrontmatter(raw));
      }

      const issues = linter.lint({ filePath, relPath, raw, data, body, frontmatter, fix, stashRoot, extraStashRoots });

      let fileDeleted = false;
      for (const issue of issues) {
        if (isFileDeletion(issue)) {
          fileDeleted = true;
          fixed.push(issue);
        } else if (issue.fixed) {
          fixed.push(issue);
        } else {
          flagged.push(issue);
        }
      }

      if (fileDeleted) continue; // file is gone — skip any remaining checks
    }
  }

  // ── Vault dangerous-key pass ───────────────────────────────────────────────
  // Scan every `.env` file under <stashRoot>/vaults/ (and secondary stash
  // roots) for keys that are known to enable process-execution hijacking.
  // This is a warn-only pass — findings go into `flagged`, never `fixed`.
  const vaultRoots = [stashRoot, ...extraStashRoots];
  for (const root of vaultRoots) {
    const vaultsDir = path.join(root, "vaults");
    if (!fs.existsSync(vaultsDir)) continue;
    const envFiles = collectEnvFiles(vaultsDir);
    for (const vaultPath of envFiles) {
      const baseName = path.basename(vaultPath, ".env");
      // canonical vault ref: "default" (or empty) maps to ".env" → vault:default
      const vaultRef = baseName === "" ? "vault:default" : `vault:${baseName}`;
      const relPath = path.relative(root, vaultPath);
      const issues = checkVaultForDangerousKeys(vaultPath, relPath, vaultRef);
      for (const issue of issues) {
        flagged.push(issue);
      }
    }
  }

  // `ok` reflects whether the lint run completed successfully — NOT whether
  // it found anything. Findings are surfaced via `summary.flagged`; the CLI
  // gates its exit code on `--fail-on-flagged`. Conflating "issues exist"
  // with "command failed" caused two downstream problems:
  //   1. `akm lint --json | jq …` saw stdout-flush races on Bun's non-zero
  //      exit, intermittently truncating the JSON the consumer read.
  //   2. `ok` is the shared `{ok, error, code}` failure indicator across the
  //      whole CLI; reusing it for "found stuff" forced callers to disambiguate
  //      a successful-but-flagged run from a hard error by inspecting fields.
  return {
    ok: true,
    fixed,
    flagged,
    summary: { fixed: fixed.length, flagged: flagged.length },
  };
}
