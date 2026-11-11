// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph, colourSlot, edgePairs, familyOf, linksOf } from "../src/lib/graph-model.ts";
import { actorOf, replayBins, replaySteps, totalsAt } from "../src/lib/replay-model.ts";
import { traceRows } from "../src/lib/workflow-trace-model.ts";

const payload = {
  available: true,
  note: "",
  types: ["knowledge", "memory", "widget"],
  bundles: ["wiki", "notes"],
  kinds: ["xref", "superseded_by"],
  nodes: {
    ref: ["wiki//knowledge/a", "wiki//knowledge/b", "notes//memories/old", "notes//widgets/w"],
    title: ["A", "B", "Old", "W"],
    type: [0, 0, 1, 2],
    bundle: [0, 0, 1, 1],
    shows: [10, 0, 2, 0],
    searches: [30, 1, 0, 0],
    lastUsedAt: [null, null, null, null],
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
  assert.equal(graph.name(0), "knowledge/a");
  assert.equal(graph.index.get("notes//memories/old"), 2);
  assert.deepEqual(
    linksOf(graph, 0).map((group) => [group.kind, group.outgoing, group.nodes]),
    [
      ["xref", true, [1]],
      ["superseded_by", false, [2]],
    ],
  );
  // The asset that declares superseded_by is the outdated one.
  assert.deepEqual([...graph.outdated], [0, 0, 1, 0]);
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
