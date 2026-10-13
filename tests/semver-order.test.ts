import { describe, expect, test } from "bun:test";
import semver from "semver";
import { semverOrder } from "../src/runtime";

// Monthly release numbers (#1089): 0.10.YYMMNN, prerelease = stage only. `akm upgrade`
// compares installed and published versions with semverOrder, which is
// Bun.semver on Bun and node-semver on Node; both must agree on every pair.
function expectOrder(lower: string, higher: string) {
  expect(semverOrder(lower, higher)).toBe(-1);
  expect(semverOrder(higher, lower)).toBe(1);
  expect(semverOrder(lower, lower)).toBe(0);
  expect(semver.compare(lower, higher)).toBe(-1);
}

describe("semverOrder with monthly release numbers", () => {
  test("releases sort by NN within a month", () => {
    expectOrder("0.10.261001", "0.10.261002");
    expectOrder("0.10.261009", "0.10.261010");
    expectOrder("0.10.261099", "0.10.261101");
  });

  test("releases sort across a month boundary", () => {
    expectOrder("0.10.260999", "0.10.261001");
    expectOrder("0.10.260101", "0.10.260201");
    expectOrder("0.10.261001", "0.10.261101");
  });

  test("releases sort across a year boundary", () => {
    expectOrder("0.10.261201", "0.10.270101");
    expectOrder("0.10.261299", "0.10.270101-alpha");
  });

  test("a release is above its own prerelease stages, which sort alpha < beta < rc", () => {
    expectOrder("0.10.261001-alpha", "0.10.261001-beta");
    expectOrder("0.10.261001-beta", "0.10.261001-rc");
    expectOrder("0.10.261001-rc", "0.10.261001");
  });

  test("a -beta is below its own stable number and below the next NN", () => {
    expectOrder("0.10.261001-beta", "0.10.261001");
    expectOrder("0.10.261001-beta", "0.10.261002");
    expectOrder("0.10.261001-beta", "0.10.261002-alpha");
  });

  test("a prerelease of a later release is above the earlier stable release", () => {
    expectOrder("0.10.261001", "0.10.261002-alpha");
    expectOrder("0.10.261002-alpha", "0.10.261002");
  });

  test("next vs latest: a next prerelease is the target only when it is newer than latest", () => {
    const latest = "0.10.261002";
    expect(semverOrder(latest, "0.10.261003-beta")).toBe(-1);
    // a prerelease numbered below latest is older than it: never a target
    expect(semverOrder(latest, "0.10.261001-rc")).toBe(1);
    expect(semverOrder(latest, "0.10.261002-rc")).toBe(1);
    // 0.9 releases stay below every 0.10 release
    expect(semverOrder("0.9.31", "0.10.261001-alpha")).toBe(-1);
  });

  // Deliberate, accepted break (owner decision, #1089): the 0.10 daily alphas were numbered 0.10.YYMMDDNN (8-digit
  // patch). Semver compares the patch numerically, so every 6-digit 0.10.YYMMNN is below every one of them and
  // `akm upgrade` never offers the new scheme to someone on a daily alpha: they install it explicitly once
  // (`npm install -g akm-cli@<version>`). Do not "fix" this by changing the scheme or the comparison; this test
  // exists so nobody changes it by accident.
  test("accepted break: a 0.10.YYMMNN release sorts below the legacy 8-digit daily alphas", () => {
    expectOrder("0.10.261001", "0.10.26101202-alpha");
    expectOrder("0.10.261001-beta", "0.10.26101001-alpha");
    expectOrder("0.10.271201", "0.10.26101001-alpha");
  });
});
