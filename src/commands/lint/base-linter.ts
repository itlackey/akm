import fs from "node:fs";
import path from "node:path";
import type { AssetLinter, LintContext, LintIssue } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function checkUnquotedColon(frontmatterText: string | null): string | null {
  if (!frontmatterText) return null;
  for (const line of frontmatterText.split(/\r?\n/)) {
    const match = line.match(/^description:\s*(.*)/);
    if (!match) continue;
    const value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return null;
    }
    if (value.includes(":")) {
      return `description value contains unquoted colon: ${value}`;
    }
  }
  return null;
}

function fixUnquotedColon(raw: string): string {
  return raw.replace(/^(description:\s*)(.*)/m, (_match, prefix, value) => {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return _match;
    }
    const escaped = trimmed.replace(/"/g, '\\"');
    return `${prefix}"${escaped}"`;
  });
}

function checkMissingUpdated(data: Record<string, unknown>, frontmatterText: string | null): boolean {
  return frontmatterText !== null && !("updated" in data);
}

function fixMissingUpdated(raw: string, mtime: Date): string {
  const dateStr = formatDate(mtime);
  return raw.replace(/^(---\n[\s\S]*?)\n---/m, `$1\nupdated: ${dateStr}\n---`);
}

// ── stale-path helpers ────────────────────────────────────────────────────────

function checkStalePath(body: string): string | null {
  const pathRe = /\/home\/[^\s"'`)\]>,]+/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = pathRe.exec(body)) !== null) {
    const candidate = match[0];
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ── missing-ref helpers ───────────────────────────────────────────────────────

const REF_RE =
  /(?:^|[\s`"'(])((agent|command|knowledge|memory|script|skill|workflow|lesson|task|wiki|vault):[^\s"'`)\]>,\n]+)/gm;

/** Map from ref type to relative path pattern within stashRoot. Returns null to skip. */
function refToRelPath(refType: string, refName: string): string | null {
  switch (refType) {
    case "agent":
      return path.join("agents", `${refName}.md`);
    case "command":
      return path.join("commands", `${refName}.md`);
    case "knowledge":
      return path.join("knowledge", `${refName}.md`);
    case "memory":
      return path.join("memories", `${refName}.md`);
    case "script":
      return null; // scripts live in nested dirs — skip
    case "skill":
      return path.join("skills", refName, "SKILL.md");
    case "workflow":
      return path.join("workflows", `${refName}.md`);
    case "lesson":
      return path.join("lessons", `${refName}.md`);
    case "task":
      return path.join("tasks", `${refName}.md`);
    case "wiki":
      return path.join("wikis", `${refName}.md`);
    case "vault":
      // Vaults are .env files. The canonical name "default" (or empty) maps to
      // ".env"; any other name maps to "<name>.env".  This mirrors the vault
      // asset-spec toAssetPath logic in src/core/asset-spec.ts.
      if (!refName || refName === "default") {
        return path.join("vaults", ".env");
      }
      return path.join("vaults", `${refName}.env`);
    default:
      return null;
  }
}

/**
 * Returns true if `relPath` resolves to a real file (or multi-file directory
 * primary) in ANY of the provided stash roots.
 */
function refExistsInAnyStash(relPath: string, refType: string, refName: string, stashRoots: string[]): boolean {
  for (const root of stashRoots) {
    const absPath = path.join(root, relPath);
    if (fs.existsSync(absPath)) return true;
    // Multi-file skill layout: directory containing SKILL.md
    const bareDir = absPath.replace(/\.md$/, "");
    if (fs.existsSync(bareDir) && fs.existsSync(path.join(bareDir, "SKILL.md"))) return true;
    // .derived.md variant for memory refs
    if (refType === "memory") {
      const derivedPath = path.join(root, "memories", `${refName}.derived.md`);
      if (fs.existsSync(derivedPath)) return true;
    }
    // Knowledge-specific: search subdirectories like knowledge/projects/, knowledge/tools/, etc.
    if (refType === "knowledge") {
      try {
        const knowledgeDir = path.join(root, "knowledge");
        if (fs.existsSync(knowledgeDir) && fs.statSync(knowledgeDir).isDirectory()) {
          const entries = fs.readdirSync(knowledgeDir);
          for (const entry of entries) {
            const subPath = path.join(knowledgeDir, entry, `${refName}.md`);
            if (fs.existsSync(subPath)) return true;
          }
        }
      } catch {
        // Ignore errors reading directory
      }
    }
    // Fallback: the refName may already encode the full stash-relative path
    // (e.g. knowledge:skills/foo/references/bar where the file lives at
    // <stash>/skills/foo/references/bar.md, not <stash>/knowledge/skills/...).
    const directPath = path.join(root, `${refName}.md`);
    if (fs.existsSync(directPath)) return true;
    const directDir = path.join(root, refName);
    if (fs.existsSync(directDir) && fs.existsSync(path.join(directDir, "SKILL.md"))) return true;
  }
  return false;
}

/**
 * Returns an array of {ref, resolvedRelPath} for every local AKM ref in the
 * body that does not resolve to a real file under any of the provided stash roots.
 *
 * Skips false-positive patterns:
 * - Shell variables: memory:$(cmd) or knowledge:${VAR}
 * - ACP type notation: agent::Type (double colons are C++/ACP syntax)
 * - Incomplete/placeholder refs: slug is single character or "**"
 */
function checkMissingRefs(
  body: string,
  stashRoot: string,
  extraStashRoots: string[] = [],
): Array<{ ref: string; resolvedRelPath: string }> {
  const allRoots = [stashRoot, ...extraStashRoots];
  const missing: Array<{ ref: string; resolvedRelPath: string }> = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(REF_RE.source, REF_RE.flags);

  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((match = re.exec(body)) !== null) {
    const fullRef = match[1]; // e.g. "workflow:foo" or "local//workflow:foo"

    // Skip shell variables: memory:$(cmd) or knowledge:${VAR}
    if (fullRef.includes("$(") || fullRef.includes("${")) {
      continue;
    }

    // Skip ACP type notation: agent::Type (double colons)
    if (fullRef.includes("::")) {
      continue;
    }

    // Strip leading "local//" prefix if present
    let ref = fullRef;
    if (ref.startsWith("local//")) {
      ref = ref.slice("local//".length);
    } else if (fullRef.includes("//")) {
      // Has a remote origin prefix (e.g. "npm:", "github:", "owner/repo//") — skip
      continue;
    }

    // Skip refs that start with obvious remote prefixes
    const colonIdx = ref.indexOf(":");
    if (colonIdx === -1) continue;
    const refType = ref.slice(0, colonIdx);
    const refName = ref.slice(colonIdx + 1);

    // Guard against empty names or names that look like paths/URLs
    if (!refName || refName.startsWith("/") || refName.startsWith("~") || refName.startsWith("http")) {
      continue;
    }

    // Skip placeholder/incomplete refs: single character slug or "**"
    if (refName.length <= 1 || refName === "**") {
      continue;
    }

    const relPath = refToRelPath(refType, refName);
    if (relPath === null) continue; // type is skipped

    if (!refExistsInAnyStash(relPath, refType, refName, allRoots)) {
      missing.push({ ref: fullRef, resolvedRelPath: relPath });
    }
  }

  return missing;
}

// ── BaseLinter ────────────────────────────────────────────────────────────────

/**
 * Abstract base class providing the two cross-type checks shared by all asset
 * linters: `unquoted-colon` and `missing-updated`.
 *
 * Subclasses call `runBaseChecks(ctx)` and append any type-specific issues.
 * File mutations triggered by base checks are flushed to disk inside this
 * method; subclasses must re-read `ctx.raw` if they need the post-fix content
 * (in practice the base class updates `ctx.raw` in place when `fix` is true).
 */
export abstract class BaseLinter implements AssetLinter {
  abstract readonly types: readonly string[];
  abstract lint(ctx: LintContext): LintIssue[];

  protected runBaseChecks(ctx: LintContext): LintIssue[] {
    const issues: LintIssue[] = [];
    let currentRaw = ctx.raw;
    let modified = false;

    // ── 1. unquoted-colon ──────────────────────────────────────────────────
    const unquotedColonDetail = checkUnquotedColon(ctx.frontmatter);
    if (unquotedColonDetail) {
      if (ctx.fix) {
        currentRaw = fixUnquotedColon(currentRaw);
        modified = true;
        issues.push({
          file: ctx.relPath,
          issue: "unquoted-colon",
          detail: unquotedColonDetail,
          fixed: true,
        });
      } else {
        issues.push({
          file: ctx.relPath,
          issue: "unquoted-colon",
          detail: unquotedColonDetail,
          fixed: false,
        });
      }
    }

    // ── 2. missing-updated ─────────────────────────────────────────────────
    if (checkMissingUpdated(ctx.data, ctx.frontmatter)) {
      if (ctx.fix) {
        let mtime: Date;
        try {
          mtime = fs.statSync(ctx.filePath).mtime;
        } catch {
          mtime = new Date();
        }
        currentRaw = fixMissingUpdated(currentRaw, mtime);
        modified = true;
        issues.push({
          file: ctx.relPath,
          issue: "missing-updated",
          detail: `stamped updated: ${formatDate(mtime)}`,
          fixed: true,
        });
      } else {
        issues.push({
          file: ctx.relPath,
          issue: "missing-updated",
          detail: "no updated field in frontmatter",
          fixed: false,
        });
      }
    }

    if (modified) {
      fs.writeFileSync(ctx.filePath, currentRaw, "utf8");
      // Propagate the mutated raw back so subclasses can re-parse if needed
      ctx.raw = currentRaw;
    }

    // ── 3. stale-path ──────────────────────────────────────────────────────
    const stalePathMatch = checkStalePath(ctx.body);
    if (stalePathMatch) {
      issues.push({
        file: ctx.relPath,
        issue: "stale-path",
        detail: `nonexistent path: ${stalePathMatch}`,
        fixed: false,
      });
    }

    // ── 4. missing-ref ─────────────────────────────────────────────────────
    const missingRefs = checkMissingRefs(ctx.body, ctx.stashRoot, ctx.extraStashRoots);
    for (const { ref, resolvedRelPath } of missingRefs) {
      issues.push({
        file: ctx.relPath,
        issue: "missing-ref",
        detail: `missing ref: ${ref} (resolved to ${resolvedRelPath})`,
        fixed: false,
      });
    }

    return issues;
  }
}
