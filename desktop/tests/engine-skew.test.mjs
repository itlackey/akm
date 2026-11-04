// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import { classifyEngineSkew, compareVersions, hostUpgradeOutrunsDesktop } from "../src/lib/engine-skew.ts";

test("versions order by number, and a stage release is older than its stable release", () => {
  const order = (a, b) => Math.sign(compareVersions(a, b));
  assert.equal(order("0.10.261105", "0.10.261105"), 0);
  assert.equal(order("0.10.261104", "0.10.261105"), -1);
  assert.equal(order("0.11.260101", "0.10.261105"), 1);
  assert.equal(order("0.10.261105-beta", "0.10.261105"), -1);
  assert.equal(order("0.10.261105-alpha", "0.10.261105-beta"), -1);
  assert.equal(order("0.10.261105-rc", "0.10.261105-beta"), 1);
  assert.equal(order("1.0.0-beta.2", "1.0.0-beta.11"), -1);
  assert.equal(compareVersions("not a version", "0.10.261105"), null);
  assert.equal(compareVersions(undefined, "0.10.261105"), null);
});

test("the host CLI is the same as, older than, newer than or unknown against Desktop's engine", () => {
  assert.equal(classifyEngineSkew("0.10.261105", "0.10.261105"), "same");
  assert.equal(classifyEngineSkew("0.10.261105", "0.10.261104"), "host-older");
  assert.equal(classifyEngineSkew("0.10.261105", "0.10.261106"), "host-newer");
  assert.equal(classifyEngineSkew("0.10.261105", "0.10.261105-beta"), "host-older");
  assert.equal(classifyEngineSkew("0.10.261105", undefined), "unknown");
  assert.equal(classifyEngineSkew(undefined, "0.10.261105"), "unknown");
  assert.equal(classifyEngineSkew("0.10.261105", "dev"), "unknown");
});

test("a host upgrade is held back only when the latest release is newer than Desktop's engine", () => {
  assert.equal(hostUpgradeOutrunsDesktop("0.10.261105", "0.10.261106"), true);
  assert.equal(hostUpgradeOutrunsDesktop("0.10.261105", "0.10.261105"), false);
  assert.equal(hostUpgradeOutrunsDesktop("0.10.261105", "0.10.261104"), false);
  assert.equal(hostUpgradeOutrunsDesktop("0.10.261105", undefined), false);
});
