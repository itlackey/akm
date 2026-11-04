// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { releaseRefusal } from "../scripts/release-guard.mjs";

test("a distributable build needs a clean tree and the released engine", () => {
  const released = { version: "0.10.261105", source: "release" };
  assert.equal(releaseRefusal({ dirty: false, core: released }), null);
  assert.match(releaseRefusal({ dirty: true, core: released }), /uncommitted/);
  assert.match(releaseRefusal({ dirty: false, core: { ...released, source: "checkout" } }), /not a release/);
  assert.match(releaseRefusal({ dirty: false, core: null }), /--tarball/);
});
