// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { FAMILIES, familyOf } from "../src/lib/graph-model.ts";
import {
  advance,
  axisLabels,
  describe,
  EVENT_LIMIT,
  KINDS,
  kindBins,
  playText,
  replaySteps,
  SCRUB_STEP,
  SPEEDS,
  scrubTime,
  stampText,
  totalsAt,
  truncationNote,
  usedList,
} from "../src/lib/replay-model.ts";
import { traceRows } from "../src/lib/workflow-trace-model.ts";

test("asset types fold into families; a type akm does not list is Other, the last family", () => {
  assert.equal(familyOf("knowledge"), 0);
  assert.equal(familyOf("fact"), 1);
  assert.equal(familyOf("skill"), 2);
  assert.equal(familyOf("widget"), FAMILIES.length - 1);
});

const replayAt = (minute) => new Date(Date.UTC(2026, 10, 11, 10, minute)).toISOString();
const replayEvents = [
  { id: 3, at: replayAt(2), eventType: "show", ref: "wiki//knowledge/a", source: "user", agent: { harness: "claude" } },
  { id: 1, at: replayAt(0), eventType: "search", query: "deploy", source: "user", resultCount: 0 },
  { id: 2, at: replayAt(1), eventType: "search", ref: "wiki//knowledge/a", source: "improve" },
  { id: 4, at: replayAt(3), eventType: "feedback", ref: "wiki//gone", signal: "negative", source: "task" },
];
const replayIndex = new Map([["wiki//knowledge/a", 0]]);

test("the replay: hits apart from searches, and totals at any moment", () => {
  const steps = replaySteps(replayEvents, replayIndex);
  assert.deepEqual(
    steps.map((step) => [step.kind, step.node]),
    [
      ["search", -1],
      ["hit", 0],
      ["show", 0],
      ["feedback", -1],
    ],
  );
  const middle = totalsAt(steps, Date.parse(replayAt(2)));
  assert.equal(middle.searches, 1);
  assert.equal(middle.foundNothing, 1);
  assert.equal(middle.shows, 1);
  assert.equal(middle.used.size, 1);
  assert.deepEqual(middle.misses, [["deploy", 1]]);
  assert.equal(totalsAt(steps, Date.parse(replayAt(9))).negative, 1);
  // A search that found nothing and recorded no query is still listed.
  const unnamed = replaySteps(
    [{ id: 1, at: replayAt(0), eventType: "search", source: "user", resultCount: 0 }],
    new Map(),
  );
  assert.deepEqual(totalsAt(unnamed, Date.parse(replayAt(9))).misses, [["(no query recorded)", 1]]);
});

test("replay: a curate is a search, and a curate row with a ref is a hit that is not counted", () => {
  const events = [
    { id: 1, at: replayAt(0), eventType: "curate", query: "release notes", source: "user" },
    { id: 2, at: replayAt(0), eventType: "curate", ref: "wiki//knowledge/a", source: "user" },
  ];
  const steps = replaySteps(events, replayIndex);
  assert.deepEqual(
    steps.map((step) => [step.kind, step.node]),
    [
      ["search", -1],
      ["hit", 0],
    ],
  );
  assert.equal(describe(steps[0]), "curated “release notes”");
  const total = totalsAt(steps, Date.parse(replayAt(9)));
  assert.equal(total.searches, 1);
  assert.equal(total.others, 0);
  assert.equal(total.events, 1);
  assert.equal(total.used.size, 0);
  assert.equal(
    describe(replaySteps([{ ...events[0], resultCount: 0 }], replayIndex)[0]),
    "curated “release notes”, found nothing",
  );
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

test("timeline bins stack events by kind: a search with no results is a miss, a curate is a search, hits are not counted, max is the tallest bin", () => {
  assert.deepEqual(
    KINDS.map((k) => k.id),
    ["read", "search", "miss", "feedback", "other"],
  );
  const ev = (id, minute, eventType, extra = {}) => ({ id, at: replayAt(minute), eventType, source: "user", ...extra });
  const steps = replaySteps(
    [
      ev(1, 0, "show", { ref: "wiki//knowledge/a" }),
      ev(2, 0, "search", { query: "deploy", resultCount: 0 }),
      ev(3, 0, "search", { query: "backup", resultCount: 4 }),
      // A hit is part of its search: not an event of its own.
      ev(4, 0, "search", { query: "backup", ref: "wiki//knowledge/a" }),
      ev(5, 1, "feedback", { ref: "wiki//knowledge/a", signal: "positive" }),
      ev(6, 3, "curate", { query: "release" }),
      ev(7, 3, "show", { ref: "wiki//knowledge/a" }),
    ],
    replayIndex,
  );
  const bins = kindBins(steps, Date.parse(replayAt(0)), Date.parse(replayAt(4)), 4);
  assert.equal(bins.counts.length, 4);
  assert.deepEqual(bins.counts[0], { read: 1, search: 1, miss: 1, feedback: 0, other: 0 });
  assert.deepEqual(bins.counts[1], { read: 0, search: 0, miss: 0, feedback: 1, other: 0 });
  assert.deepEqual(bins.counts[2], { read: 0, search: 0, miss: 0, feedback: 0, other: 0 });
  assert.deepEqual(bins.counts[3], { read: 1, search: 1, miss: 0, feedback: 0, other: 0 });
  // The tallest stacked bin, not the tallest kind in it.
  assert.equal(bins.max, 3);
  assert.equal(bins.width, 60_000);
  // An empty window still has a scale.
  assert.equal(kindBins([], 0, 4, 4).max, 1);
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
