import { parseFrontmatter } from "./frontmatter";

// ── Types ───────────────────────────────────────────────────────────────────

export interface TocHeading {
  level: number;
  text: string;
  line: number;
}

export interface KnowledgeToc {
  headings: TocHeading[];
  totalLines: number;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

export function parseMarkdownToc(content: string): KnowledgeToc {
  const lines = content.split(/\r?\n/);
  const headings: TocHeading[] = [];

  const parsed = parseFrontmatter(content);
  const start = parsed.frontmatter ? parsed.bodyStartLine - 1 : 0;

  for (let i = start; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].replace(/\s+#+\s*$/, "").trim(),
        line: i + 1,
      });
    }
  }

  return { headings, totalLines: lines.length };
}

// ── Extraction ──────────────────────────────────────────────────────────────

export function extractSection(
  content: string,
  heading: string,
): { content: string; startLine: number; endLine: number } | null {
  const lines = content.split(/\r?\n/);
  const target = heading.toLowerCase();

  let startIdx = -1;
  let startLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;
    const text = match[2].replace(/\s+#+\s*$/, "").trim();
    if (text.toLowerCase() === target && startIdx === -1) {
      startIdx = i;
      startLevel = match[1].length;
    } else if (startIdx !== -1 && match[1].length <= startLevel) {
      return {
        content: lines.slice(startIdx, i).join("\n"),
        startLine: startIdx + 1,
        endLine: i,
      };
    }
  }

  if (startIdx === -1) return null;

  return {
    content: lines.slice(startIdx).join("\n"),
    startLine: startIdx + 1,
    endLine: lines.length,
  };
}

export function extractLineRange(content: string, start: number, end: number): string {
  const lines = content.split(/\r?\n/);
  if (end < start) return "";
  const s = Math.max(1, Math.min(start, lines.length));
  const e = Math.min(end, lines.length);
  return lines.slice(s - 1, e).join("\n");
}

export function extractFrontmatterOnly(content: string): string | null {
  const parsed = parseFrontmatter(content);
  return parsed.frontmatter;
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatToc(toc: KnowledgeToc): string {
  if (toc.headings.length === 0) {
    return `(no headings found — ${toc.totalLines} lines total)`;
  }

  const lineWidth = String(toc.totalLines).length;
  const parts = toc.headings.map((h) => {
    const lineNum = `L${String(h.line).padStart(lineWidth)}`;
    const indent = "  ".repeat(h.level - 1);
    const prefix = "#".repeat(h.level);
    return `${lineNum}  ${indent}${prefix} ${h.text}`;
  });

  parts.push(`\n${toc.totalLines} lines total`);
  return parts.join("\n");
}
