// The proposal diff on the proposal page: side by side or inline, built from diff.js's aligned rows.
//
// Like every page module this builds markup with `html` (so file text is escaped) and writes it with `mount`. The
// layout choice lives in localStorage when it can; the buttons and "Show N unchanged lines" controls are wired by
// addEventListener on the region this render created.

import { buildDiff, newFileRows, splitLines } from "./diff.js";
import { html, mount } from "./lib.js";

const MODE_KEY = "akm-ui-diff-mode";
const NARROW = "(max-width: 799px)";

/** The saved layout, else side by side (inline on a narrow screen). */
export function preferredMode() {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === "side" || saved === "inline") return saved;
  } catch {
    // Storage can be blocked; fall through to the default.
  }
  return typeof globalThis.matchMedia === "function" && globalThis.matchMedia(NARROW).matches ? "inline" : "side";
}

function saveMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // The choice then lasts for this page only.
  }
}

// ---- unified text (the fallback) -------------------------------------------

function unifiedLines(unified) {
  return unified.split("\n").map((line) => {
    let cls = "ctx";
    if (line.startsWith("+++") || line.startsWith("---")) cls = "meta";
    else if (line.startsWith("@@")) cls = "hunk";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    return html`<span class="dl ${cls}">${line === "" ? " " : line}</span>`;
  });
}

function unifiedView(unified, note) {
  return html`${note ? html`<p class="muted small">${note}</p>` : ""}<pre class="diff" tabindex="0">${unifiedLines(unified ?? "")}</pre>`;
}

// ---- rows ------------------------------------------------------------------

function code(cell) {
  return cell.marks
    ? cell.marks.map(([text, changed]) => (changed ? html`<span class="w">${text}</span>` : text))
    : cell.text;
}

const SIGN = { ctx: " ", del: "-", add: "+" };

/** Parts to a flat list of `{ row }` and `{ gap, count }`; an expanded gap contributes its rows. */
function items(parts, expanded) {
  const out = [];
  parts.forEach((part, index) => {
    if (part.type === "gap" && !expanded.has(index)) out.push({ gap: index, count: part.rows.length });
    else for (const row of part.rows) out.push({ row });
  });
  return out;
}

function gapButton(item) {
  return html`<button type="button" class="gap-btn" data-gap="${item.gap}">Show ${item.count} unchanged lines</button>`;
}

function sideRow(cell, kind) {
  if (!cell)
    return html`<div class="drow fill" aria-hidden="true"><span class="ln"></span><span class="sign"></span><span class="code"></span></div>`;
  return html`<div class="drow ${kind}"><span class="ln">${cell.n}</span><span class="sign">${SIGN[kind]}</span><span class="code">${code(cell)}</span></div>`;
}

function sidePane(title, list, side) {
  const rows = list.map((item) => {
    if (item.gap !== undefined) {
      return side === "left"
        ? html`<div class="drow gap">${gapButton(item)}</div>`
        : html`<div class="drow gap" aria-hidden="true"><span class="gap-label">${item.count} unchanged lines</span></div>`;
    }
    const { row } = item;
    const kind = row.kind === "ctx" ? "ctx" : side === "left" ? "del" : "add";
    return sideRow(row[side], kind);
  });
  return html`<div class="sbs-pane"><div class="sbs-head">${title}</div><div class="dcol" tabindex="0" role="region" aria-label="${title} version, scrolls sideways"><div class="dcol-body">${rows}</div></div></div>`;
}

function sideBySide(parts, expanded) {
  const list = items(parts, expanded);
  return html`<div class="sbs">${sidePane("Current", list, "left")}${sidePane("Proposed", list, "right")}</div>`;
}

/** Inline order: a changed block lists its removed lines, then its added lines. */
function inlineList(list) {
  const out = [];
  let pending = [];
  const flush = () => {
    for (const row of pending) if (row.left) out.push({ kind: "del", old: row.left.n, now: null, cell: row.left });
    for (const row of pending) if (row.right) out.push({ kind: "add", old: null, now: row.right.n, cell: row.right });
    pending = [];
  };
  for (const item of list) {
    if (item.gap !== undefined) {
      flush();
      out.push(item);
    } else if (item.row.kind === "ctx") {
      flush();
      out.push({ kind: "ctx", old: item.row.left.n, now: item.row.right.n, cell: item.row.left });
    } else pending.push(item.row);
  }
  flush();
  return out;
}

function inlineView(list) {
  const rows = list.map((line) =>
    line.gap !== undefined
      ? html`<div class="drow gap">${gapButton(line)}</div>`
      : html`<div class="drow ${line.kind}"><span class="ln">${line.old}</span><span class="ln">${line.now}</span><span class="sign">${SIGN[line.kind]}</span><span class="code">${code(line.cell)}</span></div>`,
  );
  return html`<div class="dcol inline" tabindex="0" role="region" aria-label="Changes, scrolls sideways"><div class="dcol-body">${rows}</div></div>`;
}

// ---- the section -----------------------------------------------------------

function toolbar(mode, model) {
  const button = (value, label) =>
    html`<button type="button" data-diff-mode="${value}" aria-pressed="${mode === value ? "true" : "false"}">${label}</button>`;
  return html`<div class="diff-bar"><div class="seg" role="group" aria-label="Diff layout">${button("side", "Side by side")}${button("inline", "Inline")}</div>
    <span class="small muted num">${model.added} added, ${model.removed} removed</span></div>`;
}

function aligned(model, before, after, state) {
  if (model.same) {
    return html`<p class="muted">No line differs between the current asset and the proposal${before === after ? "" : ", only line endings or the final newline"}.</p>`;
  }
  const body =
    state.mode === "inline"
      ? inlineView(inlineList(items(model.parts, state.expanded)))
      : sideBySide(model.parts, state.expanded);
  return html`${toolbar(state.mode, model)}${body}`;
}

/**
 * The diff block for a proposal's `diff` from GET /api/proposals/:id: `{ markup, wire }`. `wire(root)` (absent when the block has no controls) attaches the
 * layout toggle and the unchanged-run controls once `markup` is mounted.
 */
export function diffSection(diff) {
  const none = null;
  if (diff.redacted) return { markup: unifiedView(diff.unified, ""), wire: none };
  const hasSides = typeof diff.after === "string" && !diff.truncated;
  if (!hasSides) {
    const note = diff.truncated ? "This file is too large to line up here, so the plain diff is shown." : "";
    return { markup: unifiedView(diff.unified, note), wire: none };
  }
  if (typeof diff.before !== "string") {
    // A new asset: the whole file, every line added.
    const model = { parts: [{ type: "hunk", rows: newFileRows(diff.after) }] };
    return {
      markup: html`<p class="muted small num">${splitLines(diff.after).length} lines added</p>${inlineView(inlineList(items(model.parts, new Set())))}`,
      wire: none,
    };
  }
  const model = buildDiff(diff.before, diff.after);
  if (model === null) {
    return {
      markup: unifiedView(diff.unified, "This file is too large to line up here, so the plain diff is shown."),
      wire: none,
    };
  }
  const state = { mode: preferredMode(), expanded: new Set() };
  const view = () => html`<div class="diffview" data-diffview>${aligned(model, diff.before, diff.after, state)}</div>`;
  return {
    markup: view(),
    wire(root) {
      const region = root.querySelector("[data-diffview]");
      if (!region) return;
      const draw = () => mount(region, aligned(model, diff.before, diff.after, state));
      region.addEventListener("click", (event) => {
        const modeButton = event.target.closest?.("[data-diff-mode]");
        if (modeButton) {
          state.mode = modeButton.dataset.diffMode === "inline" ? "inline" : "side";
          saveMode(state.mode);
          draw();
          region.querySelector(`[data-diff-mode="${state.mode}"]`)?.focus();
          return;
        }
        const gap = event.target.closest?.("[data-gap]");
        if (gap) {
          state.expanded.add(Number(gap.dataset.gap));
          draw();
          region.querySelector("[tabindex]")?.focus({ preventScroll: true });
        }
      });
    },
  };
}
