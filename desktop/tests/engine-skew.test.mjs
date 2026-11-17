// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyEngineSkew,
  compareVersions,
  holdReason,
  sameReleaseLine,
  skewAdvice,
  updateHeld,
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

test("Update is held only when akm's plan moves the CLI itself past Desktop's engine", () => {
  const engine = "0.10.261105";
  assert.equal(updateHeld(engine, { updateAvailable: true, latestVersion: "0.10.261106" }), true);
  assert.equal(updateHeld(engine, { updateAvailable: true, latestVersion: "0.10.261105" }), false);
  assert.equal(updateHeld(engine, { updateAvailable: true, latestVersion: "0.10.261104" }), false);
  // The CLI is already on the newest release, which is past the engine: only plugins would change, so nothing is held.
  assert.equal(updateHeld(engine, { updateAvailable: false, latestVersion: "0.10.261131-beta" }), false);
  assert.equal(updateHeld(engine, { updateAvailable: true, latestVersion: undefined }), false);
  assert.equal(updateHeld(engine, undefined), false);
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

test("the hold says the rule, and says when the Desktop channel will not offer that release (#1609-11)", () => {
  const plan = (latestVersion, updateAvailable = true) => ({ latestVersion, updateAvailable });
  assert.equal(holdReason("0.10.261117", plan("0.10.261110"), "stable"), undefined);
  assert.equal(holdReason("0.10.261117", plan("0.10.261201", false), "stable"), undefined);
  assert.equal(holdReason("0.10.261117", undefined, "stable"), undefined);
  const offered = holdReason("0.10.261117", plan("0.10.261201"), "stable");
  assert.match(
    offered,
    /Update would move the CLI to 0\.10\.261201, newer than the AKM built into this app \(0\.10\.261117\)\./,
  );
  assert.match(offered, /plugins update with the CLI, so Update is held/);
  assert.ok(!offered.includes("stable releases only"));
  const hidden = holdReason("0.10.261117", plan("0.11.261201-beta.1"), "stable");
  assert.match(hidden, /follows stable releases only, so it will not be offered to Desktop/);
  assert.ok(!holdReason("0.10.261117", plan("0.11.261201-beta.1"), "prerelease").includes("stable releases only"));
});
