import fs from "node:fs";
import path from "node:path";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config";
import { loadConfig } from "../../core/config";
import { parseFrontmatter } from "../../core/frontmatter";
import { resolveSourceEntries } from "../../indexer/search-source";
import { getLinterForType } from "./registry";
import type { LintIssue } from "./types";

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
    const files = collectMarkdownFiles(dirPath);
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

      const { data, content: body, frontmatter } = parseFrontmatter(raw);

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

  return {
    ok: flagged.length === 0,
    fixed,
    flagged,
    summary: { fixed: fixed.length, flagged: flagged.length },
  };
}
