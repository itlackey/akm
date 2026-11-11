// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyEngineSkew,
  compareVersions,
  holdReason,
  hostUpgradeOutrunsDesktop,
  sameReleaseLine,
  skewAdvice,
  stableSwitch,
} from "../src/lib/engine-skew.ts";

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

test("a patch difference inside one release line is told apart from a different line (#1609-11)", () => {
  assert.equal(sameReleaseLine("0.10.261117", "0.10.261110"), true);
  assert.equal(sameReleaseLine("0.10.261117", "0.10.261117-beta.1"), true);
  assert.equal(sameReleaseLine("0.11.261201", "0.10.261117"), false);
  assert.equal(sameReleaseLine("0.10.261117", undefined), false);
  assert.equal(sameReleaseLine("0.10.261117", "not a version"), false);
});

test("a compatible patch difference is informational, an incompatible line names its remedy (#1609-11)", () => {
  const patch = skewAdvice("0.10.261117", "0.10.261110");
  assert.equal(patch.kind, "info");
  assert.match(patch.text, /same release line, so nothing needs doing/);
  // Another release line: the index may be incompatible, so the text names the remedy for when akm refuses.
  const older = skewAdvice("0.11.261201", "0.10.261117");
  assert.equal(older.kind, "act");
  assert.match(older.text, /If the library index changed, the CLI will ask you to upgrade/);
  const newer = skewAdvice("0.10.261117", "0.11.261201");
  assert.equal(newer.kind, "act");
  assert.match(newer.text, /update AKM Desktop/);
  assert.equal(skewAdvice("0.10.261117", "0.10.261117").kind, "none");
  assert.equal(skewAdvice("0.10.261117", undefined).kind, "none");
});

test("a release newer than the engine is held with its reason, and one the Desktop channel will not offer says so (#1609-11)", () => {
  assert.equal(holdReason("0.10.261117", "0.10.261110", "stable"), undefined);
  assert.equal(holdReason("0.10.261117", undefined, "stable"), undefined);
  const offered = holdReason("0.10.261117", "0.10.261201", "stable");
  assert.match(offered, /newer than the AKM built into this app\. The CLI and its plugins are updated together/);
  assert.match(offered, /no plugins-only update/);
  assert.ok(!offered.includes("stable releases only"));
  const hidden = holdReason("0.10.261117", "0.11.261201-beta.1", "stable");
  assert.match(hidden, /follows stable releases only, so it will not be offered to Desktop/);
  assert.ok(!holdReason("0.10.261117", "0.11.261201-beta.1", "prerelease").includes("stable releases only"));
});

test("switching a prerelease CLI to stable is offered only when stable is not older than it (#1609)", () => {
  assert.equal(stableSwitch("0.11.261201-beta.1", "0.10.261117"), "downgrade");
  assert.equal(stableSwitch("0.10.261110-beta.1", "0.10.261117"), "offer", "an older prerelease is not a downgrade");
  assert.equal(stableSwitch("0.10.261117-rc.1", "0.10.261117"), "offer");
  assert.equal(stableSwitch("0.11.261201-beta.1", undefined), "unknown");
  assert.equal(
    stableSwitch("0.11.261201-beta.1", "0.11.261202-beta.1"),
    "unknown",
    "a prerelease is not a stable target",
  );
});
