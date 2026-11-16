// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, test } from "bun:test";
import { withAgentIdentity } from "../src/indexer/usage/usage-events";

test("a usage event records the agent harness and session akm runs under, and nothing without one", () => {
  expect(withAgentIdentity('{"resultCount":2}', { CLAUDE_CODE_SESSION_ID: "s-1" })).toBe(
    '{"agent":{"harness":"claude","session":"s-1"},"resultCount":2}',
  );
  expect(withAgentIdentity(undefined, { CODEX_SANDBOX: "seatbelt" })).toBe('{"agent":{"harness":"codex"}}');
  // A caller's own agent key wins; metadata that is not a JSON object is stored as given.
  expect(withAgentIdentity('{"agent":"x"}', { CLAUDE_CODE_SESSION_ID: "s-1" })).toBe('{"agent":"x"}');
  expect(withAgentIdentity("[1]", { CLAUDE_CODE_SESSION_ID: "s-1" })).toBe("[1]");
  expect(withAgentIdentity('{"a":1}', {})).toBe('{"a":1}');
  expect(withAgentIdentity(undefined, {})).toBeNull();
});
