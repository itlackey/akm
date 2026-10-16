// Line and word diffs for the proposal page. Pure functions on strings: no DOM, no markup, so the algorithm can be
// tested on its own. diff-view.js turns the result into markup.
//
// The server's unified diff pairs lines by position, so one inserted line makes every later line look changed. This
// module aligns the two texts properly (Myers' O(ND) shortest edit script) and returns aligned rows, grouped into
// hunks with a few lines of context around each change and the long unchanged runs between hunks left as gaps.

/** Most lines on either side we are willing to align; above this the caller shows the server's unified text. */
export const MAX_LINES = 5000;
/** Most inserted plus deleted lines Myers' search explores before giving up (the search costs memory ~ edits squared). */
export const MAX_EDITS = 2000;
/** Unchanged lines kept around each change. */
export const CONTEXT = 3;
/** An unchanged run shorter than this is shown rather than collapsed behind a control. */
export const MIN_COLLAPSE = 4;
/** Longest line (in tokens) that gets an intra-line word diff. */
const MAX_WORD_TOKENS = 400;
/** Below this share of matching characters a changed pair is two unrelated lines: no word highlights. */
const MIN_SIMILARITY = 0.3;

/** Lines of `text`: LF and CRLF both end a line, and the newline ending the file is not a line of its own. */
export function splitLines(text) {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Shortest edit script between two line arrays as `{ type: "eq" | "del" | "add", a, b }` (0-based indexes), or `null` past {@link MAX_EDITS}. */
export function lineOps(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = myers(a.slice(start, endA), b.slice(start, endB));
  if (middle === null) return null;
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: "eq", a: i, b: i });
  for (const op of middle)
    ops.push({ type: op.type, a: op.a === null ? null : op.a + start, b: op.b === null ? null : op.b + start });
  for (let i = 0; i < a.length - endA; i++) ops.push({ type: "eq", a: endA + i, b: endB + i });
  return ops;
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return [...a.map((_, i) => ({ type: "del", a: i, b: null })), ...b.map((_, j) => ({ type: "add", a: null, b: j }))];
  }
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] is v as it was before round d, restricted to the diagonals round d can read: -d-1 .. d+1.
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  return null;
}

function backtrack(trace, a, b) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const at = (k) => trace[d][k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ type: "eq", a: x, b: y });
    }
    if (d > 0) {
      if (down) ops.push({ type: "add", a: null, b: prevY });
      else ops.push({ type: "del", a: prevX, b: null });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

// ---- words -----------------------------------------------------------------

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/**
 * Which parts of two changed lines differ, as `[leftMarks, rightMarks]`, each a list of `[text, changed]`. `null` when
 * the lines have too little in common for highlights to help (the whole-line tint says enough) or are too long.
 */
export function wordMarks(left, right) {
  const a = left.match(TOKEN) ?? [];
  const b = right.match(TOKEN) ?? [];
  if (a.length > MAX_WORD_TOKENS || b.length > MAX_WORD_TOKENS) return null;
  const w = b.length + 1;
  const table = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] =
        a[i] === b[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  const keepA = new Array(a.length).fill(false);
  const keepB = new Array(b.length).fill(false);
  let common = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (a[i] === b[j]) {
      keepA[i] = keepB[j] = true;
      common += a[i].length;
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i++;
    else j++;
  }
  if (left.length + right.length === 0 || (2 * common) / (left.length + right.length) < MIN_SIMILARITY) return null;
  return [marks(a, keepA), marks(b, keepB)];
}

/** Adjacent tokens with the same status become one run; whitespace between two changed runs joins them. */
function marks(tokens, keep) {
  const runs = [];
  tokens.forEach((token, i) => {
    const changed = !keep[i];
    const last = runs[runs.length - 1];
    if (last && last[1] === changed) last[0] += token;
    else runs.push([token, changed]);
  });
  for (let i = 1; i < runs.length - 1; i++) {
    const run = runs[i];
    if (!run[1] && /^\s+$/.test(run[0]) && runs[i - 1][1] && runs[i + 1][1]) run[1] = true;
  }
  const merged = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && last[1] === run[1]) last[0] += run[0];
    else merged.push([run[0], run[1]]);
  }
  return merged;
}

// ---- rows and hunks --------------------------------------------------------

function cell(n, text, marked) {
  return { n, text, marks: marked };
}

/**
 * Align `before` and `after` (strings; `null` is an asset that does not exist yet) into rows. Each row is
 * `{ kind, block, left, right }` where `kind` is `ctx`, `del`, `add` or `mod` (a deleted and an added line paired up),
 * `left`/`right` are `{ n, text, marks }` (1-based line number, text, word marks or `null`) or `null` for the empty
 * side, and `block` numbers each run of changed rows.
 *
 * Returns `null` when the texts are too large to align; the caller falls back to the server's unified diff.
 * Otherwise `{ rows, parts, added, removed, same }`: `parts` is the rows in order as `{ type: "hunk" | "gap", rows }`
 * (a hunk is changed rows with {@link CONTEXT} lines either side; a gap is a long unchanged run), `added`/`removed`
 * count lines, and `same` says the lines are equal (the texts may still differ in line endings or the last newline).
 */
export function buildDiff(before, after) {
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null;
  const ops = lineOps(a, b);
  if (ops === null) return null;

  const rows = [];
  let block = 0;
  let added = 0;
  let removed = 0;
  for (let i = 0; i < ops.length; ) {
    const op = ops[i];
    if (op.type === "eq") {
      rows.push({
        kind: "ctx",
        block: null,
        left: cell(op.a + 1, a[op.a], null),
        right: cell(op.b + 1, b[op.b], null),
      });
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < ops.length && ops[i].type !== "eq") {
      (ops[i].type === "del" ? dels : adds).push(ops[i]);
      i++;
    }
    block++;
    removed += dels.length;
    added += adds.length;
    for (let r = 0; r < Math.max(dels.length, adds.length); r++) {
      const d = dels[r];
      const p = adds[r];
      const pair = d && p ? wordMarks(a[d.a], b[p.b]) : null;
      rows.push({
        kind: d && p ? "mod" : d ? "del" : "add",
        block,
        left: d ? cell(d.a + 1, a[d.a], pair?.[0] ?? null) : null,
        right: p ? cell(p.b + 1, b[p.b], pair?.[1] ?? null) : null,
      });
    }
  }
  return { rows, parts: group(rows), added, removed, same: added === 0 && removed === 0 };
}

/** Split rows into hunks (changes plus context) and gaps (unchanged runs worth collapsing). */
function group(rows) {
  const visible = new Array(rows.length).fill(false);
  rows.forEach((row, i) => {
    if (row.kind === "ctx") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) visible[k] = true;
  });
  // A hidden run too short to be worth a control stays visible.
  for (let i = 0; i < rows.length; ) {
    if (visible[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < rows.length && !visible[end]) end++;
    if (end - i < MIN_COLLAPSE && visible.includes(true)) for (let k = i; k < end; k++) visible[k] = true;
    i = end;
  }
  const parts = [];
  for (let i = 0; i < rows.length; ) {
    let end = i;
    while (end < rows.length && visible[end] === visible[i]) end++;
    parts.push({ type: visible[i] ? "hunk" : "gap", rows: rows.slice(i, end) });
    i = end;
  }
  return parts;
}

/** The rows of a file with no earlier version: every line added. */
export function newFileRows(after) {
  return splitLines(after ?? "").map((text, i) => ({
    kind: "add",
    block: 1,
    left: null,
    right: cell(i + 1, text, null),
  }));
}
