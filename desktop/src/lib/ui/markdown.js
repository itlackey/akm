// Safe document rendering: headings, lists, quotes, tables, task items, fenced code, code spans, emphasis, links and
// [[wikilinks]]. Link targets and heading selectors come from AKM's indexed reads.
// It never touches raw text except through `html`, which escapes every interpolated value.
import { assetHref, html } from "./lib.js";

const SAFE_URL = /^(https?:\/\/|mailto:|#)/i;
const INLINE = /(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)|\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)/g;
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
    // A bare "#x" has no element to land on in rendered Markdown; without an asset to anchor to, show text.
    if (!context.ref) return html`${text}`;
    return html`<a href="${assetHref(context.ref)}&section=${encodeURIComponent(url.slice(1))}">${text}</a>`;
  }
  if (!SAFE_URL.test(url)) return html`${text}`;
  const external = /^(https?:|mailto:)/i.test(url);
  return external
    ? html`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
    : html`<a href="${url}">${text}</a>`;
}

/**
 * The toolbar emits asterisks for emphasis. Keep this small presentation subset:
 * nested bold/italic work, unmatched delimiters stay literal, and raw HTML is
 * always escaped. This is deliberately not a complete CommonMark parser.
 */
function emphasis(text, depth = 0) {
  if (depth >= 16) return html`${text}`;
  const out = [];
  let position = 0;
  while (position < text.length) {
    const opening = /(?<![\\*])\*{1,3}(?![*\s])/g;
    opening.lastIndex = position;
    const start = opening.exec(text);
    if (!start) {
      out.push(text.slice(position));
      break;
    }
    out.push(text.slice(position, start.index));
    const size = start[0].length;
    const closing = /(?<!\\)\*+/g;
    closing.lastIndex = start.index + size;
    let end = closing.exec(text);
    for (; end; end = closing.exec(text)) {
      if ((end[0].length === size || (end[0].length === 3 && size < 3)) && !/\s/.test(text[end.index - 1] ?? " "))
        break;
    }
    if (!end) {
      out.push(start[0]);
      position = start.index + size;
      continue;
    }
    const endAt = end.index + end[0].length - size;
    const inner = emphasis(text.slice(start.index + size, endAt), depth + 1);
    out.push(
      size === 1
        ? html`<em>${inner}</em>`
        : size === 2
          ? html`<strong>${inner}</strong>`
          : html`<strong><em>${inner}</em></strong>`,
    );
    position = endAt + size;
  }
  return html`${out}`;
}

/** Inline spans of one line of text. `context` is the same as for {@link markdown}. */
export function inline(text, context = {}) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out.push(emphasis(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      let code = m[2];
      if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      out.push(html`<code>${code}</code>`);
    } else if (m[3] !== undefined) {
      const [ref, label] = m[3].split("|");
      const target = context.bundle && !ref.includes("//") ? `${context.bundle}//${ref.trim()}` : ref.trim();
      out.push(html`<a href="${assetHref(target)}"><code>${label ?? ref}</code></a>`);
    } else out.push(link(m[4], m[5], context));
    last = m.index + m[0].length;
  }
  out.push(emphasis(text.slice(last)));
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
  let titleSkipped = false;
  let topDepth = null;
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
      blocks.push(
        html`<pre class="code" tabindex="0" role="group" aria-label="Code, scrolls sideways"><code>${code.join("\n")}</code></pre>`,
      );
      continue;
    }
    if (/^ {0,3}>/.test(line) && (context.quoteDepth ?? 0) < 16) {
      flushParagraph();
      flushList();
      const quoted = [],
        startLine = firstLine + i;
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i++;
      }
      i--;
      blocks.push(
        html`<blockquote>${markdown(quoted.join("\n"), { ...context, startLine, skipTitle: undefined, quoteDepth: (context.quoteDepth ?? 0) + 1 })}</blockquote>`,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const slug = slugByLine.get(firstLine + i);
      // The page's own h1 already says this: a body that opens with the same title does not repeat it.
      if (!titleSkipped && context.skipTitle && heading[1].length === 1 && heading[2].trim() === context.skipTitle) {
        titleSkipped = true;
        continue;
      }
      // The page's h1 is the title, so the body's first heading level becomes h2 and no level is skipped.
      topDepth ??= heading[1].length;
      const level = Math.min(Math.max(heading[1].length - topDepth + 2, 2), 6);
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
        html`<div class="table-wrap" tabindex="0" role="group" aria-label="Table"><table><thead><tr>${headers.map((cell) => html`<th>${inline(cell, context)}</th>`)}</tr></thead><tbody>${rows}</tbody></table></div>`,
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
  return context.quoteDepth ? html`${blocks}` : html`<div class="md">${blocks}</div>`;
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
