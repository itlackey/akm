// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { usableRetrievalQueries } from "../../../src/commands/improve/retrieval-queries";

describe("usableRetrievalQueries", () => {
  test("drops harness envelopes, the stash README line and pastes, keeps five distinct queries", () => {
    const queries = usableRetrievalQueries([
      "  rotate   the vpn key ",
      "rotate the vpn key",
      "<task-notification>done</task-notification>",
      "This is an **AKM stash** — a structured knowledge repository that stores reusable",
      "x".repeat(2001),
      "q1",
      "q2",
      "q3",
      "q4",
      "q5",
    ]);
    expect(queries).toEqual(["rotate the vpn key", "q1", "q2", "q3", "q4"]);
  });
});
