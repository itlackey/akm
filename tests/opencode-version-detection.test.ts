/**
 * Which OpenCode major a binary is: parsing `--version`, choosing the binary
 * (`opencode2` preferred unless the engine names one), choosing the adapter, and
 * the once-per-binary warnings. A fake probe stands in for the binary; the real
 * 1.18.34 / 2.0.26 binaries are in tests/integration/opencode-sdk-real-binary.test.ts.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { resolveEngine } from "../src/integrations/agent/engine-resolution";
import { opencodeBuilder } from "../src/integrations/harnesses/opencode/agent-builder";
import {
  _setOpencodeVersionProbeForTests,
  detectOpencodeMajor,
  parseOpencodeMajor,
  resolveOpencodeBin,
} from "../src/integrations/harnesses/opencode/version";
import { overrideSeam } from "./_helpers/seams";

let warnings: string[];
let probed: string[];

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

const onPath =
  (...names: string[]) =>
  (command: string) =>
    names.includes(command) ? `/usr/bin/${command}` : null;

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
});

describe("resolveOpencodeBin", () => {
  test("prefers opencode2 when it is on PATH and the engine names no bin", () => {
    expect(resolveOpencodeBin(undefined, onPath("opencode", "opencode2"))).toBe("opencode2");
  });

  test("falls back to opencode when opencode2 is absent", () => {
    expect(resolveOpencodeBin(undefined, onPath("opencode"))).toBe("opencode");
  });

  test("an explicit bin wins, even over opencode2", () => {
    expect(resolveOpencodeBin("/opt/oc1/opencode", onPath("opencode2"))).toBe("/opt/oc1/opencode");
  });
});

describe("detectOpencodeMajor", () => {
  test("OpenCode 1 selects the V1 adapters and warns once, naming version and path", () => {
    fakeBinaries({ "/usr/bin/opencode": "1.18.34" });
    const which = onPath("opencode");
    expect(detectOpencodeMajor("opencode", { which })).toMatchObject({
      major: 1,
      reportedMajor: 1,
      version: "1.18.34",
    });
    detectOpencodeMajor("opencode", { which });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1.18.34");
    expect(warnings[0]).toContain("/usr/bin/opencode");
    expect(warnings[0]).toContain("OpenCode 1 support continues");
    expect(warnings[0]).toContain("upgrading to OpenCode 2 is recommended");
  });

  test("OpenCode 2 selects the V2 adapters without a warning", () => {
    fakeBinaries({ "/usr/bin/opencode": "opencode v2.0.26" });
    expect(detectOpencodeMajor("opencode", { which: onPath("opencode") })).toMatchObject({ major: 2, runnable: true });
    expect(warnings).toEqual([]);
  });

  test("runs --version once per binary", () => {
    fakeBinaries({ "/usr/bin/opencode": "opencode v2.0.26", "/usr/bin/opencode2": "opencode v2.0.26" });
    const which = onPath("opencode", "opencode2");
    for (let i = 0; i < 3; i++) detectOpencodeMajor("opencode", { which });
    detectOpencodeMajor("opencode2", { which });
    expect(probed).toEqual(["/usr/bin/opencode", "/usr/bin/opencode2"]);
  });

  test("unparseable output gets the V2 adapters and one warning with the raw output", () => {
    fakeBinaries({ "/usr/bin/opencode": "something odd" });
    const which = onPath("opencode");
    expect(detectOpencodeMajor("opencode", { which })).toMatchObject({ major: 2, version: "something odd" });
    detectOpencodeMajor("opencode", { which });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"something odd"');
  });

  test("an unknown major gets the V2 adapters and one warning", () => {
    fakeBinaries({ "/usr/bin/opencode": "opencode v3.0.1" });
    expect(detectOpencodeMajor("opencode", { which: onPath("opencode") })).toMatchObject({
      major: 2,
      reportedMajor: 3,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("opencode v3.0.1");
  });

  test("a --version that fails gets the V2 adapters and one warning, and is not runnable", () => {
    fakeBinaries({});
    const info = detectOpencodeMajor("opencode", { which: onPath("opencode") });
    expect(info).toMatchObject({ major: 2, runnable: false, version: "" });
    expect(warnings).toHaveLength(1);
  });
});

describe("adapter selection", () => {
  const profile = (bin: string) => ({
    name: "opencode",
    bin,
    args: ["run"],
    stdio: "captured" as const,
    envPassthrough: [],
    parseOutput: "text" as const,
  });

  test("the CLI argv builder follows each binary's own major", () => {
    fakeBinaries({ "oc-old": "1.18.34", "oc-new": "opencode v2.0.26" });
    expect(opencodeBuilder.build(profile("oc-old"), { prompt: "p" }).argv).not.toContain("--standalone");
    expect(opencodeBuilder.build(profile("oc-new"), { prompt: "p" }).argv).toContain("--standalone");
  });

  test("an engine with no bin runs the builtin opencode; one with a bin keeps it", () => {
    const config = {
      engines: {
        plain: { kind: "agent", platform: "opencode" },
        pinned: { kind: "agent", platform: "opencode", bin: "/opt/oc1/opencode" },
      },
    } as never;
    const plain = resolveEngine("plain", config);
    const pinned = resolveEngine("pinned", config);
    if (plain.kind !== "agent" || pinned.kind !== "agent") throw new Error("expected agent runners");
    expect(["opencode", "opencode2"]).toContain(plain.profile.bin);
    expect(pinned.profile.bin).toBe("/opt/oc1/opencode");
  });
});
