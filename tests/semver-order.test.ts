import { describe, expect, test } from "bun:test";
import semver from "semver";
import { semverOrder } from "../src/runtime";

// `akm upgrade` compares installed and published versions with semverOrder: Bun.semver on Bun, node-semver on Node.
// Both must agree on every pair.
function expectOrder(lower: string, higher: string) {
  expect(semverOrder(lower, higher)).toBe(-1);
  expect(semverOrder(higher, lower)).toBe(1);
  expect(semverOrder(lower, lower)).toBe(0);
  expect(semver.compare(lower, higher)).toBe(-1);
}

describe("semverOrder", () => {
  test("prereleases sort alpha < beta < rc < the release, by counter within a stage", () => {
    expectOrder("0.11.0-alpha.2", "0.11.0-beta.1");
    expectOrder("0.11.0-beta.2", "0.11.0-beta.10");
    expectOrder("0.11.0-beta.1", "0.11.0-rc.1");
    expectOrder("0.11.0-rc.1", "0.11.0");
  });

  test("patches and minors sort numerically, and a prerelease of a later version is above an earlier stable", () => {
    expectOrder("0.11.0", "0.11.1");
    expectOrder("0.11.9", "0.11.10");
    expectOrder("0.11.1", "0.12.0-beta.1");
    expectOrder("0.12.0-beta.1", "0.12.0");
  });

  test("0.10 monthly versions, including a bare stage, sort below every 0.11 version", () => {
    expectOrder("0.10.261115-beta", "0.10.261116");
    expectOrder("0.10.261116", "0.11.0-alpha.1");
    expectOrder("0.9.31", "0.10.261001-alpha");
  });

  test("a next prerelease is the upgrade target only when it is newer than latest", () => {
    expect(semverOrder("0.11.1", "0.11.2-beta.1")).toBe(-1);
    expect(semverOrder("0.11.1", "0.11.1-rc.1")).toBe(1);
  });
});
