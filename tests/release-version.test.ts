import { describe, expect, test } from "bun:test";
import semver from "semver";
import { deriveVersion, nextVersion, resolveVersion, STAGES, validateVersion } from "../scripts/release-version";

const at = (iso: string) => new Date(iso);

describe("validateVersion", () => {
  test.each([
    "0.10.261001",
    "0.10.261099",
    "0.10.261201",
    "0.10.261001-alpha.1",
    "0.10.261001-beta.2",
    "0.10.261001-rc.10",
    // prereleases published before the counter carry a bare stage
    "0.10.261001-alpha",
    "0.10.261001-beta",
    "0.10.261001-rc",
    "0.11.270101",
    // the 0.9 line and older keep plain semver
    "0.9.31",
    "0.9.32-rc.1",
    "1.2.3",
  ])("accepts %s", (v) => {
    expect(validateVersion(v)).toBeUndefined();
    expect(semver.valid(v)).toBe(v);
  });

  test.each([
    ["0.10.0", "the monthly scheme has no plain patch"],
    ["0.10.26101", "missing NN"],
    ["0.10.2610011", "three-digit NN"],
    ["0.10.261000", "NN 00"],
    ["0.10.261001-beta.0", "the counter starts at 1"],
    ["0.10.261001-beta.01", "no leading zero on the counter"],
    ["0.10.261001-beta.1.1", "one counter"],
    ["0.10.261001-gamma", "unknown stage"],
    ["0.10.261001-RC", "stage is lower case"],
    ["0.10.261301", "month 13"],
    ["0.10.260001", "month 00"],
    ["0.10.261001.1", "fourth numeric part"],
    ["0.10.261001+build", "build metadata"],
    ["0.10.26101001", "retired 8-digit daily build"],
    ["0.10.26101202-alpha", "retired 8-digit daily build with a stage"],
    ["0.9.01", "leading zero"],
    ["", "empty"],
  ])("rejects %s (%s)", (v) => {
    expect(validateVersion(v)).toBeString();
  });
});

describe("deriveVersion", () => {
  test("first release of the UTC month is 01", () => {
    expect(deriveVersion("0.10", at("2026-10-12T00:00:00Z"), [])).toBe("0.10.261001");
  });

  test("counts only releases published in that UTC month, of that line", () => {
    const published = ["0.10.260901", "0.10.261001", "0.10.261002", "0.9.261003", "0.11.261005", "0.9.31"];
    expect(deriveVersion("0.10", at("2026-10-31T23:59:59Z"), published)).toBe("0.10.261003");
  });

  test("the UTC month decides, not the local month", () => {
    expect(deriveVersion("0.10", at("2026-12-31T23:30:00Z"), [])).toBe("0.10.261201");
    expect(deriveVersion("0.10", at("2027-01-01T00:00:00Z"), ["0.10.261201"])).toBe("0.10.270101");
  });

  test("the next number is one above the highest published that month, at any stage", () => {
    const published = ["0.10.261001-alpha", "0.10.261002-beta", "0.10.261003-rc", "0.10.261004"];
    expect(deriveVersion("0.10", at("2026-10-12T05:00:00Z"), published)).toBe("0.10.261005");
    expect(deriveVersion("0.10", at("2026-10-12T05:00:00Z"), ["0.10.261001-beta"])).toBe("0.10.261002");
  });

  test("legacy 8-digit daily builds are ignored", () => {
    const legacy = ["0.10.26101001-alpha", "0.10.26101002-alpha", "0.10.26101202-alpha"];
    expect(deriveVersion("0.10", at("2026-10-12T05:00:00Z"), legacy)).toBe("0.10.261001");
    expect(deriveVersion("0.10", at("2026-10-12T05:00:00Z"), [...legacy, "0.10.261001-beta"])).toBe("0.10.261002");
  });

  test("never reuses a number below one that is published", () => {
    expect(deriveVersion("0.10", at("2026-10-12T05:00:00Z"), ["0.10.261003"])).toBe("0.10.261004");
  });

  test("fails when the month has no release numbers left", () => {
    expect(() => deriveVersion("0.10", at("2026-10-12T05:00:00Z"), ["0.10.261099"])).toThrow(/no release numbers/);
  });

  test("every derived version is valid semver and sorts after the previous one", () => {
    const days = ["2026-01-01", "2026-02-28", "2026-09-09", "2026-12-31", "2027-01-01", "2028-02-29", "2099-12-31"];
    let previous = "0.10.0";
    for (const day of days) {
      const published: string[] = [];
      for (let i = 0; i < 99; i++) {
        const v = deriveVersion("0.10", at(`${day}T12:00:00Z`), published);
        expect(validateVersion(v)).toBeUndefined();
        expect(semver.valid(v)).toBe(v);
        expect(semver.gt(v, previous)).toBe(true);
        published.push(v);
        previous = v;
      }
    }
  });
});

describe("resolveVersion", () => {
  test("a release is published as itself, or as the first prerelease of a stage", () => {
    expect(resolveVersion("0.10.261001", "")).toBe("0.10.261001");
    for (const stage of STAGES) expect(resolveVersion("0.10.261001", stage, [])).toBe(`0.10.261001-${stage}.1`);
  });

  test("the counter is one above the highest published for that release and stage", () => {
    const published = ["0.10.261001-beta.1", "0.10.261001-beta.2", "0.10.261001-alpha.5", "0.10.261002-beta.7"];
    expect(resolveVersion("0.10.261001", "beta", published)).toBe("0.10.261001-beta.3");
    expect(resolveVersion("0.10.261001", "alpha", published)).toBe("0.10.261001-alpha.6");
    expect(resolveVersion("0.10.261001", "rc", published)).toBe("0.10.261001-rc.1");
    // A bare stage published before the counter counts as 1.
    expect(resolveVersion("0.10.261001", "beta", ["0.10.261001-beta"])).toBe("0.10.261001-beta.2");
    // The stable release never takes a counter.
    expect(resolveVersion("0.10.261001", "", published)).toBe("0.10.261001");
  });

  test("prereleases sort by stage then counter, below their release and below the next release", () => {
    const beta1 = resolveVersion("0.10.261001", "beta", []);
    const beta2 = resolveVersion("0.10.261001", "beta", [beta1]);
    expect(semver.lt(beta1, beta2)).toBe(true);
    expect(semver.lt(resolveVersion("0.10.261001", "alpha", []), beta1)).toBe(true);
    expect(semver.lt(beta2, resolveVersion("0.10.261001", "rc", []))).toBe(true);
    for (const stage of STAGES) {
      expect(semver.lt(resolveVersion("0.10.261001", stage, []), resolveVersion("0.10.261001", ""))).toBe(true);
      expect(semver.lt(resolveVersion("0.10.261001", stage, []), resolveVersion("0.10.261002", stage, []))).toBe(true);
    }
  });

  test("the 0.9 line still releases with a plain version", () => {
    expect(resolveVersion("0.9.32", "")).toBe("0.9.32");
    expect(resolveVersion("0.9.32-rc.1", "")).toBe("0.9.32-rc.1");
  });

  test("rejects what the format forbids", () => {
    expect(() => resolveVersion("0.10.261001", "gamma")).toThrow(/stage/);
    expect(() => resolveVersion("0.10.261001-alpha", "beta")).toThrow(/already has a stage/);
    expect(() => resolveVersion("0.9.32", "rc")).toThrow(/monthly release numbers/);
    expect(() => resolveVersion("0.10.26101001", "")).toThrow(/retired/);
    expect(() => resolveVersion("0.10.5", "")).toThrow();
    expect(() => resolveVersion("", "")).toThrow();
  });
});

// Plain semver from 0.11, beside the monthly numbers of 0.10 (the tests above).
describe("semver releases (0.11+)", () => {
  test.each([
    "0.11.0",
    "0.11.1",
    "0.12.0",
    "0.11.0-alpha.1",
    "0.11.0-beta.2",
    "0.12.0-rc.10",
    "0.11.270101",
  ])("accepts %s", (v) => {
    expect(validateVersion(v)).toBeUndefined();
    expect(semver.valid(v)).toBe(v);
  });

  test.each([
    "0.11.0-beta",
    "0.11.0-beta.0",
    "0.11.0-beta.01",
    "0.11.0-gamma.1",
    "0.11.00",
    "0.11.0+build",
    "0.11",
  ])("rejects %s", (v) => {
    expect(validateVersion(v)).toBeString();
  });

  test("the next release is one patch above the line's latest stable, or its .0", () => {
    expect(nextVersion("0.11", [])).toBe("0.11.0");
    expect(nextVersion("0.11", ["0.11.0-beta.1", "0.11.0-rc.2"])).toBe("0.11.0");
    expect(nextVersion("0.11", ["0.11.0", "0.11.1", "0.11.0-beta.1"])).toBe("0.11.2");
    expect(nextVersion("0.11", ["0.11.9", "0.11.10"])).toBe("0.11.11");
    expect(nextVersion("0.12", ["0.11.3", "0.10.261133", "0.9.31"])).toBe("0.12.0");
  });

  test("a release is published as itself, or as a stage with the next counter", () => {
    expect(resolveVersion("0.11.0", "")).toBe("0.11.0");
    for (const stage of STAGES) expect(resolveVersion("0.11.0", stage, [])).toBe(`0.11.0-${stage}.1`);
    const published = ["0.11.0-beta.1", "0.11.0-beta.2", "0.11.0-alpha.5", "0.11.1-beta.7", "0.10.261133-beta.9"];
    expect(resolveVersion("0.11.0", "beta", published)).toBe("0.11.0-beta.3");
    expect(resolveVersion("0.11.0", "alpha", published)).toBe("0.11.0-alpha.6");
    expect(resolveVersion("0.11.0", "rc", published)).toBe("0.11.0-rc.1");
    expect(resolveVersion("0.11.0", "", published)).toBe("0.11.0");
  });

  test("rejects what the format forbids", () => {
    expect(() => resolveVersion("0.11.0-beta.1", "beta")).toThrow(/already has a stage/);
    expect(() => resolveVersion("0.11.0", "gamma")).toThrow(/stage/);
    expect(() => resolveVersion("0.11.0-beta", "")).toThrow();
  });

  test("0.10 monthly numbers sort below every 0.11 version", () => {
    const monthly = deriveVersion("0.10", at("2026-12-31T12:00:00Z"), []);
    expect(semver.lt(monthly, resolveVersion("0.11.0", "alpha", []))).toBe(true);
    expect(semver.lt(resolveVersion("0.10.261133", "rc", []), "0.11.0-alpha.1")).toBe(true);
  });
});
