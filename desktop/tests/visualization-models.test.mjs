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
import {
  actorOf,
  advance,
  axisLabels,
  describe,
  durationText,
  EVENT_LIMIT,
  emitterAt,
  emitterRing,
  PULSE_PX,
  PULSE_TOKENS,
  playText,
  pulseOf,
  RING_MARGIN,
  replayBins,
  replayState,
  replaySteps,
  SCRUB_STEP,
  SPEEDS,
  scaleText,
  scrubTime,
  stampText,
  totalsAt,
  truncationNote,
  undrawn,
  undrawnText,
  usedList,
} from "../src/lib/replay-model.ts";
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

const replayAt = (minute) => new Date(Date.UTC(2026, 10, 11, 10, minute)).toISOString();
const replayEvents = [
  { id: 3, at: replayAt(2), eventType: "show", ref: "wiki//knowledge/a", source: "user", agent: { harness: "claude" } },
  { id: 1, at: replayAt(0), eventType: "search", query: "deploy", source: "user", resultCount: 0 },
  { id: 2, at: replayAt(1), eventType: "search", ref: "wiki//knowledge/a", source: "improve" },
  { id: 4, at: replayAt(3), eventType: "feedback", ref: "wiki//gone", signal: "negative", source: "task" },
];
const replayIndex = new Map([["wiki//knowledge/a", 0]]);

test("the replay: who made each event, hits apart from searches, and totals at any moment", () => {
  assert.equal(actorOf(replayEvents[0]), "claude");
  assert.equal(actorOf(replayEvents[1]), "No agent recorded");
  const steps = replaySteps(replayEvents, replayIndex);
  assert.deepEqual(
    steps.map((step) => [step.kind, step.node, step.actor]),
    [
      ["search", -1, "No agent recorded"],
      ["hit", 0, "Improve"],
      ["show", 0, "claude"],
      ["feedback", -1, "Scheduled tasks"],
    ],
  );
  const middle = totalsAt(steps, Date.parse(replayAt(2)));
  assert.equal(middle.searches, 1);
  assert.equal(middle.foundNothing, 1);
  assert.equal(middle.shows, 1);
  assert.equal(middle.used.size, 1);
  assert.deepEqual(middle.misses, [["deploy", 1]]);
  assert.equal(totalsAt(steps, Date.parse(replayAt(9))).negative, 1);
});

test("replay lanes (50, 8): busiest first, ties by name without case, one shared scale, a total per lane", () => {
  const at = (minute, actor, extra = {}) => ({
    id: minute,
    at: replayAt(minute),
    eventType: "show",
    source: "user",
    agent: { harness: actor },
    ...extra,
  });
  const steps = replaySteps(
    [at(0, "claude"), at(0, "claude"), at(0, "claude"), at(1, "opencode"), at(2, "Zed"), at(3, "abc"), at(3, "abc")],
    new Map(),
  );
  const lanes = replayBins(steps, Date.parse(replayAt(0)), Date.parse(replayAt(4)), 4);
  // claude 3, abc 2, then opencode and Zed at 1 each: "opencode" before "Zed" ignoring case (a code-point sort puts Zed first).
  assert.deepEqual(lanes.actors, ["claude", "abc", "opencode", "Zed"]);
  assert.deepEqual(
    lanes.actors.map((actor) => lanes.totals.get(actor)),
    [3, 2, 1, 1],
  );
  // One scale for every lane: the largest slice of any lane (claude's 3), not each lane's own largest.
  assert.equal(lanes.max, 3);
  assert.equal(scaleText(3, lanes.width), "Tallest bar = 3 events per 1 minute");
  assert.equal(scaleText(1, 15 * 60_000), "Tallest bar = 1 event per 15 minutes");
  assert.equal(durationText(105 * 60_000), "1 h 45 min");
});

test("replay lanes: a hit is part of its search, and found nothing has one definition for lane and total (49)", () => {
  const steps = replaySteps(replayEvents, replayIndex);
  const lanes = replayBins(steps, Date.parse(replayAt(0)), Date.parse(replayAt(4)), 4);
  assert.deepEqual(lanes.actors, ["claude", "No agent recorded", "Scheduled tasks"]);
  assert.deepEqual(lanes.counts.get("claude"), [0, 0, 1, 0]);
  assert.deepEqual(lanes.misses, [1, 0, 0, 0]);
  // A search that found nothing and recorded no query: the lane counted it, the total and the list did not.
  const unnamed = replaySteps(
    [{ id: 1, at: replayAt(0), eventType: "search", source: "user", resultCount: 0 }],
    new Map(),
  );
  const total = totalsAt(unnamed, Date.parse(replayAt(9)));
  assert.equal(total.foundNothing, replayBins(unnamed, Date.parse(replayAt(0)), Date.parse(replayAt(4)), 4).missTotal);
  assert.deepEqual(total.misses, [["(no query recorded)", 1]]);
});

test("replay: other events (curate) are named and counted, so the lanes and the totals agree (29)", () => {
  const events = [
    ...replayEvents,
    {
      id: 5,
      at: replayAt(3),
      eventType: "curate",
      query: "release notes",
      source: "user",
      agent: { harness: "claude" },
    },
  ];
  const steps = replaySteps(events, replayIndex);
  const end = Date.parse(replayAt(9));
  const total = totalsAt(steps, end);
  assert.equal(total.others, 1);
  assert.equal(describe(steps.at(-1)), "curate “release notes”");
  assert.equal(describe(steps[0]), "searched “deploy”, found nothing");
  const lanes = replayBins(steps, Date.parse(replayAt(0)), end, 4);
  // Every counted event is on a lane, and in a total.
  assert.equal(
    [...lanes.totals.values()].reduce((a, b) => a + b, 0),
    total.events,
  );
  assert.equal(total.events, total.searches + total.shows + total.positive + total.negative + total.others);
});

test("replay (1): assets with no position are hidden, used ones are ringed, the rest faint; events on undrawn assets are counted", () => {
  const graph = buildGraph(payload);
  const used = Uint8Array.from([1, 0, 0, 0]);
  // By meaning only assets 0 and 2 are placed: the unplaced pair are state 3 whatever their use.
  assert.deepEqual([...replayState(graph, "meaning", used)], [2, 3, 1, 3]);
  assert.deepEqual([...replayState(graph, "meaning", Uint8Array.from([1, 1, 1, 1]))], [2, 3, 2, 3]);
  assert.deepEqual([...replayState(graph, "bundle", used)], [2, 1, 1, 1]);
  const index = new Map([
    ["wiki//knowledge/a", 0],
    ["wiki//knowledge/b", 1],
  ]);
  const steps = replaySteps(
    [
      { id: 1, at: replayAt(0), eventType: "show", ref: "wiki//knowledge/b", source: "user" },
      { id: 2, at: replayAt(1), eventType: "show", ref: "wiki//knowledge/b", source: "user" },
      { id: 3, at: replayAt(2), eventType: "show", ref: "wiki//knowledge/a", source: "user" },
      { id: 4, at: replayAt(3), eventType: "show", ref: "wiki//gone", source: "user" },
    ],
    index,
  );
  const meaning = undrawn(steps, graph, "meaning");
  assert.deepEqual(meaning, { events: 3, assets: 2, noPosition: 2 });
  assert.match(
    undrawnText(meaning, "meaning"),
    /3 events in this period touched 2 assets that are not drawn \(2 on assets with no position by meaning; 1 on assets that are not in the library map\)/,
  );
  assert.equal(undrawn(steps, graph, "bundle").events, 1);
  assert.equal(undrawnText(undrawn(steps.slice(2, 3), graph, "meaning"), "meaning"), "");
});

test("replay (5): the used list ranks assets by events so far, ignoring hits, and each is a library node", () => {
  const index = new Map([
    ["wiki//knowledge/a", 0],
    ["wiki//knowledge/b", 1],
  ]);
  const ev = (id, minute, ref, eventType = "show") => ({ id, at: replayAt(minute), eventType, ref, source: "user" });
  const steps = replaySteps(
    [
      ev(1, 0, "wiki//knowledge/b"),
      ev(2, 1, "wiki//knowledge/a"),
      ev(3, 2, "wiki//knowledge/a"),
      ev(4, 3, "wiki//knowledge/b", "search"),
      ev(5, 4, "wiki//knowledge/b", "search"),
      ev(6, 5, "wiki//gone"),
    ],
    index,
  );
  const list = usedList(steps, Date.parse(replayAt(9)));
  assert.deepEqual(list, [
    { node: 0, ref: "wiki//knowledge/a", count: 2 },
    { node: 1, ref: "wiki//knowledge/b", count: 1 },
  ]);
  assert.deepEqual(usedList(steps, Date.parse(replayAt(0))), [{ node: 1, ref: "wiki//knowledge/b", count: 1 }]);
  assert.equal(usedList(steps, Date.parse(replayAt(9)), 1).length, 1);
});

test("replay (5, 53): pulses are CSS-px sizes large enough to see, one token per kind, and a hit is a pulse not a size", () => {
  assert.deepEqual(PULSE_PX, { read: 14, hit: 12, feedback: 18 });
  for (const size of Object.values(PULSE_PX)) assert.ok(size >= 12 && size <= 32, `${size}px`);
  const step = (kind, signal) => ({ t: 0, kind, node: 0, actor: "x", eventType: kind, ...(signal ? { signal } : {}) });
  assert.deepEqual(pulseOf(step("show")), { kind: "read", size: 14 });
  assert.deepEqual(pulseOf(step("hit")), { kind: "hit", size: 12 });
  assert.deepEqual(pulseOf(step("feedback", "negative")), { kind: "negative", size: 18 });
  assert.deepEqual(pulseOf(step("feedback", "positive")), { kind: "positive", size: 18 });
  assert.equal(pulseOf(step("other")), null);
  assert.equal(pulseOf(step("search")), null);
  assert.equal(new Set(Object.values(PULSE_TOKENS)).size, 4);
});

test("replay clock (7): the whole period plays in a minute whatever its length, at stated multiples", () => {
  const day = 86_400_000;
  const played = (period, speed, seconds) => advance(0, seconds * 1000, 0, period, speed);
  // Normal: a day and a week both take 60 s (the old rate took 24 minutes for either).
  assert.equal(played(day, 1, 60), day);
  assert.equal(played(7 * day, 1, 60), 7 * day);
  assert.equal(played(7 * day, 1, 30), (7 * day) / 2);
  assert.equal(played(day, 4, 15), day);
  assert.equal(played(day, 16, 3.75), day);
  // It stops at the end.
  assert.equal(played(day, 1, 600), day);
  assert.equal(playText(1), "Plays the whole period in about 1 minute");
  assert.equal(playText(4), "Plays the whole period in about 15 seconds");
  assert.equal(playText(16), "Plays the whole period in about 4 seconds");
  assert.deepEqual(
    SPEEDS.map((s) => s.value),
    [1, 4, 16],
  );
});

test("replay time on screen (30, 52, 9): axis labels at start, middle and end; dates in long periods; the truncation note", () => {
  const zone = { locale: "en-GB", timeZone: "UTC" };
  const start = Date.UTC(2026, 10, 4, 12, 0);
  const end = Date.UTC(2026, 10, 11, 12, 0);
  assert.deepEqual(axisLabels(start, end, zone), ["4 Nov, 12:00", "8 Nov, 00:00", "11 Nov, 12:00"]);
  // A 7-day ticker names the date (the window's first and last days share a weekday); a 24-hour one only the time.
  assert.equal(stampText(end - 3_600_000, end - start, zone), "11 Nov, 11:00");
  assert.equal(stampText(end - 3_600_000, 86_400_000, zone), "11:00");
  // 9: the replay keeps the latest 20,000, so it starts later than the period.
  assert.equal(truncationNote(false, start, zone), "");
  assert.equal(
    truncationNote(true, Date.UTC(2026, 10, 9, 8, 30), zone),
    "This period held more than 20,000 events; the replay keeps the latest 20,000, so the replay starts at 9 Nov, 08:30, later than the period.",
  );
  assert.equal(EVENT_LIMIT, 20_000);
});

test("replay (28): the emitter ring follows the drawn points' extent, at any library size", () => {
  const ring = (scale, state) => emitterRing([-scale, 0, 0, scale, 5, 0, 0, 0, scale, 999 * scale, 0, 0], state);
  const small = ring(10, [1, 1, 1, 3]);
  const large = ring(1000, [1, 1, 1, 3]);
  // The hidden point (state 3) is not part of the extent.
  assert.ok(Math.abs(small.radius - (Math.hypot(20, 10) / 2) * RING_MARGIN) < 1e-9);
  assert.ok(Math.abs(large.radius / small.radius - 100) < 1e-6);
  // Just outside the cloud: beyond its farthest drawn point from the centre, and not by a world-unit constant.
  assert.ok(small.radius > 10 && small.radius < 30);
  assert.deepEqual(small.centre, [0, 5, 5]);
  const at = emitterAt(small, 0, 4);
  assert.ok(Math.abs(at[0] - (small.centre[0] + small.radius)) < 1e-9);
  assert.deepEqual(emitterRing([], []).radius, 0);
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
  assert.equal(summary.text, "10 assets · 4 not placed");
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
  assert.deepEqual(linkSummary(graph, "bundle", state, []), {
    pairs: 4,
    declared: 5,
    notPlaced: 0,
    hidden: 1,
    unresolved: 3,
  });
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
  assert.deepEqual(linkSummary(graph, "bundle", state, []), {
    pairs: 5,
    declared: 6,
    notPlaced: 0,
    hidden: 0,
    unresolved: 3,
  });
  assert.deepEqual(linkSummary(graph, "bundle", state, [1]), {
    pairs: 4,
    declared: 5,
    notPlaced: 0,
    hidden: 1,
    unresolved: 3,
  });
  // By meaning, links that need an unplaced asset are counted as such, so every declared link is accounted for.
  const meaning = linkSummary(graph, "meaning", drawState(graph, base(graph), -1, []), []);
  assert.deepEqual(meaning, { pairs: 3, declared: 4, notPlaced: 2, hidden: 0, unresolved: 3 });
  assert.equal(meaning.declared + meaning.notPlaced + meaning.hidden, graph.from.length);
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

test("Use colouring: never shown is its own mark, used assets fall in geometric steps up to the largest count", () => {
  const shows = [0, 0, 1, 1, 2, 3, 5, 8, 13, 40];
  const { steps, stepOf } = useSteps(shows);
  assert.deepEqual(
    steps.map((s) => [s.from, s.to, s.count, s.label]),
    [
      [1, 2, 3, "1–2"],
      [3, 5, 2, "3–5"],
      [6, 15, 2, "6–15"],
      [16, null, 1, "16+"],
    ],
  );
  assert.deepEqual([0, 1, 2, 3, 4, 5, 7, 8, 40].map(stepOf), [0, 1, 1, 2, 2, 2, 3, 3, 4]);
  // A heavy tail keeps its steps apart (quantiles would collapse them): max 200 starts at 1, 4, 14 and 53.
  const tail = useSteps([0, 1, 1, 1, 1, 2, 2, 3, 200]);
  assert.deepEqual(
    tail.steps.map((s) => s.from),
    [1, 4, 14, 53],
  );
  assert.deepEqual([3, 4, 13, 14, 52, 53].map(tail.stepOf), [1, 2, 2, 3, 3, 4]);
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
