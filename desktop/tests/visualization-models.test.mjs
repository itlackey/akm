// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGraph,
  colourSlot,
  countSummary,
  drawState,
  edgePairs,
  edgeStrength,
  familyOf,
  highlightCount,
  isPlaced,
  legendRows,
  linkSummary,
  linksOf,
  listed,
  MARK_HIGHLIGHT,
  MARK_USE,
  mapHint,
  markOf,
  offMapReason,
  openingArrangement,
  PAGE_SIZE,
  pageOf,
  placeTip,
  sideList,
  sizeKey,
  sortLabel,
  sortRows,
  useLine,
  useSteps,
  useWindowText,
} from "../src/lib/graph-model.ts";
import { actorOf, replayBins, replaySteps, SCRUB_STEP, scrubTime, totalsAt } from "../src/lib/replay-model.ts";
import { traceRows } from "../src/lib/workflow-trace-model.ts";

const payload = {
  available: true,
  note: "",
  types: ["knowledge", "memory", "widget"],
  bundles: ["wiki", "notes"],
  beliefs: ["superseded", "deprecated"],
  emptyBundles: [],
  use: { since: "2026-08-15T00:00:00.000Z", source: "user" },
  unresolvedLinks: 2,
  kinds: ["xref", "superseded_by"],
  nodes: {
    ref: ["wiki//knowledge/a", "wiki//knowledge/b", "notes//memories/old", "notes//widgets/w"],
    title: ["A", "B", "Old", "W"],
    type: [0, 0, 1, 2],
    bundle: [0, 0, 1, 1],
    belief: [-1, 0, -1, 1],
    shows: [10, 0, 2, 0],
    searches: [30, 1, 0, 0],
  },
  links: { from: [0, 2], to: [1, 0], kind: [0, 1] },
  meaning: { embedded: 2, xyz: [1, 2, 3, null, null, null, 4, 5, 6, null, null, null] },
};

test("the library graph: families, both directions of each link, outdated assets, and positions by meaning", () => {
  const graph = buildGraph(payload);
  assert.equal(graph.count, 4);
  // A type akm does not list is Other, the last family.
  assert.deepEqual([...graph.family], [0, 0, 1, 7]);
  assert.equal(familyOf("skill"), 2);
  // Two bundles in the library: a label names its bundle, so "knowledge/a" in each is not mistaken for one asset.
  assert.equal(graph.name(0), "wiki/knowledge/a");
  assert.equal(graph.path(0), "knowledge/a");
  assert.equal(graph.index.get("notes//memories/old"), 2);
  assert.deepEqual(
    linksOf(graph, 0).map((group) => [group.kind, group.outgoing, group.nodes]),
    [
      ["xref", true, [1]],
      ["superseded_by", false, [2]],
    ],
  );
  // Outdated: the asset that declares superseded_by, and any whose belief is superseded or deprecated.
  assert.deepEqual([...graph.outdated], [0, 1, 1, 1]);
  assert.deepEqual([...graph.placed], [1, 0, 1, 0]);
  assert.deepEqual([...graph.meaning.slice(6, 9)], [4, 5, 6]);
  assert.deepEqual([...edgePairs(graph, (kind) => kind === 0)], [0, 1]);
  assert.equal(colourSlot(graph, 3, "bundle"), 1);
  assert.equal(colourSlot(graph, 3, "use"), -1);
  // Every asset gets a place on the bundle layout, one disc per bundle.
  assert.equal(graph.byBundle.length, 12);
  assert.deepEqual(
    graph.bundleAnchors.map((anchor) => anchor.text),
    ["wiki · 2", "notes · 2"],
  );
  // No embeddings: no positions by meaning.
  assert.equal(buildGraph({ ...payload, meaning: null }).meaning, null);
});

test("the replay: who made each event, hits apart from searches, and totals at any moment", () => {
  const index = new Map([["wiki//knowledge/a", 0]]);
  const at = (minute) => new Date(Date.UTC(2026, 10, 11, 10, minute)).toISOString();
  const events = [
    { id: 3, at: at(2), eventType: "show", ref: "wiki//knowledge/a", source: "user", agent: { harness: "claude" } },
    { id: 1, at: at(0), eventType: "search", query: "deploy", source: "user", resultCount: 0 },
    { id: 2, at: at(1), eventType: "search", ref: "wiki//knowledge/a", source: "improve" },
    { id: 4, at: at(3), eventType: "feedback", ref: "wiki//gone", signal: "negative", source: "task" },
  ];
  assert.equal(actorOf(events[0]), "claude");
  assert.equal(actorOf(events[1]), "No agent recorded");
  const steps = replaySteps(events, index);
  assert.deepEqual(
    steps.map((step) => [step.kind, step.node, step.actor]),
    [
      ["search", -1, "No agent recorded"],
      ["hit", 0, "Improve"],
      ["show", 0, "claude"],
      ["feedback", -1, "Scheduled tasks"],
    ],
  );
  const middle = totalsAt(steps, Date.parse(at(2)));
  assert.equal(middle.searches, 1);
  assert.equal(middle.foundNothing, 1);
  assert.equal(middle.shows, 1);
  assert.equal(middle.used.size, 1);
  assert.deepEqual(middle.misses, [["deploy", 1]]);
  assert.equal(totalsAt(steps, Date.parse(at(9))).negative, 1);
  // A hit is part of its search, so it is not counted again on the lanes.
  const lanes = replayBins(steps, Date.parse(at(0)), Date.parse(at(4)), 4);
  assert.deepEqual(lanes.actors, ["Improve", "No agent recorded", "Scheduled tasks", "claude"]);
  assert.deepEqual(lanes.counts.get("Improve"), [0, 0, 0, 0]);
  assert.deepEqual(lanes.counts.get("claude"), [0, 0, 1, 0]);
  assert.deepEqual(lanes.misses, [1, 0, 0, 0]);
});

test("a workflow trace: a band per step, a bar per attempt, and a step's span taken from its units", () => {
  const t = (seconds) => new Date(Date.UTC(2026, 10, 11, 10, 0, seconds)).toISOString();
  const attempt = (n, from, to, status, failureReason = null, phase = "unit") => ({
    attempt: n,
    phase,
    status,
    startedAt: t(from),
    finishedAt: to === null ? null : t(to),
    tokens: 1,
    failureReason,
  });
  const unit = (unitId, stepId, attempts, status, phase = "unit") => ({
    unitId,
    nodeId: `${stepId}.unit`,
    stepId,
    phase,
    status,
    runtimeKind: "harness",
    engine: null,
    tokens: 10,
    startedAt: attempts[0].startedAt,
    finishedAt: attempts.at(-1).finishedAt,
    failureReason: null,
    diagnostic: null,
    sessionId: null,
    attempts,
  });
  const trace = {
    run: { id: "r", workflowRef: "workflows/w", workflowTitle: "W", status: "active", createdAt: t(0) },
    steps: [
      { id: "review", title: "Review", status: "pending", sequenceIndex: 1, completedAt: null },
      { id: "collect", title: "Collect", status: "completed", sequenceIndex: 0, completedAt: t(9) },
    ],
    units: [
      unit("collect", "collect", [attempt(1, 0, 9, "completed")], "completed"),
      unit(
        "review[a]",
        "review",
        [attempt(1, 10, 40, "failed", "timeout"), attempt(2, 42, null, "running")],
        "running",
      ),
      unit("review·gate", "review", [attempt(1, 50, 55, "completed", null, "gate")], "completed", "gate"),
    ],
    children: [],
  };
  const now = Date.parse(t(60));
  const layout = traceRows(trace, now);
  assert.deepEqual(
    layout.rows.map((row) =>
      row.kind === "step" ? `# ${row.label}` : `${row.label}: ${row.attempts.map((bar) => bar.cls).join(",")}`,
    ),
    ["# Collect", "collect: ok", "# Review", "review[a]: fail,running", "review·gate · gate: gate"],
  );
  // A running attempt ends now; the clock runs from the first start to the last end.
  assert.equal(layout.start, Date.parse(t(0)));
  assert.equal(layout.end, now);
  assert.deepEqual(
    layout.steps.map((step) => [step.title, step.units, step.failed, step.span]),
    [
      ["Collect", 1, 0, 9000],
      ["Review", 2, 0, 50000],
    ],
  );
  assert.equal(layout.done, 2);
  assert.equal(layout.tokens, 30);
});

test("the scrubber reaches the end of a window that is not a whole number of steps", () => {
  const start = Date.parse("2026-11-04T10:00:00.500Z");
  const end = start + 7 * 86_400_000 - 1;
  // The largest value a range input with this min and step can hold is short of `end`.
  const last = start + Math.floor((end - start) / SCRUB_STEP) * SCRUB_STEP;
  assert.ok(last < end);
  assert.equal(scrubTime(last, start, end), end);
  assert.equal(scrubTime(start, start, end), start);
  assert.equal(scrubTime(last - SCRUB_STEP, start, end), last - SCRUB_STEP);
});

// ---- The library map's model: placement, filters, counts, use colouring, the table ----

/** Ten assets in three bundles; 0..5 have positions by meaning, 6..9 do not. Links include A->B and B->A. */
const big = {
  available: true,
  note: "10 assets.",
  types: ["knowledge", "skill"],
  bundles: ["wiki", "notes", "tiny"],
  beliefs: ["superseded", "contradicted", "deprecated"],
  emptyBundles: ["empty"],
  use: { since: "2026-08-15T00:00:00.000Z", source: "user" },
  unresolvedLinks: 3,
  kinds: ["xref", "superseded_by"],
  nodes: {
    ref: [
      "wiki//knowledge/a",
      "wiki//knowledge/b",
      "wiki//skills/s",
      "notes//knowledge/a",
      "notes//knowledge/z",
      "tiny//knowledge/t",
      "wiki//knowledge/c",
      "wiki//knowledge/d",
      "notes//knowledge/m",
      "notes//skills/q",
    ],
    title: ["Alpha", "Bravo", "Skill", "Alpha two", "Zulu", "Tiny", "C", "D", "M", "Q"],
    type: [0, 0, 1, 0, 0, 0, 0, 0, 0, 1],
    bundle: [0, 0, 0, 1, 1, 2, 0, 0, 1, 1],
    belief: [-1, 0, -1, -1, 2, -1, -1, 1, -1, -1],
    shows: [40, 0, 3, 0, 9, 1, 0, 0, 0, 0],
    searches: [5, 0, 1, 2, 0, 0, 0, 0, 0, 0],
  },
  links: { from: [0, 1, 0, 2, 6, 6], to: [1, 0, 3, 3, 7, 0], kind: [0, 0, 0, 1, 0, 0] },
  meaning: {
    embedded: 6,
    xyz: [...Array.from({ length: 18 }, (_, n) => n + 1), ...Array(12).fill(null)],
  },
};
const base = (_graph, over = {}) => ({
  arrange: "meaning",
  colourBy: "family",
  lens: "",
  query: "",
  hidden: [],
  ...over,
});

test("placement is decided in one place: by meaning, assets without an embedding are not drawn, not even by their links", () => {
  const graph = buildGraph(big);
  assert.deepEqual([...graph.placed], [1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
  assert.equal(isPlaced(graph, "meaning", 6), false);
  assert.equal(isPlaced(graph, "bundle", 6), true);
  const state = drawState(graph, base(graph), -1, []);
  assert.deepEqual([...state.slice(0, 6)], [1, 1, 1, 1, 1, 1]);
  assert.deepEqual([...state.slice(6)], [3, 3, 3, 3]);
  // Every asset is placed on the bundle layout.
  assert.ok(!drawState(graph, base(graph, { arrange: "bundle" }), -1, []).includes(3));
  assert.equal(openingArrangement(graph), "meaning");
  assert.equal(openingArrangement(graph, 7), "bundle");
  assert.equal(openingArrangement(graph, 2), "meaning");
  assert.equal(openingArrangement(buildGraph({ ...big, meaning: null })), "bundle");
});

test("the table, the count and the side list use the whole library; only the drawing leaves unplaced assets out", () => {
  const graph = buildGraph(big);
  const f = base(graph);
  const all = listed(graph, f);
  assert.equal(all.length, 10);
  assert.deepEqual(all.slice(0, 3), [0, 4, 2]);
  const summary = countSummary(graph, f, all);
  assert.equal(summary.total, 10);
  assert.equal(summary.notPlaced, 4);
  assert.equal(summary.text, "10 of 10 assets · 4 not placed");
  // A search names itself in the count, and counts only its own unplaced matches.
  const found = listed(graph, base(graph, { query: "knowledge/d" }));
  assert.deepEqual(found, [7]);
  assert.equal(
    countSummary(graph, base(graph, { query: "knowledge/d" }), found).text,
    "1 of 10 assets · matching “knowledge/d” · 1 not placed",
  );
  assert.equal(offMapReason(graph, f, 7), "Not placed: it has no position by meaning. Arrange by bundle to see it.");
  assert.equal(offMapReason(graph, f, 0), null);
});

test("hiding a group hides it (state 3) and the count says how many are hidden", () => {
  const graph = buildGraph(big);
  const f = base(graph, { arrange: "bundle", hidden: [2] }); // the Skills family
  const state = drawState(graph, f, -1, []);
  assert.equal(state[2], 3);
  assert.equal(state[9], 3);
  assert.equal(state[0], 1);
  assert.equal(listed(graph, f).length, 8);
  assert.equal(countSummary(graph, f, listed(graph, f)).text, "8 of 10 assets · 2 hidden");
  assert.equal(offMapReason(graph, f, 2), "In a hidden group: show the group in the legend first.");
  // Under Use colouring the legend has no groups, so nothing is hidden.
  assert.ok(!drawState(graph, { ...f, colourBy: "use" }, -1, []).includes(3));
  // Edges touching a hidden asset are not drawn, so the link count follows the state.
  assert.deepEqual(linkSummary(graph, state, []), { pairs: 4, declared: 5 });
});

test("a selection lights its neighbours through link kinds that are on, not through ones switched off", () => {
  const graph = buildGraph(big);
  const f = base(graph, { arrange: "bundle" });
  // Asset 3 is linked from 0 (xref) and from 2 (superseded_by).
  assert.deepEqual(
    [...drawState(graph, f, 3, [])].flatMap((s, i) => (s >= 1 ? [i] : [])),
    [0, 2, 3],
  );
  assert.deepEqual(
    [...drawState(graph, f, 3, [1])].flatMap((s, i) => (s >= 1 ? [i] : [])),
    [0, 3],
  );
  assert.deepEqual(
    linksOf(graph, 3, [1]).map((g) => g.kind),
    ["xref"],
  );
  assert.deepEqual(
    linksOf(graph, 3).map((g) => g.kind),
    ["xref", "superseded_by"],
  );
});

test("a selected asset with no position by meaning lights nothing on the drawing", () => {
  const graph = buildGraph(big);
  const state = drawState(graph, base(graph), 6, []);
  assert.equal(state[6], 3);
  assert.deepEqual([...state.slice(0, 6)], [1, 1, 1, 1, 1, 1]);
});

test("links count pairs, not declarations: A to B and B to A are one line and counted once", () => {
  const graph = buildGraph(big);
  assert.equal(graph.from.length, 6);
  assert.equal(edgePairs(graph, () => true).length / 2, 5);
  const state = drawState(graph, base(graph, { arrange: "bundle" }), -1, []);
  assert.deepEqual(linkSummary(graph, state, []), { pairs: 5, declared: 6 });
  assert.deepEqual(linkSummary(graph, state, [1]), { pairs: 4, declared: 5 });
  // By meaning, links to unplaced assets are not drawn.
  assert.deepEqual(linkSummary(graph, drawState(graph, base(graph), -1, []), []), { pairs: 3, declared: 4 });
  assert.equal(graph.unresolvedLinks, 3);
});

test("the highlight is from the belief column and the links that say so, and counts what it marks", () => {
  const graph = buildGraph(big);
  // 1 superseded, 4 deprecated, 7 contradicted by belief; 2 declares superseded_by.
  assert.deepEqual([...graph.outdated], [0, 1, 1, 0, 1, 0, 0, 1, 0, 0]);
  assert.equal(highlightCount(graph, "outdated"), 4);
  assert.equal(highlightCount(graph, "never"), 6);
  assert.equal(highlightCount(graph, ""), 0);
  const marked = drawState(graph, base(graph, { arrange: "bundle", lens: "outdated" }), -1, []);
  assert.deepEqual(
    [...marked].flatMap((s, i) => (s === 2 ? [i] : [])),
    [1, 2, 4, 7],
  );
  // Marked assets take the highlight colour, which is not one of the eight; others keep their own.
  const { stepOf } = useSteps(graph.shows);
  const by = { colourBy: "family", lens: "outdated" };
  assert.equal(markOf(graph, 1, by, stepOf), MARK_HIGHLIGHT);
  assert.equal(markOf(graph, 0, by, stepOf), 0);
});

test("Use colouring: never shown is its own mark, used assets fall in steps from the quantiles of the non-zero shows", () => {
  const shows = [0, 0, 1, 1, 2, 3, 5, 8, 13, 40];
  const { steps, stepOf } = useSteps(shows);
  assert.deepEqual(
    steps.map((s) => [s.from, s.to, s.count, s.label]),
    [
      [1, 1, 2, "1"],
      [2, 4, 2, "2–4"],
      [5, 12, 2, "5–12"],
      [13, null, 2, "13+"],
    ],
  );
  assert.deepEqual([0, 1, 2, 3, 4, 5, 7, 8, 40].map(stepOf), [0, 1, 2, 2, 2, 3, 3, 3, 4]);
  // Few distinct counts: fewer steps, never an empty one.
  assert.deepEqual(
    useSteps([0, 1, 1, 1]).steps.map((s) => s.label),
    ["1+"],
  );
  assert.deepEqual(useSteps([0, 0]).steps, []);
  assert.equal(useSteps([0, 0]).stepOf(0), 0);
  // The mark an asset is painted with: use steps follow the eight slots and the highlight.
  const graph = buildGraph(big);
  const stats = useSteps(graph.shows);
  assert.equal(markOf(graph, 1, { colourBy: "use", lens: "" }, stats.stepOf), MARK_USE);
  assert.ok(markOf(graph, 0, { colourBy: "use", lens: "" }, stats.stepOf) > MARK_USE);
});

test("the size key shows examples the drawing can match: none, a quarter, the largest", () => {
  assert.deepEqual(sizeKey(40), [0, 10, 40]);
  assert.deepEqual(sizeKey(1), [0, 1]);
  assert.deepEqual(sizeKey(0), [0]);
  // Size means shows only: searches add nothing.
  const graph = buildGraph(big);
  assert.deepEqual([...graph.size], [...graph.shows]);
});

test("the side list names what it lists, and says so when nothing was shown", () => {
  const graph = buildGraph(big);
  const since = "15 Aug 2026";
  const plain = sideList(graph, base(graph), listed(graph, base(graph)), since);
  assert.equal(plain.title, "Most shown");
  assert.ok(plain.items.every((i) => graph.shows[i] > 0));
  assert.deepEqual(plain.items, [0, 4, 2, 5]);
  const never = base(graph, { lens: "never" });
  const list = sideList(graph, never, listed(graph, never), since);
  assert.equal(list.title, "Never shown");
  assert.ok(list.items.every((i) => graph.shows[i] === 0));
  assert.equal(
    sideList(graph, base(graph, { lens: "outdated" }), listed(graph, base(graph, { lens: "outdated" })), since).title,
    "Superseded, contradicted or deprecated",
  );
  const unused = buildGraph({ ...big, nodes: { ...big.nodes, shows: big.nodes.shows.map(() => 0) } });
  const none = sideList(unused, base(unused), listed(unused, base(unused)), since);
  assert.deepEqual(none.items, []);
  assert.equal(none.empty, "No asset has been shown since 15 Aug 2026.");
});

test("bundle colour slots follow the payload's order (largest first), and the ninth bundle on shares Other", () => {
  const names = Array.from({ length: 10 }, (_, n) => `b${n}`);
  const many = {
    ...big,
    bundles: names,
    nodes: { ...big.nodes, bundle: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
  };
  const graph = buildGraph(many);
  assert.deepEqual(
    [0, 1, 7, 8, 9].map((i) => colourSlot(graph, i, "bundle")),
    [0, 1, 7, 7, 7],
  );
  assert.deepEqual(
    legendRows(graph, "bundle").map((row) => row.label),
    [...names.slice(0, 7), "Other bundles"],
  );
  assert.equal(legendRows(graph, "bundle").at(-1).count, 3);
});

test("inside a bundle disc assets sit by type family and then ref, so one folder sits together", () => {
  const refs = ["w//knowledge/z/1", "w//knowledge/a/1", "w//knowledge/z/0", "w//knowledge/a/0"];
  const graph = buildGraph({
    ...big,
    bundles: ["w"],
    types: ["knowledge"],
    nodes: {
      ref: refs,
      title: refs,
      type: [0, 0, 0, 0],
      bundle: [0, 0, 0, 0],
      belief: [-1, -1, -1, -1],
      shows: [0, 0, 0, 0],
      searches: [0, 0, 0, 0],
    },
    links: { from: [], to: [], kind: [] },
    meaning: null,
  });
  // The sunflower spiral puts the first in the order nearest the centre: a/0 < a/1 < z/0 < z/1.
  const radius = (i) => Math.hypot(graph.byBundle[i * 3], graph.byBundle[i * 3 + 2]);
  assert.ok(radius(3) < radius(1) && radius(1) < radius(2) && radius(2) < radius(0));
});

test("on the bundle arrangement links are faint until an asset is selected", () => {
  assert.ok(edgeStrength("bundle", -1) < 0.5);
  assert.equal(edgeStrength("bundle", 4), 1);
  assert.equal(edgeStrength("meaning", -1), 1);
});

test("labels name the bundle when there is more than one, and not otherwise", () => {
  const single = buildGraph({
    ...big,
    bundles: ["only"],
    nodes: { ...big.nodes, bundle: big.nodes.bundle.map(() => 0) },
  });
  assert.equal(single.name(0), "knowledge/a");
  const graph = buildGraph(big);
  // "knowledge/a" exists in both wiki and notes.
  assert.notEqual(graph.name(0), graph.name(3));
  assert.equal(graph.name(3), "notes/knowledge/a");
});

test("the table's links column counts distinct linked assets, not declarations in both directions", () => {
  const graph = buildGraph(big);
  // Asset 0: 1 (declared both ways), 3, and 6 once.
  assert.deepEqual([...graph.linked].slice(0, 4), [3, 1, 1, 2]);
  assert.equal(graph.offsets[1] - graph.offsets[0], 4);
});

test("table rows sort by any column with the ref as the tie-break, and page in hundreds", () => {
  const graph = buildGraph(big);
  const rows = [...Array(10).keys()];
  assert.deepEqual(sortRows(graph, rows, "shows", "descending").slice(0, 3), [0, 4, 2]);
  assert.deepEqual(sortRows(graph, rows, "shows", "ascending").slice(0, 3), [3, 8, 9]);
  assert.deepEqual(sortRows(graph, rows, "links", "descending").slice(0, 2), [0, 3]);
  assert.equal(sortRows(graph, rows, "ref", "ascending")[0], 3);
  assert.deepEqual(sortRows(graph, rows, "bundle", "ascending").slice(0, 2), [3, 8]);
  assert.equal(graph.types[graph.type[sortRows(graph, rows, "type", "descending")[0]]], "skill");
  assert.equal(sortLabel("shows", "descending"), "most shown first");
  assert.equal(sortLabel("bundle", "ascending"), "by bundle, ascending");
  assert.equal(PAGE_SIZE, 100);
  assert.deepEqual(pageOf(250, 1), { page: 1, pages: 3, start: 100, end: 200, label: "Rows 101–200 of 250" });
  assert.equal(pageOf(250, 9).label, "Rows 201–250 of 250");
  assert.equal(pageOf(0, 0).label, "No rows");
});

test("words: the use window, the use line, and a hint for the mode and the input", () => {
  assert.equal(useLine(1, 1), "Shown 1 time, in 1 search");
  assert.equal(useLine(3, 12), "Shown 3 times, in 12 searches");
  assert.equal(
    useWindowText("15 Aug 2026"),
    "Reads by you and your agents since 15 Aug 2026; scheduled tasks and Improve are not counted.",
  );
  assert.match(mapHint(false, false), /Drag to turn/);
  assert.match(mapHint(false, false), /Shift-drag to pan/);
  assert.doesNotMatch(mapHint(true, false), /turn|Shift/);
  assert.match(mapHint(true, false), /Drag to pan/);
  assert.match(mapHint(true, false), /Esc clears/);
  assert.match(mapHint(false, true), /Pinch/);
  assert.doesNotMatch(mapHint(false, true), /Scroll|Shift|Click/);
});

test("a tooltip stays inside the stage: it flips beside the pointer and is clamped", () => {
  const stage = { w: 800, h: 600 };
  const tip = { w: 300, h: 60 };
  assert.deepEqual(placeTip({ x: 100, y: 100 }, tip, stage), { x: 114, y: 114 });
  assert.deepEqual(placeTip({ x: 700, y: 100 }, tip, stage), { x: 386, y: 114 });
  assert.deepEqual(placeTip({ x: 100, y: 580 }, tip, stage), { x: 114, y: 506 });
  assert.deepEqual(placeTip({ x: 100, y: 100 }, { w: 900, h: 60 }, stage), { x: 0, y: 114 });
});
