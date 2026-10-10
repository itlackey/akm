import { describe, expect, test } from "bun:test";
import semver from "semver";
import { deriveVersion, resolveVersion, STAGES, validateVersion } from "../scripts/release-version";

const at = (iso: string) => new Date(iso);

describe("validateVersion", () => {
  test.each([
    "0.10.26101001",
    "0.10.26101099",
    "0.10.26101001-alpha",
    "0.10.26101001-beta",
    "0.10.26101001-rc",
    "0.10.24022901", // 2024 is a leap year
    "0.11.27010101",
    // the 0.9 line and older keep plain semver
    "0.9.31",
    "0.9.32-rc.1",
    "1.2.3",
  ])("accepts %s", (v) => {
    expect(validateVersion(v)).toBeUndefined();
    expect(semver.valid(v)).toBe(v);
  });

  test.each([
    ["0.10.0", "the daily scheme has no plain patch"],
    ["0.10.261010", "missing NN"],
    ["0.10.2610100", "one-digit NN"],
    ["0.10.261010011", "three-digit NN"],
    ["0.10.26101000", "NN 00"],
    ["0.10.26101001-alpha.1", "no .N on a stage"],
    ["0.10.26101001-gamma", "unknown stage"],
    ["0.10.26101001-RC", "stage is lower case"],
    ["0.10.26133101", "month 13"],
    ["0.10.26023001", "30 February"],
    ["0.10.25022901", "29 February in a non-leap year"],
    ["0.10.26100001", "day 00"],
    ["0.10.010901", "MMDDNN draft"],
    ["0.10.26101001.1", "fourth numeric part"],
    ["0.10.26101001+build", "build metadata"],
    ["0.9.01", "leading zero"],
    ["", "empty"],
  ])("rejects %s (%s)", (v) => {
    expect(validateVersion(v)).toBeString();
  });
});

describe("deriveVersion", () => {
  test("first build of the UTC day is 01", () => {
    expect(deriveVersion("0.10", at("2026-10-10T00:00:00Z"), [])).toBe("0.10.26101001");
  });

  test("counts only builds published on that UTC day, of that line", () => {
    const published = ["0.10.26100901", "0.10.26101001", "0.10.26101002", "0.9.26101003", "0.11.26101005", "0.9.31"];
    expect(deriveVersion("0.10", at("2026-10-10T23:59:59Z"), published)).toBe("0.10.26101003");
  });

  test("the UTC day decides, not the local day", () => {
    expect(deriveVersion("0.10", at("2026-12-31T23:30:00Z"), [])).toBe("0.10.26123101");
    expect(deriveVersion("0.10", at("2027-01-01T00:00:00Z"), ["0.10.26123101"])).toBe("0.10.27010101");
  });

  test("a build promoted through its stages counts once", () => {
    const published = ["0.10.26101001-alpha", "0.10.26101001-beta", "0.10.26101001-rc", "0.10.26101001"];
    expect(deriveVersion("0.10", at("2026-10-10T05:00:00Z"), published)).toBe("0.10.26101002");
  });

  test("never reuses a number below one that is published", () => {
    expect(deriveVersion("0.10", at("2026-10-10T05:00:00Z"), ["0.10.26101003"])).toBe("0.10.26101004");
  });

  test("fails when the day has no build numbers left", () => {
    expect(() => deriveVersion("0.10", at("2026-10-10T05:00:00Z"), ["0.10.26101099"])).toThrow(/no build numbers/);
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
        expect(Number.isSafeInteger(Number(v.split(".")[2]))).toBe(true);
        published.push(v);
        previous = v;
      }
    }
  });
});

describe("resolveVersion", () => {
  test("a daily build is published as itself or with a stage appended", () => {
    expect(resolveVersion("0.10.26101001", "")).toBe("0.10.26101001");
    expect(resolveVersion("0.10.26101001", "none")).toBe("0.10.26101001");
    for (const stage of STAGES) expect(resolveVersion("0.10.26101001", stage)).toBe(`0.10.26101001-${stage}`);
  });

  test("a build is promoted alpha < beta < rc < the build", () => {
    const ladder = [
      ...STAGES.map((stage) => resolveVersion("0.10.26101001", stage)),
      resolveVersion("0.10.26101001", ""),
    ];
    for (let i = 1; i < ladder.length; i++) expect(semver.lt(ladder[i - 1] as string, ladder[i] as string)).toBe(true);
  });

  test("the 0.9 line still releases with a plain version", () => {
    expect(resolveVersion("0.9.32", "none")).toBe("0.9.32");
    expect(resolveVersion("0.9.32-rc.1", "")).toBe("0.9.32-rc.1");
  });

  test("rejects what the format forbids", () => {
    expect(() => resolveVersion("0.10.26101001", "gamma")).toThrow(/stage/);
    expect(() => resolveVersion("0.10.26101001-alpha", "beta")).toThrow(/already has a stage/);
    expect(() => resolveVersion("0.9.32", "rc")).toThrow(/daily builds/);
    expect(() => resolveVersion("0.10.5", "")).toThrow();
    expect(() => resolveVersion("", "")).toThrow();
  });
});
