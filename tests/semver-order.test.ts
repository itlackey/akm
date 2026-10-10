import { describe, expect, test } from "bun:test";
import semver from "semver";
import { semverOrder } from "../src/runtime";

// Daily builds (#1089): 0.10.YYMMDDNN, prerelease = stage only. `akm upgrade`
// compares installed and published versions with semverOrder, which is
// Bun.semver on Bun and node-semver on Node; both must agree on every pair.
function expectOrder(lower: string, higher: string) {
  expect(semverOrder(lower, higher)).toBe(-1);
  expect(semverOrder(higher, lower)).toBe(1);
  expect(semverOrder(lower, lower)).toBe(0);
  expect(semver.compare(lower, higher)).toBe(-1);
}

describe("semverOrder with daily builds", () => {
  test("builds sort by day and then build number", () => {
    expectOrder("0.10.26101001", "0.10.26101002");
    expectOrder("0.10.26101099", "0.10.26101101");
  });

  test("builds sort across a month boundary", () => {
    expectOrder("0.10.26093001", "0.10.26100101");
    expectOrder("0.10.26013199", "0.10.26020101");
    // January sorts above the previous December only through the year digits
    expectOrder("0.10.26123199", "0.10.27010101");
  });

  test("builds sort across a year boundary", () => {
    expectOrder("0.10.26123101", "0.10.27010101");
    expectOrder("0.10.26123199", "0.10.27010101-alpha");
  });

  test("a build is above its own prerelease stages, which sort alpha < beta < rc", () => {
    expectOrder("0.10.26101001-alpha", "0.10.26101001-beta");
    expectOrder("0.10.26101001-beta", "0.10.26101001-rc");
    expectOrder("0.10.26101001-rc", "0.10.26101001");
  });

  test("a prerelease of a later build is above the earlier stable build", () => {
    expectOrder("0.10.26101001", "0.10.26101002-alpha");
    expectOrder("0.10.26101002-alpha", "0.10.26101002");
  });

  test("next vs latest: a next prerelease is the target only when it is newer than latest", () => {
    const latest = "0.10.26101001";
    // same-day later alpha: newer than latest, so `--next` moves to it
    expect(semverOrder(latest, "0.10.26101002-alpha")).toBe(-1);
    // the alpha of the build that is already latest is older than it: never a target
    expect(semverOrder(latest, "0.10.26101001-rc")).toBe(1);
    // 0.9 releases stay below every daily build
    expect(semverOrder("0.9.31", "0.10.26101001-alpha")).toBe(-1);
  });
});
