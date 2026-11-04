// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Small textarea operations, not a Markdown parser or alternate content model. */
export const markdownCommands = [
  { id: "bold", label: "Bold", text: "B", shortcut: "Ctrl/⌘ B" },
  { id: "italic", label: "Italic", text: "I", shortcut: "Ctrl/⌘ I" },
  { id: "heading", label: "Heading", text: "H2" },
  { id: "link", label: "Insert link", text: "Link", shortcut: "Ctrl/⌘ K" },
  { id: "bullet", label: "Bullet list", text: "• List" },
  { id: "number", label: "Numbered list", text: "1. List" },
  { id: "quote", label: "Quote", text: "Quote" },
  { id: "code", label: "Code", text: "</>" },
];

/** @param {string} content @param {number} from @param {number} to @param {string} command */
export function formatMarkdown(content, from, to, command) {
  let start = Math.max(0, Math.min(content.length, from));
  let end = Math.max(start, Math.min(content.length, to));
  const selected = content.slice(start, end);
  const replace = (/** @type {string} */ text, selectionStart = 0, selectionEnd = text.length) => ({
    content: content.slice(0, start) + text + content.slice(end),
    start: start + selectionStart,
    end: start + selectionEnd,
  });
  if (command === "bold" || command === "italic") {
    const mark = command === "bold" ? "**" : "*";
    if (selected.startsWith(mark) && selected.endsWith(mark) && selected.length > mark.length * 2) {
      return replace(selected.slice(mark.length, -mark.length));
    }
    if (content.slice(start - mark.length, start) === mark && content.slice(end, end + mark.length) === mark) {
      start -= mark.length;
      end += mark.length;
      return replace(selected);
    }
    const leading = selected.match(/^\s*/)?.[0] ?? "";
    const trailing = selected.trim() ? (selected.match(/\s*$/)?.[0] ?? "") : "";
    const text = selected.trim() || (command === "bold" ? "bold text" : "italic text");
    return replace(
      leading + mark + text + mark + trailing,
      leading.length + mark.length,
      leading.length + mark.length + text.length,
    );
  }
  if (command === "link") {
    const label = selected || "link text";
    const prefix = `[${label}](`;
    return replace(`${prefix}https://)`, prefix.length, prefix.length + 8);
  }
  if (command === "code") {
    const text = selected || "code";
    const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
    if (text.includes("\n")) {
      const fence = "`".repeat(Math.max(3, longest + 1));
      const before = start > 0 && content[start - 1] !== "\n" ? "\n" : "";
      const after = end < content.length && content[end] !== "\n" ? "\n" : "";
      const prefix = `${before}${fence}\n`;
      return replace(`${prefix}${text}\n${fence}${after}`, prefix.length, prefix.length + text.length);
    }
    const fence = "`".repeat(longest + 1);
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return replace(
      fence + pad + text + pad + fence,
      fence.length + pad.length,
      fence.length + pad.length + text.length,
    );
  }
  if (!["heading", "bullet", "number", "quote"].includes(command)) return { content, start, end };
  start = start === 0 ? 0 : content.lastIndexOf("\n", start - 1) + 1;
  // A selection ending at the next line's first column does not include that line.
  const last = end > start && content[end - 1] === "\n" ? end - 1 : end;
  const newline = content.indexOf("\n", last);
  end = newline < 0 ? content.length : newline;
  const lines = content.slice(start, end).split("\n");
  const marker =
    command === "heading"
      ? /^#{1,6}\s+/
      : command === "quote"
        ? /^>\s?/
        : command === "bullet"
          ? /^[-*+]\s+/
          : /^\d+\.\s+/;
  const remove = lines.every((line) => marker.test(line));
  const changed = lines
    .map((line, index) => {
      if (remove) return line.replace(marker, "");
      const prefix =
        command === "heading" ? "## " : command === "quote" ? "> " : command === "bullet" ? "- " : `${index + 1}. `;
      const previous =
        command === "heading"
          ? /^#{1,6}\s+/
          : command === "bullet" || command === "number"
            ? /^(?:[-*+]|\d+\.)\s+/
            : /^>\s?/;
      return prefix + line.replace(previous, "");
    })
    .join("\n");
  return replace(changed);
}
