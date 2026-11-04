// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityReturn,
  commitOutcome,
  conceptLocation,
  proposalHref,
  rejectionError,
  rejectionReason,
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
  assert.match(commitOutcome(null), /No Git commit/);
  assert.match(commitOutcome({ sha: "1234567890", subject: "test" }), /Push status was not reported/);
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
