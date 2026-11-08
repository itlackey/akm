// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityReturn,
  batchOutcome,
  clip,
  commitOutcome,
  conceptLocation,
  nextAfterDecision,
  plural,
  proposalHref,
  queueState,
  rejectionError,
  rejectionReason,
  relativeAge,
  settleDecision,
  withoutDecided,
} from "../src/lib/review-model.ts";
import { buildDiff } from "../src/lib/ui/diff.js";
import { diffSection } from "../src/lib/ui/diff-view.js";

test("review helpers preserve route filters and bound composed rejection reasons", () => {
  const params = new URLSearchParams("source=reflect&age=older&id=ignored");
  const href = proposalHref("id/with space", params);
  assert.equal(href, "/review/id%2Fwith%20space?source=reflect&age=older");
  assert.equal(rejectionReason("Stale", "  verify target  "), "Stale: verify target");
  assert.equal(rejectionError("Stale", ""), "");
  assert.match(rejectionError("Other", ""), /required/);
  assert.match(rejectionError("Wrong", "a".repeat(2000)), /2000/);
  assert.equal(commitOutcome(null), "");
  assert.equal(commitOutcome({ sha: "1234567890", subject: "akm accept: x" }), "Saved to Git history as 12345678.");
  assert.equal(
    activityReturn("/activity/improve?since=365d&anchor=impact-drill"),
    "/activity/improve?since=365d&anchor=impact-drill",
  );
  assert.equal(activityReturn("https://example.com"), null);
  assert.equal(activityReturn("/activity/improve-not-a-route"), null);
});

test("upstream diff retains alignment, changed-word marks, escaping and safety fallbacks", () => {
  const before = Array.from({ length: 30 }, (_, i) => `Evidence line ${i}: preserve source`).join("\n");
  const after = before.replace("line 15: preserve", "line 15: verify");
  const model = buildDiff(before, after);
  assert.equal(model.added, 1);
  assert.equal(model.removed, 1);
  assert.ok(model.parts.some((p) => p.type === "gap"));
  assert.ok(model.rows.some((r) => r.left?.marks?.some(([, changed]) => changed)));
  const view = diffSection({ before, after, unified: "", truncated: false });
  assert.match(view.markup.text, /data-diff-mode="side"/);
  assert.match(view.markup.text, /data-diff-mode="inline" aria-pressed="true"/);
  assert.match(view.markup.text, /class="dcol inline"/);
  assert.doesNotMatch(view.markup.text, /class="sbs"/);
  assert.match(diffSection({ before: null, after: "# New asset" }).markup.text, /class="dcol inline"/);
  assert.match(view.markup.text, /data-gap/);
  const malicious = diffSection({
    before: "same <script>bad()</script>",
    after: "same <img onerror=bad()>",
    unified: "",
  });
  assert.doesNotMatch(malicious.markup.text, /<script>|<img /);
  const redacted = diffSection({
    before: "PRIVATE-SOURCE",
    after: "PRIVATE-SOURCE",
    redacted: true,
    unified: "Sensitive source hidden.",
  });
  assert.doesNotMatch(redacted.markup.text, /PRIVATE-SOURCE/);
  const truncated = diffSection({
    before: "INCOMPLETE-SIDE",
    after: "INCOMPLETE-SIDE",
    truncated: true,
    unified: "@@ safe summary @@",
  });
  assert.doesNotMatch(truncated.markup.text, /INCOMPLETE-SIDE/);
  assert.match(truncated.markup.text, /plain diff is shown/);
});

test("queue locations distinguish same-named concepts without inventing physical paths", () => {
  assert.equal(conceptLocation("personal//knowledge/laptops/recovery"), "personal//knowledge/laptops");
  assert.equal(conceptLocation("personal//knowledge/servers/recovery"), "personal//knowledge/servers");
  assert.equal(conceptLocation("personal//recovery"), "personal//");
  assert.equal(conceptLocation("knowledge/recovery"), "knowledge");
});

test("after a decision the next proposal is the next remaining one in queue order", () => {
  const order = ["a", "b", "c", "d"];
  assert.equal(nextAfterDecision(order, ["b"], "b", ["a", "c", "d"]), "c");
  assert.equal(nextAfterDecision(order, ["b", "c"], "b", ["a", "d"]), "d", "a decided or vanished proposal is skipped");
  assert.equal(nextAfterDecision(order, ["b"], "b", ["a", "d"]), "d", "one another reviewer decided is skipped");
  assert.equal(
    nextAfterDecision(order, ["d"], "d", ["a", "b", "c"]),
    "a",
    "at the end the queue wraps to its first remaining proposal",
  );
  assert.equal(nextAfterDecision(order, ["a", "b", "c", "d"], "d", []), "", "nothing remains");
  assert.equal(
    nextAfterDecision(["a"], ["a"], "a", ["z"]),
    "z",
    "a refill beyond the shown proposals continues the queue",
  );
  assert.equal(nextAfterDecision(order, ["c"], "c", ["a", "b", "d", "e"]), "d", "the shown order wins over a refill");
  assert.equal(
    nextAfterDecision(["a", "b"], ["b"], "b", ["a", "x"]),
    "x",
    "the end of the shown window goes on into the refill",
  );
  assert.equal(
    nextAfterDecision(order, ["q"], "q", ["a", "b"]),
    "a",
    "a decided proposal that was not shown starts over",
  );
});

test("a decision removes proposals and moves the counts with them", () => {
  const queue = {
    proposals: [
      { id: "a", source: "reflect" },
      { id: "b", source: "reflect" },
      { id: "c", source: "extract" },
    ],
    totalCount: 5,
    fullCount: 9,
    bySource: { reflect: 4, extract: 5 },
  };
  const next = withoutDecided(queue, ["b", "c", "unknown"]);
  assert.deepEqual(
    next.proposals.map((p) => p.id),
    ["a"],
  );
  assert.deepEqual([next.totalCount, next.fullCount, next.bySource], [3, 7, { reflect: 3, extract: 4 }]);
  assert.equal(queue.proposals.length, 3, "the original is not changed");
  assert.equal(withoutDecided({ proposals: [], totalCount: 0, bySource: {} }, ["x"]).fullCount, undefined);
});

test("a queue is finished only when nothing matches; an empty fetch with matches left is a refill", () => {
  assert.equal(queueState({ proposals: [{ id: "a" }], totalCount: 1 }), "open");
  assert.equal(queueState({ proposals: [{ id: "a" }], totalCount: 450 }), "open");
  assert.equal(queueState({ proposals: [], totalCount: 250 }), "refill");
  assert.equal(queueState({ proposals: [], totalCount: 0 }), "finished");
});

test("a failed write and a successful write with a failed refresh are told apart", async () => {
  const failed = await settleDecision(
    () => Promise.reject(new Error("Proposal changed")),
    () => assert.fail("no refresh after a failed write"),
  );
  assert.deepEqual(failed, { status: "failed", error: "Proposal changed" });
  const refreshFailed = await settleDecision(
    async () => ({ ref: "x" }),
    () => Promise.reject(new Error("offline")),
  );
  assert.deepEqual(refreshFailed, { status: "decided", result: { ref: "x" }, refreshError: "offline" });
  assert.deepEqual(
    await settleDecision(
      async () => 1,
      async () => {},
    ),
    { status: "decided", result: 1 },
  );
});

test("a batch keeps its failures selected and inspectable, and an unreported id is a failure", () => {
  const outcome = batchOutcome(["a", "b", "c", "d"], {
    results: [
      { id: "a", ok: true },
      { id: "b", ok: false, ref: "p//k/b", error: "Not pending", code: "PROPOSAL_NOT_PENDING" },
      { id: "c", ok: true },
    ],
  });
  assert.deepEqual(outcome.done, ["a", "c"]);
  assert.deepEqual(outcome.selected, ["b", "d"]);
  assert.deepEqual(outcome.failed, [
    { id: "b", ref: "p//k/b", error: "Not pending", code: "PROPOSAL_NOT_PENDING" },
    { id: "d", error: "The result did not report this proposal." },
  ]);
  assert.deepEqual(batchOutcome(["a"], {}).selected, ["a"]);
});

test("waiting time reads in the largest whole unit", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(relativeAge(ago(20000), now), "just now");
  assert.equal(relativeAge(ago(61 * 60000), now), "1 hour");
  assert.equal(relativeAge(ago(3 * 86400000 + 5000), now), "3 days");
  assert.equal(relativeAge(undefined, now), "Not recorded");
  assert.equal(relativeAge("nonsense", now), "Not recorded");
});

test("counts read as words and long text is cut with an ellipsis", () => {
  assert.equal(plural(1, "finding"), "1 finding");
  assert.equal(plural(3, "finding"), "3 findings");
  assert.equal(plural(0, "setting still names it", "settings still name it"), "0 settings still name it");
  assert.equal(clip("short", 60), "short");
  assert.equal(clip("a".repeat(70), 60).length, 60);
  assert.ok(clip("a".repeat(70), 60).endsWith("…"));
});
