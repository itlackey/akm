/**
 * Knowledge wiki orchestration: bootstrap, ingest, and lint.
 *
 * Implements Andrej Karpathy's LLM Wiki pattern on top of the existing
 * `knowledge` asset type. No new asset type, no new provider, no parallel
 * scoring — just conventions in `<stashDir>/knowledge/` plus shipped skills.
 */

import fs from "node:fs";
import path from "node:path";
import type { LlmConnectionConfig } from "./config";
import { parseFrontmatter } from "./frontmatter";
import {
  ingestKnowledgeSource,
  lintKnowledge,
  type WikiCandidatePage,
  type WikiIngestPlan,
  type WikiLintReport,
} from "./llm";
import { akmSearch } from "./stash-search";
import {
  INDEX_MD,
  LOG_MD,
  SCHEMA_MD,
  SKILL_INGEST_MD,
  SKILL_LINT_MD,
  SKILL_QUERY_MD,
} from "./templates/knowledge-templates";
import { walkStash } from "./walker";

// ── Constants ───────────────────────────────────────────────────────────────

const KNOWLEDGE_SUBDIR = "knowledge";
const RAW_SUBDIR = "raw";
const SKILLS_SUBDIR = "skills";
const MAX_INGEST_CANDIDATES = 15;
const MAX_QUERY_TERMS = 8;
const SLUG_MAX_LENGTH = 64;

const BOOTSTRAP_FILES: Array<{ relPath: string; content: string }> = [
  { relPath: path.join(KNOWLEDGE_SUBDIR, "schema.md"), content: SCHEMA_MD },
  { relPath: path.join(KNOWLEDGE_SUBDIR, "index.md"), content: INDEX_MD },
  { relPath: path.join(KNOWLEDGE_SUBDIR, "log.md"), content: LOG_MD },
  { relPath: path.join(SKILLS_SUBDIR, "knowledge-ingest", "SKILL.md"), content: SKILL_INGEST_MD },
  { relPath: path.join(SKILLS_SUBDIR, "knowledge-query", "SKILL.md"), content: SKILL_QUERY_MD },
  { relPath: path.join(SKILLS_SUBDIR, "knowledge-lint", "SKILL.md"), content: SKILL_LINT_MD },
];

// ── Bootstrap ───────────────────────────────────────────────────────────────

export interface BootstrapResult {
  created: string[];
  skipped: string[];
}

/**
 * Idempotently write the schema, index, log, and three knowledge skills into
 * the stash. Files that already exist are left alone.
 */
export function bootstrapKnowledgeWiki(stashDir: string): BootstrapResult {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const { relPath, content } of BOOTSTRAP_FILES) {
    const absPath = path.join(stashDir, relPath);
    if (fs.existsSync(absPath)) {
      skipped.push(absPath);
      continue;
    }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");
    created.push(absPath);
  }

  return { created, skipped };
}

// ── Slug helpers ────────────────────────────────────────────────────────────

export function slugifyForWiki(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/^[#>\-\s]+/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX_LENGTH) || `note-${Date.now().toString(36)}`
  );
}

/** Extract a query string from a source: title or first sentence, capped to MAX_QUERY_TERMS words. */
export function deriveQueryFromSource(content: string): string {
  const lines = content.split(/\r?\n/);
  let inFrontmatter = false;
  let frontmatterClosed = false;
  let basis = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Detect a frontmatter block bounded by `---` lines at the top of the file.
    if (i === 0 && trimmed === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter && !frontmatterClosed) {
      if (trimmed === "---") frontmatterClosed = true;
      continue;
    }
    if (!trimmed) continue;
    basis = trimmed.replace(/^#+\s*/, "");
    break;
  }
  if (!basis) return "";
  return basis.split(/\s+/).slice(0, MAX_QUERY_TERMS).join(" ");
}

// ── Ingest ──────────────────────────────────────────────────────────────────

export interface IngestOptions {
  /** Source content (markdown or plain text). */
  content: string;
  /** Suggested filename (defaults to a slug from the first heading/line). */
  preferredName?: string;
  /** Apply the plan; without this, returns a dry-run plan. */
  apply?: boolean;
  /** Override candidate gathering — used by tests to skip the search round-trip. */
  candidates?: WikiCandidatePage[];
  /** Stash directory; defaults to caller's resolved stashDir. */
  stashDir: string;
  /** LLM config to drive the ingest. */
  llm: LlmConnectionConfig;
}

export interface IngestResult {
  rawPath: string;
  rawSlug: string;
  candidates: WikiCandidatePage[];
  plan?: WikiIngestPlan;
  applied?: {
    pagesCreated: string[];
    pagesEdited: string[];
    logAppended: string;
  };
}

/**
 * Run the wiki ingest workflow for a source.
 *
 * Always copies the source into `knowledge/raw/<slug>.md`. With `apply: false`
 * (default), returns the LLM's plan without touching pages. With `apply: true`,
 * creates new pages, appends to existing pages, and writes a log entry.
 */
export async function ingestSource(opts: IngestOptions): Promise<IngestResult> {
  const knowledgeDir = path.join(opts.stashDir, KNOWLEDGE_SUBDIR);
  const rawDir = path.join(knowledgeDir, RAW_SUBDIR);
  fs.mkdirSync(rawDir, { recursive: true });

  // Copy source to raw/, picking a unique slug if needed.
  const baseSlug = slugifyForWiki(opts.preferredName ?? deriveQueryFromSource(opts.content) ?? "source");
  const rawSlug = pickUniqueRawSlug(rawDir, baseSlug);
  const rawPath = path.join(rawDir, `${rawSlug}.md`);
  fs.writeFileSync(rawPath, ensureTrailingNewline(withRawFrontmatter(opts.content, rawSlug)), "utf8");

  // Collect candidate pages by searching the existing knowledge stash.
  const candidates = opts.candidates ?? (await collectCandidates(opts.content));

  // Ask the LLM for a plan.
  const plan = await ingestKnowledgeSource(opts.llm, {
    sourceName: rawSlug,
    sourceContent: opts.content,
    candidates,
  });

  if (!opts.apply || !plan) {
    return { rawPath, rawSlug, candidates, plan };
  }

  const applied = applyPlan(knowledgeDir, rawSlug, plan);
  return { rawPath, rawSlug, candidates, plan, applied };
}

/**
 * Search the local stash for pages related to the source. Returns an empty
 * array if the index is unbuilt or the search fails — ingest still proceeds
 * with no candidates so the source is at least filed under raw/.
 */
async function collectCandidates(sourceContent: string): Promise<WikiCandidatePage[]> {
  const query = deriveQueryFromSource(sourceContent);
  if (!query) return [];

  try {
    const response = await akmSearch({
      query,
      type: "knowledge",
      limit: MAX_INGEST_CANDIDATES,
      source: "stash",
    });
    return response.hits
      .filter((h): h is import("./stash-types").StashSearchHit => h.type === "knowledge")
      .filter((h) => !h.ref.includes("/raw/")) // never xref into raw/
      .map((h) => ({
        ref: h.ref,
        name: h.name,
        description: h.description,
      }));
  } catch {
    return [];
  }
}

function pickUniqueRawSlug(rawDir: string, baseSlug: string): string {
  let candidate = baseSlug;
  let n = 1;
  while (fs.existsSync(path.join(rawDir, `${candidate}.md`))) {
    n += 1;
    candidate = `${baseSlug}-${n}`;
  }
  return candidate;
}

function withRawFrontmatter(content: string, slug: string): string {
  // If the source already has frontmatter, keep it untouched. Adding a wrapper
  // would corrupt the user's metadata — the wikiRole is already implied by the
  // raw/ path and the indexer's wikiRole detection.
  if (content.startsWith("---")) return content;
  const date = new Date().toISOString().slice(0, 10);
  return `---\nwikiRole: raw\ningestedAt: ${date}\nslug: ${slug}\n---\n\n${content}`;
}

function applyPlan(
  knowledgeDir: string,
  rawSlug: string,
  plan: WikiIngestPlan,
): { pagesCreated: string[]; pagesEdited: string[]; logAppended: string } {
  const pagesCreated: string[] = [];
  const pagesEdited: string[] = [];

  for (const page of plan.newPages) {
    const slug = slugifyForWiki(page.name);
    const targetPath = pickUniquePagePath(knowledgeDir, slug);
    const frontmatter = buildPageFrontmatter({
      pageKind: page.pageKind ?? "note",
      xrefs: page.xrefs,
      sources: [`raw/${rawSlug}.md`],
      description: firstLineDescription(page.body) ?? plan.summary,
    });
    fs.writeFileSync(targetPath, `${frontmatter}\n\n${page.body.trimEnd()}\n`, "utf8");
    pagesCreated.push(targetPath);
  }

  for (const edit of plan.edits) {
    const ref = edit.ref;
    const refSlug = ref.replace(/^knowledge:/, "");
    const targetPath = path.join(knowledgeDir, `${refSlug}.md`);
    if (!fs.existsSync(targetPath)) continue;
    const existing = fs.readFileSync(targetPath, "utf8");
    const appended = `${existing.replace(/\s+$/, "")}\n\n${edit.patch.trim()}\n\n_added from ${ref ? "" : ""}raw/${rawSlug}.md: ${edit.reason}_\n`;
    fs.writeFileSync(targetPath, appended, "utf8");
    pagesEdited.push(targetPath);
  }

  const logPath = path.join(knowledgeDir, "log.md");
  const date = new Date().toISOString().slice(0, 19).replace("T", " ");
  const created = pagesCreated.map((p) => `\`knowledge:${path.basename(p, ".md")}\``).join(", ") || "_(none)_";
  const edited = plan.edits.map((e) => `\`${e.ref}\``).join(", ") || "_(none)_";
  const noteLine = plan.note ? `\n  note: ${plan.note}` : "";
  const logEntry = `\n## ${date} ingest raw/${rawSlug}.md\n\nsummary: ${plan.summary}\n  created: ${created}\n  edited: ${edited}${noteLine}\n`;
  fs.appendFileSync(logPath, logEntry, "utf8");

  return { pagesCreated, pagesEdited, logAppended: logEntry };
}

function pickUniquePagePath(knowledgeDir: string, slug: string): string {
  let candidate = slug;
  let n = 1;
  while (fs.existsSync(path.join(knowledgeDir, `${candidate}.md`))) {
    n += 1;
    candidate = `${slug}-${n}`;
  }
  return path.join(knowledgeDir, `${candidate}.md`);
}

function firstLineDescription(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
  }
  return undefined;
}

function buildPageFrontmatter(opts: {
  pageKind: "entity" | "concept" | "question" | "note";
  xrefs?: string[];
  sources?: string[];
  description?: string;
}): string {
  const lines = ["---"];
  if (opts.description) lines.push(`description: ${jsonString(opts.description)}`);
  lines.push(`pageKind: ${opts.pageKind}`);
  if (opts.xrefs && opts.xrefs.length > 0) {
    lines.push("xrefs:");
    for (const x of opts.xrefs) lines.push(`  - ${x}`);
  }
  if (opts.sources && opts.sources.length > 0) {
    lines.push("sources:");
    for (const s of opts.sources) lines.push(`  - ${s}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function jsonString(value: string): string {
  // Single-line YAML-safe quoted string: escape backslashes and double quotes.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

// ── Lint ────────────────────────────────────────────────────────────────────

export interface LintOptions {
  stashDir: string;
  llm: LlmConnectionConfig;
  /** Apply suggestedFix payloads from findings that include them. */
  fix?: boolean;
}

export interface LintResult {
  pagesScanned: number;
  report?: WikiLintReport;
  applied?: { fixesApplied: number; fixesSkipped: number };
}

export async function lintWiki(opts: LintOptions): Promise<LintResult> {
  const knowledgeDir = path.join(opts.stashDir, KNOWLEDGE_SUBDIR);
  const pages = collectKnowledgePages(knowledgeDir);

  const report = await lintKnowledge(opts.llm, {
    pages: pages.map((p) => ({
      ref: p.ref,
      description: p.description,
      xrefs: p.xrefs,
      pageKind: p.pageKind,
    })),
  });

  if (!opts.fix || !report) {
    return { pagesScanned: pages.length, report };
  }

  let fixesApplied = 0;
  let fixesSkipped = 0;
  for (const finding of report.findings) {
    if (!finding.suggestedFix) {
      fixesSkipped += 1;
      continue;
    }
    // Only apply low-risk fixes: missing-xref (append xref to existing page).
    if (finding.kind !== "missing-xref") {
      fixesSkipped += 1;
      continue;
    }
    const ref = finding.refs[0];
    if (!ref?.startsWith("knowledge:")) {
      fixesSkipped += 1;
      continue;
    }
    const targetPath = path.join(knowledgeDir, `${ref.replace(/^knowledge:/, "")}.md`);
    if (!fs.existsSync(targetPath)) {
      fixesSkipped += 1;
      continue;
    }
    const existing = fs.readFileSync(targetPath, "utf8");
    fs.writeFileSync(targetPath, `${existing.replace(/\s+$/, "")}\n\n${finding.suggestedFix.trim()}\n`, "utf8");
    fixesApplied += 1;
  }

  // Log the lint run.
  const logPath = path.join(knowledgeDir, "log.md");
  const date = new Date().toISOString().slice(0, 19).replace("T", " ");
  fs.appendFileSync(
    logPath,
    `\n## ${date} lint\n\nfindings: ${report.findings.length}, applied: ${fixesApplied}, skipped: ${fixesSkipped}${report.summary ? `\n  summary: ${report.summary}` : ""}\n`,
    "utf8",
  );

  return { pagesScanned: pages.length, report, applied: { fixesApplied, fixesSkipped } };
}

interface KnowledgePage {
  ref: string;
  filePath: string;
  description?: string;
  pageKind?: string;
  xrefs?: string[];
  wikiRole?: string;
}

function collectKnowledgePages(knowledgeDir: string): KnowledgePage[] {
  if (!fs.existsSync(knowledgeDir)) return [];
  const groups = walkStash(knowledgeDir, "knowledge");
  const pages: KnowledgePage[] = [];
  for (const group of groups) {
    for (const file of group.files) {
      const rel = path.relative(knowledgeDir, file).replace(/\\/g, "/").replace(/\.md$/i, "");
      // Skip raw/ and the special schema/index/log files when feeding the LLM.
      if (rel.startsWith(`${RAW_SUBDIR}/`)) continue;
      if (rel === "schema" || rel === "index" || rel === "log") continue;

      let parsed: ReturnType<typeof parseFrontmatter>;
      try {
        parsed = parseFrontmatter(fs.readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const fm = parsed.data;
      const page: KnowledgePage = {
        ref: `knowledge:${rel}`,
        filePath: file,
      };
      if (typeof fm.description === "string" && fm.description) page.description = fm.description;
      if (
        fm.pageKind === "entity" ||
        fm.pageKind === "concept" ||
        fm.pageKind === "question" ||
        fm.pageKind === "note"
      ) {
        page.pageKind = fm.pageKind;
      }
      if (Array.isArray(fm.xrefs)) {
        page.xrefs = fm.xrefs.filter((x): x is string => typeof x === "string");
      }
      if (typeof fm.wikiRole === "string") page.wikiRole = fm.wikiRole;
      pages.push(page);
    }
  }
  return pages;
}
