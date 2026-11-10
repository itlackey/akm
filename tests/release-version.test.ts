import { describe, expect, test } from "bun:test";
import semver from "semver";
import { nextVersion, resolveVersion, STAGES, validateVersion } from "../scripts/release-version";

describe("validateVersion", () => {
  test.each([
    "0.11.0",
    "0.11.1",
    "0.12.0-beta.1",
    "0.11.0-alpha.1",
    "0.11.0-rc.10",
    // published 0.10 monthly versions
    "0.10.261116",
    "0.10.261201",
  ])("accepts %s", (v) => {
    expect(validateVersion(v)).toBeUndefined();
    expect(semver.valid(v)).toBe(v);
  });

  test.each([
    "0.11.0-beta",
    "0.11.0-beta.0",
    "0.11.0-beta.01",
    "0.11.0-beta.1.1",
    "0.11.0-gamma.1",
    "0.11.0-RC.1",
    "0.11.0+build",
    "0.11",
    "0.11.01",
    "1.0.0",
    "",
  ])("rejects %s", (v) => {
    expect(validateVersion(v)).toBeString();
  });
});

describe("nextVersion", () => {
  test("the next patch of the line's latest stable", () => {
    expect(nextVersion("0.11", ["0.11.0", "0.11.1", "0.11.0-beta.1"])).toBe("0.11.2");
    expect(nextVersion("0.11", ["0.11.0", "0.10.261116", "0.12.5"])).toBe("0.11.1");
  });

  test("a new minor, or a line with only prereleases, starts at .0", () => {
    expect(nextVersion("0.12", ["0.11.3"])).toBe("0.12.0");
    expect(nextVersion("0.11", ["0.11.0-beta.1", "0.11.0-rc.1"])).toBe("0.11.0");
    expect(nextVersion("0.11", [])).toBe("0.11.0");
  });

  test("the 0.10 monthly line still counts up", () => {
    expect(nextVersion("0.10", ["0.10.261115-beta", "0.10.261116"])).toBe("0.10.261117");
  });
});

describe("resolveVersion", () => {
  test("a stable release is published as itself", () => {
    expect(resolveVersion("0.11.0", "")).toBe("0.11.0");
    expect(resolveVersion("0.11.1", "")).toBe("0.11.1");
  });

  test("a prerelease takes its base from package.json's version, with the next counter of its stage", () => {
    for (const stage of STAGES) expect(resolveVersion("0.11.0-beta.0", stage, [])).toBe(`0.11.0-${stage}.1`);
    const published = ["0.11.0-beta.1", "0.11.0-beta.2", "0.11.0-alpha.5", "0.11.1-beta.7", "0.10.261115-beta"];
    expect(resolveVersion("0.11.0-beta.0", "beta", published)).toBe("0.11.0-beta.3");
    expect(resolveVersion("0.11.0", "alpha", published)).toBe("0.11.0-alpha.6");
    expect(resolveVersion("0.11.0", "rc", published)).toBe("0.11.0-rc.1");
    expect(resolveVersion("0.12.0-beta.0", "beta", published)).toBe("0.12.0-beta.1");
  });

  test("prereleases sort alpha < beta < rc < the stable release, and 0.10 monthly versions sort below 0.11", () => {
    const [alpha, beta, rc] = STAGES.map((stage) => resolveVersion("0.11.0", stage, []));
    const order = ["0.10.261115-beta", "0.10.261116", alpha, beta, rc, "0.11.0", "0.11.1-beta.1", "0.11.1"];
    for (let i = 1; i < order.length; i++) expect(semver.lt(order[i - 1] as string, order[i] as string)).toBe(true);
  });

  test("rejects what the format forbids", () => {
    expect(() => resolveVersion("0.11.0", "gamma")).toThrow(/stage/);
    expect(() => resolveVersion("0.11.0-beta.1", "")).toThrow(/prerelease/);
    expect(() => resolveVersion("1.0.0", "beta")).toThrow();
    expect(() => resolveVersion("", "")).toThrow();
  });
});
