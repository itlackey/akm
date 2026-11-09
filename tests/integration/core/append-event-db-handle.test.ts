// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `appendEvent`'s best-effort contract, for the caller that brings its own
 * connection (`ctx.db` — the `akmImprove` shape).
 *
 * Two properties are pinned here, both invisible to the callers that let
 * `appendEvent` open state.db for them:
 *   • `dbPath` is IGNORED when `db` is provided — resolution never runs, so an
 *     environment that cannot name a data dir is not an error for a caller
 *     already holding an open handle.
 *   • the event still lands on that handle.
 */

import { describe, expect, test } from "bun:test";

import { appendEvent } from "../../../src/core/events";
import { openStateDatabase } from "../../../src/core/state-db";
import { withEnvSync, withIsolatedAkmStorage } from "../../_helpers/sandbox";

describe("appendEvent with a caller-supplied connection", () => {
  test("writes without resolving the data dir", () => {
    const storage = withIsolatedAkmStorage();
    try {
      const db = openStateDatabase();
      try {
        // The data-dir env var unset: any resolution attempt throws the
        // bun-test isolation guard, which `appendEvent` deliberately rethrows
        // even from inside its catch. Reaching the handle is the only way
        // through.
        withEnvSync({ XDG_DATA_HOME: undefined }, () => {
          appendEvent({ eventType: "add", ref: "memories/alpha" }, { db });
        });

        const rows = db.prepare("SELECT event_type, ref FROM events").all() as Array<{
          event_type: string;
          ref: string | null;
        }>;
        expect(rows).toEqual([{ event_type: "add", ref: "memories/alpha" }]);
      } finally {
        db.close();
      }
    } finally {
      storage.cleanup();
    }
  });
});
