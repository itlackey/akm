// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { snapshotFeed, waitUntilIdle } from "../src/lib/software-model.ts";

/** A `load` whose answers the test settles in any order. */
function controlled() {
  const waiting = [];
  return { load: () => new Promise((resolve, reject) => waiting.push({ resolve, reject })), waiting };
}

test("an older response that arrives late never replaces a newer one (#1609-8)", async () => {
  const { load, waiting } = controlled();
  const refresh = snapshotFeed(load);
  const first = refresh();
  const second = refresh();
  waiting[1].resolve("newer");
  assert.deepEqual(await second, { ok: true, data: "newer", stale: false, recovered: false });
  waiting[0].resolve("older");
  assert.equal((await first).stale, true);
});

test("a failure then a success reports the recovery so the offline banner clears (#1609-8)", async () => {
  const { load, waiting } = controlled();
  const refresh = snapshotFeed(load);
  const failed = refresh();
  waiting[0].reject(new Error("offline"));
  assert.deepEqual(await failed, { ok: false, error: "offline", stale: false });
  const back = refresh();
  waiting[1].resolve("idle");
  assert.equal((await back).recovered, true);
  const again = refresh();
  waiting[2].resolve("idle");
  assert.equal((await again).recovered, false);
  // A failure of a request that a newer answer already overtook is not a lost connection.
  const slow = refresh();
  const quick = refresh();
  waiting[4].resolve("idle");
  await quick;
  waiting[3].reject(new Error("late failure"));
  assert.equal((await slow).stale, true);
});

test("waiting on an operation stops after repeated failed polls and says the connection was lost (#1609-8)", async () => {
  let calls = 0;
  const lost = await waitUntilIdle(
    async () => {
      calls++;
      return false;
    },
    () => true,
    async () => {},
    3,
  );
  assert.equal(lost, false);
  assert.equal(calls, 3);
  // Recovery in between resets the count, and an idle snapshot ends the wait.
  let busy = true;
  const replies = [false, false, true, false, true];
  const done = await waitUntilIdle(
    async () => {
      const ok = replies.shift();
      if (replies.length === 0) busy = false;
      return ok;
    },
    () => busy,
    async () => {},
    3,
  );
  assert.equal(done, true);
});
