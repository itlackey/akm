import { describe, expect, test } from "bun:test";
import semver from "semver";
import { deriveVersion, resolveVersion, STAGES, validateVersion } from "../scripts/release-version";

const at = (iso: string) => new Date(iso);

describe("validateVersion", () => {
  test.each([
    "0.10.261001",
    "0.10.261099",
    "0.10.261201",
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
    ["0.10.261001-alpha.1", "no .N on a stage"],
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

  test("every release takes a new number, whatever its stage", () => {
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
  test("a release is published as itself or with a stage appended", () => {
    expect(resolveVersion("0.10.261001", "")).toBe("0.10.261001");
    expect(resolveVersion("0.10.261001", "none")).toBe("0.10.261001");
    for (const stage of STAGES) expect(resolveVersion("0.10.261001", stage)).toBe(`0.10.261001-${stage}`);
  });

  test("the stage names the release; the next release has the next number and sorts above it", () => {
    for (const stage of STAGES) {
      expect(semver.lt(resolveVersion("0.10.261001", stage), resolveVersion("0.10.261001", ""))).toBe(true);
      expect(semver.lt(resolveVersion("0.10.261001", stage), resolveVersion("0.10.261002", stage))).toBe(true);
    }
  });

  test("the 0.9 line still releases with a plain version", () => {
    expect(resolveVersion("0.9.32", "none")).toBe("0.9.32");
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
