// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Session and login-link lifetimes (docs: AKM Web). The lifetimes are constants in the code; the functions take the
// time as an argument, so no test waits. The values below are the contract: eight idle hours, sixty seconds, 256 and 64.

import assert from "node:assert/strict";
import test from "node:test";
import { startLink, startSession, useLink, useSession } from "../src/lib/server/web-access.ts";

const HOUR = 60 * 60 * 1000;
const T0 = 1_000_000_000_000;

test("a session lives eight hours without use, and use renews it", () => {
  const key = startSession(T0);
  assert.equal(useSession(key, T0 + 7 * HOUR), true);
  assert.equal(useSession(key, T0 + 14 * HOUR), true, "renewed by the use seven hours in");
  assert.equal(useSession(key, T0 + 22 * HOUR + 1), false, "more than eight idle hours");
  assert.equal(useSession(key, T0 + 22 * HOUR + 1), false, "and it is gone");
  assert.equal(useSession(undefined, T0), false);
  assert.equal(useSession("unknown", T0), false);
});

test("the 257th session evicts the least recently used one", () => {
  const first = startSession(T0);
  const rest = Array.from({ length: 255 }, (_, i) => startSession(T0 + 1 + i));
  assert.equal(useSession(first, T0 + 500), true, "the first is used again, so it is the newest");
  const last = startSession(T0 + 600);
  assert.equal(useSession(rest[0], T0 + 601), false, "the oldest unused one went");
  assert.equal(useSession(rest[1], T0 + 601), true);
  assert.equal(useSession(first, T0 + 601), true);
  assert.equal(useSession(last, T0 + 601), true);
});

test("a login link works once, for sixty seconds", () => {
  const code = startLink(T0);
  assert.equal(useLink(code, T0 + 59_000), true);
  assert.equal(useLink(code, T0 + 59_000), false, "once");
  const late = startLink(T0);
  assert.equal(useLink(late, T0 + 60_001), false, "after sixty seconds");
  assert.equal(useLink(late, T0), false, "and a late attempt uses it up");
  assert.equal(useLink(null, T0), false);
});

test("the 65th link evicts the oldest", () => {
  const codes = Array.from({ length: 65 }, (_, i) => startLink(T0 + i));
  assert.equal(useLink(codes[0], T0 + 100), false);
  assert.equal(useLink(codes[1], T0 + 100), true);
  assert.equal(useLink(codes[64], T0 + 100), true);
});
