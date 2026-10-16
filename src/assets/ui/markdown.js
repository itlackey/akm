// A deliberately tiny markdown renderer: headings, lists, fenced code, inline code, bold, links and [[wikilinks]].
// It never touches raw text except through `html`, which escapes every interpolated value.

import { assetHref, html } from "./lib.js";

const SAFE_URL = /^(https?:\/\/|mailto:|#)/i;
const INLINE = /`([^`]+)`|\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*/g;

function link(text, url) {
  if (!SAFE_URL.test(url)) return html`${text}`;
  const external = /^(https?:|mailto:)/i.test(url);
  return external
    ? html`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
    : html`<a href="${url}">${text}</a>`;
}

/** Inline spans of one line of text. */
export function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(html`<code>${m[1]}</code>`);
    else if (m[2] !== undefined)
      out.push(html`<a href="${assetHref(m[2].split("|")[0].trim())}"><code>${m[2]}</code></a>`);
    else if (m[3] !== undefined) out.push(link(m[3], m[4]));
    else out.push(html`<strong>${m[5]}</strong>`);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return html`${out}`;
}

/** Render markdown text to safe HTML. */
export function markdown(source) {
  const lines = String(source ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (paragraph.length > 0) blocks.push(html`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list.ordered ? html`<ol>${list.items}</ol>` : html`<ul>${list.items}</ul>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```\s*(\S*)/.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push(html`<pre class="code"><code>${code.join("\n")}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 6);
      blocks.push(html`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const ordered = item[2] !== undefined;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push(html`<li>${inline(item[3])}</li>`);
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

/** Split leading `---` frontmatter from `content`: { fields: [[key, value]], body }. */
export function splitFrontmatter(content) {
  const text = String(content ?? "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { fields: [], body: text };
  const fields = [];
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (kv) fields.push([kv[1], kv[2]]);
    else if (fields.length > 0 && line.trim() !== "") fields[fields.length - 1][1] += `\n${line}`;
  }
  return { fields, body: text.slice(m[0].length) };
}
