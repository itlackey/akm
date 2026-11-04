// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { releaseRefusal } from "../scripts/release-guard.mjs";

test("an AppImage is built only from a clean tree at the release tag", () => {
  assert.equal(releaseRefusal({ version: "0.10.261105", dirty: false, tags: ["v0.10.261105", ""] }), null);
  assert.match(releaseRefusal({ version: "0.10.261105", dirty: true, tags: ["v0.10.261105"] }), /uncommitted/);
  assert.match(releaseRefusal({ version: "0.10.261105", dirty: false, tags: [""] }), /not tagged v0\.10\.261105/);
  assert.match(releaseRefusal({ version: "0.10.261105", dirty: false, tags: ["v0.10.261104"] }), /not tagged/);
});
