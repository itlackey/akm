// Safe document rendering: headings, lists, tables, task items, fenced code, inline code, bold, links and
// [[wikilinks]]. Link targets and heading selectors come from AKM's indexed reads.
// It never touches raw text except through `html`, which escapes every interpolated value.
import { assetHref, html } from "./lib.js";

const SAFE_URL = /^(https?:\/\/|mailto:|#)/i;
const INLINE = /`([^`]+)`|\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;
// The same fence rule as the server's parseMarkdownToc (CommonMark), so both agree on which headings exist:
// a fence opens with 3+ backticks or tildes indented at most 3 spaces (a backtick fence's info string has
// no backtick) and closes only on a line of the same character, at least as long, then only whitespace.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const opensFence = (line) => {
  const m = FENCE.exec(line);
  return m && !(m[1][0] === "`" && m[2].includes("`")) ? m[1] : null;
};
const closesFence = (line, open) => {
  const m = FENCE.exec(line);
  return m !== null && m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim();
};
const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** DOM id of a heading: prefixed so a slug like "app" never collides with the page's own ids. */
export const headingId = (slug) => `h-${slug}`;

function link(text, url, context) {
  if (context.links && Object.hasOwn(context.links, url))
    return html`<a href="${assetHref(context.links[url])}">${text}</a>`;
  if (url.startsWith("#")) {
    // A bare "#x" would be read by the hash router as a page; without an asset to anchor to, show text.
    if (!context.ref) return html`${text}`;
    return html`<a href="${assetHref(context.ref)}&section=${encodeURIComponent(url.slice(1))}">${text}</a>`;
  }
  if (!SAFE_URL.test(url)) return html`${text}`;
  const external = /^(https?:|mailto:)/i.test(url);
  return external
    ? html`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
    : html`<a href="${url}">${text}</a>`;
}

/** Inline spans of one line of text. `context` is the same as for {@link markdown}. */
export function inline(text, context = {}) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(html`<code>${m[1]}</code>`);
    else if (m[2] !== undefined) {
      const [ref, label] = m[2].split("|");
      const target = context.bundle && !ref.includes("//") ? `${context.bundle}//${ref.trim()}` : ref.trim();
      out.push(html`<a href="${assetHref(target)}"><code>${label ?? ref}</code></a>`);
    } else if (m[3] !== undefined) out.push(link(m[3], m[4], context));
    else out.push(html`<strong>${m[5]}</strong>`);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return html`${out}`;
}

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

/**
 * Render markdown text to safe HTML. `context` is optional: `ref` and `bundle` anchor `#section` links and
 * bare [[wikilinks]] to the asset, `links` maps raw link targets to indexed refs, and `headings` is the
 * server's heading list ({line, slug}), matched by `line` against `startLine`, the source line of the
 * text's first line (after frontmatter).
 */
export function markdown(source, context = {}) {
  const lines = String(source ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  const slugByLine = new Map((context.headings ?? []).map((h) => [h.line, h.slug]));
  const firstLine = context.startLine ?? 1;
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push(html`<p>${inline(paragraph.join(" "), context)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list.ordered ? html`<ol>${list.items}</ol>` : html`<ul>${list.items}</ul>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = opensFence(line);
    if (fence) {
      flushParagraph();
      flushList();
      const code = [];
      for (i++; i < lines.length && !closesFence(lines[i], fence); i++) code.push(lines[i]);
      blocks.push(html`<pre class="code"><code>${code.join("\n")}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 6);
      const slug = slugByLine.get(firstLine + i);
      blocks.push(
        html`<h${level}${slug ? html` id="${headingId(slug)}"` : ""}>${inline(heading[2].replace(/\s+#+\s*$/, ""), context)}</h${level}>`,
      );
      continue;
    }
    if (line.includes("|") && lines[i + 1]?.includes("|") && TABLE_DELIMITER.test(lines[i + 1])) {
      flushParagraph();
      flushList();
      const headers = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(html`<tr>${cells(lines[i]).map((cell) => html`<td>${inline(cell, context)}</td>`)}</tr>`);
        i++;
      }
      i--;
      blocks.push(
        html`<div class="table-wrap"><table><thead><tr>${headers.map((cell) => html`<th>${inline(cell, context)}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`,
      );
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const ordered = item[2] !== undefined;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
      list.items.push(
        task
          ? html`<li class="task-item"><input type="checkbox" disabled ${task[1].toLowerCase() === "x" ? html`checked` : ""} aria-label="${task[2]}">${inline(task[2], context)}</li>`
          : html`<li>${inline(item[3], context)}</li>`,
      );
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return html`<div class="md">${blocks}</div>`;
}

/**
 * Split leading `---` frontmatter from `content`: { fields: [[key, value]], body, startLine }, where
 * `startLine` is the 1-based source line the body starts on (pass it to {@link markdown}).
 */
export function splitFrontmatter(content) {
  const text = String(content ?? "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { fields: [], body: text, startLine: 1 };
  const fields = [];
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (kv) fields.push([kv[1], kv[2]]);
    else if (fields.length > 0 && line.trim() !== "") fields[fields.length - 1][1] += `\n${line}`;
  }
  return { fields, body: text.slice(m[0].length), startLine: m[0].split("\n").length };
}
