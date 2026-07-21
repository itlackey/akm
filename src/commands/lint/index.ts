// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { resolveStashDir } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig, primaryBundlePath } from "../../core/config/config";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import { checkEnvForDangerousKeys } from "./env-key-rules";
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
  typeFilter?: string;
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
  "facts",
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
  // Collect secondary stash roots from configured filesystem sources so that
  // cross-stash refs (e.g. referencing assets in dimm-city/agent-stash) are
  // not falsely flagged as missing-ref.
  const cfg = options.config ?? loadConfig();
  // 0.9.0 (spec §10.1): the primary stash is the defaultBundle's path.
  const stashRoot = options.dir ?? primaryBundlePath(cfg) ?? resolveStashDir();
  const extraStashRoots = resolveSourceEntries(stashRoot, cfg)
    .map((s) => s.path)
    .filter((p) => p !== stashRoot && fs.existsSync(p));

  const fix = options.fix ?? false;
  const fixed: LintIssue[] = [];
  const flagged: LintIssue[] = [];

  const dirsToScan = options.typeFilter ? STASH_SUBDIRS.filter((d) => d === options.typeFilter) : STASH_SUBDIRS;

  for (const subdir of dirsToScan) {
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
            // Tristate-safe: only `true` counts as fixed; `false` and "failed"
            // are both flagged.
            if (issue.fixed === true) {
              fixed.push(issue);
            } else {
              flagged.push(issue);
            }
          }
        }
      }
    }

    for (const filePath of files) {
      // Skip registry-cached read-only files — --fix must not mutate them.
      if (filePath.includes("/.cache/") || filePath.includes("/registry/")) continue;
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
        } else if (issue.fixed === true) {
          fixed.push(issue);
        } else {
          // fixed === false (not fixable / no fix requested) or "failed" (fix attempted but threw)
          flagged.push(issue);
        }
      }

      if (fileDeleted) continue; // file is gone — skip any remaining checks
    }
  }

  // ── Env dangerous-key pass ─────────────────────────────────────────────────
  // Scan every `.env` file under <stashRoot>/env/ across all stash roots for
  // keys that are known to enable process-execution hijacking. Warn-only —
  // findings go into `flagged`, never `fixed`.
  const envRoots = [stashRoot, ...extraStashRoots];
  for (const root of envRoots) {
    // The `env` assets live under `env/` (ref prefix `env:`); whole-file
    // `secret` assets live under `secrets/` (canonical ref prefix `secret:`,
    // singular). Map the scan directory to its canonical ref prefix so the
    // finding's `Ref:` field matches what `akm show`/`akm secret` accept.
    for (const { scanSubdir, refPrefix } of [
      { scanSubdir: "env", refPrefix: "env" },
      { scanSubdir: "secrets", refPrefix: "secret" },
    ]) {
      const dir = path.join(root, scanSubdir);
      if (!fs.existsSync(dir)) continue;
      for (const envPath of collectEnvFiles(dir)) {
        const baseName = path.basename(envPath, ".env");
        // A dotfile literally named `.env` has an empty baseName — use the full
        // basename so it doesn't collide with `default.env` → refPrefix:default.
        const ref = baseName === "" ? `${refPrefix}:.env` : `${refPrefix}:${baseName}`;
        const relPath = path.relative(root, envPath);
        for (const issue of checkEnvForDangerousKeys(envPath, relPath, ref)) {
          flagged.push(issue);
        }
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
