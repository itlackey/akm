/**
 * Which OpenCode major an installed binary is: parsing `--version`, choosing
 * the binary, the environment the probe gets, and the once-per-binary warning.
 * Fake binaries on PATH stand in for the program; the probe itself is real.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { resolveTarget } from "../src/integrations/agent/resolution";
import {
  _setOpencodeVersionProbeForTests,
  detectOpencodeMajor,
  parseOpencodeMajor,
  resolveOpencodeBin,
} from "../src/integrations/harnesses/opencode/version";
import { withOpencodeOnPath } from "./_helpers/opencode-version";
import { makeSandboxDir, withEnv } from "./_helpers/sandbox";
import { overrideSeam } from "./_helpers/seams";

let warnings: string[];
let probed: string[];

/** Answer `--version` per binary path, and record which were asked. */
function fakeBinaries(outputs: Record<string, string | undefined>): void {
  overrideSeam(_setOpencodeVersionProbeForTests, (bin) => {
    probed.push(bin);
    return outputs[bin];
  });
}

beforeEach(() => {
  warnings = [];
  probed = [];
  _resetWarnOnceForTests();
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

describe("parseOpencodeMajor", () => {
  test("reads both real output shapes", () => {
    expect(parseOpencodeMajor("1.18.34")).toBe(1);
    expect(parseOpencodeMajor("opencode v2.0.26")).toBe(2);
    expect(parseOpencodeMajor("opencode v3.1.0")).toBe(3);
  });

  test("is undefined when there is no version", () => {
    expect(parseOpencodeMajor("")).toBeUndefined();
    expect(parseOpencodeMajor("no version here")).toBeUndefined();
  });

  test("is undefined for another program's --version", () => {
    expect(parseOpencodeMajor("true (GNU coreutils) 9.7\nPackaged by Ubuntu (9.7-3ubuntu2.1)")).toBeUndefined();
  });
});

describe("resolveOpencodeBin", () => {
  test("prefers opencode2 when it is on PATH", async () => {
    await withOpencodeOnPath(2, async () => expect(resolveOpencodeBin()).toBe("opencode2"), {
      names: ["opencode", "opencode2"],
      exclusive: true,
    });
  });

  test("falls back to opencode when opencode2 is absent", async () => {
    await withOpencodeOnPath(2, async () => expect(resolveOpencodeBin()).toBe("opencode"), { exclusive: true });
  });
});

describe("detectOpencodeMajor", () => {
  test("OpenCode 1 warns once, naming version and path", async () => {
    await withOpencodeOnPath(1, async (dir) => {
      expect(detectOpencodeMajor("opencode")).toMatchObject({ reportedMajor: 1, version: "1.18.34" });
      detectOpencodeMajor("opencode");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("1.18.34");
      expect(warnings[0]).toContain(path.join(dir, "opencode"));
      expect(warnings[0]).toContain("OpenCode 1 support continues");
      expect(warnings[0]).toContain("upgrading to OpenCode 2 is recommended");
    });
  });

  test("OpenCode 2 is reported without a warning", async () => {
    await withOpencodeOnPath(2, async () => {
      expect(detectOpencodeMajor("opencode")).toMatchObject({ reportedMajor: 2, runnable: true });
      expect(warnings).toEqual([]);
    });
  });

  test("runs --version once per binary", async () => {
    await withOpencodeOnPath(
      2,
      async (dir) => {
        const [one, two] = [path.join(dir, "opencode"), path.join(dir, "opencode2")];
        fakeBinaries({ [one]: "opencode v2.0.26", [two]: "opencode v2.0.26" });
        for (let i = 0; i < 3; i++) detectOpencodeMajor("opencode");
        detectOpencodeMajor("opencode2");
        expect(probed).toEqual([one, two]);
      },
      { names: ["opencode", "opencode2"], exclusive: true },
    );
  });

  test("output that is not an OpenCode version reports no major", async () => {
    await withOpencodeOnPath(2, async (dir) => {
      fakeBinaries({ [path.join(dir, "opencode")]: "something odd" });
      expect(detectOpencodeMajor("opencode")).toEqual({ version: "something odd", runnable: true });
    });
  });

  test("a --version that fails is not runnable", async () => {
    await withOpencodeOnPath(
      "unreadable",
      async () => expect(detectOpencodeMajor("opencode")).toEqual({ version: "", runnable: false }),
      { exclusive: true },
    );
  });

  test("the probe gets the allowlisted environment, not akm's whole one", async () => {
    const bin = makeSandboxDir("akm-version-env");
    try {
      // Reports OpenCode 2 only when it has a HOME and none of akm's other variables.
      fs.writeFileSync(
        path.join(bin.dir, "opencode"),
        `#!${process.execPath}\nconsole.log(process.env.HOME && !process.env.AKM_PROBE_SECRET ? "opencode v2.0.26" : "leaked");\n`,
        { mode: 0o755 },
      );
      await withEnv({ PATH: bin.dir, AKM_PROBE_SECRET: "synthetic" }, async () => {
        _setOpencodeVersionProbeForTests(undefined);
        expect(detectOpencodeMajor("opencode")).toMatchObject({ reportedMajor: 2, version: "opencode v2.0.26" });
      });
    } finally {
      _setOpencodeVersionProbeForTests(undefined);
      bin.cleanup();
    }
  });
});

describe("the opencode harness's binary", () => {
  test("a harness with no bin runs opencode; one with a bin keeps it", () => {
    const config = {
      harnesses: {
        plain: { platform: "opencode" },
        pinned: { platform: "opencode", bin: "/opt/oc1/opencode" },
      },
    } as never;
    const plain = resolveTarget({ config, layers: [{ harness: "plain" }] });
    const pinned = resolveTarget({ config, layers: [{ harness: "pinned" }] });
    if (plain.kind !== "harness" || pinned.kind !== "harness") throw new Error("expected harness runners");
    expect(plain.bin).toBe("opencode");
    expect(pinned.bin).toBe("/opt/oc1/opencode");
  });
});
