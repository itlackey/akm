/**
 * Which OpenCode major an installed binary is: parsing `--version`, choosing
 * the binary, the once-per-binary warning, and the OpenCode 1 CLI builder's
 * refusal of OpenCode 2. A fake probe stands in for the binary.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { resolveTarget } from "../src/integrations/agent/resolution";
import { getHarness } from "../src/integrations/harnesses";
import { opencodeBuilder } from "../src/integrations/harnesses/opencode/agent-builder";
import {
  _setOpencodeVersionProbeForTests,
  detectOpencodeMajor,
  parseOpencodeMajor,
  resolveOpencodeBin,
} from "../src/integrations/harnesses/opencode/version";
import { installFakeOpencodeHost } from "./_helpers/fake-opencode-host";
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

  test("is undefined for another program's --version", () => {
    expect(parseOpencodeMajor("true (GNU coreutils) 9.7\nPackaged by Ubuntu (9.7-3ubuntu2.1)")).toBeUndefined();
  });
});

describe("resolveOpencodeBin", () => {
  test("prefers opencode2 when it is on PATH and the harness names no bin", () => {
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
  test("OpenCode 1 warns once, naming version and path", () => {
    fakeBinaries({ "/usr/bin/opencode": "1.18.34" });
    const which = onPath("opencode");
    expect(detectOpencodeMajor("opencode", { which })).toMatchObject({ reportedMajor: 1, version: "1.18.34" });
    detectOpencodeMajor("opencode", { which });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1.18.34");
    expect(warnings[0]).toContain("/usr/bin/opencode");
    expect(warnings[0]).toContain("OpenCode 1 support continues");
    expect(warnings[0]).toContain("upgrading to OpenCode 2 is recommended");
  });

  test("OpenCode 2 is reported without a warning", () => {
    fakeBinaries({ "/usr/bin/opencode": "opencode v2.0.26" });
    expect(detectOpencodeMajor("opencode", { which: onPath("opencode") })).toMatchObject({
      reportedMajor: 2,
      runnable: true,
    });
    expect(warnings).toEqual([]);
  });

  test("runs --version once per binary", () => {
    fakeBinaries({ "/usr/bin/opencode": "opencode v2.0.26", "/usr/bin/opencode2": "opencode v2.0.26" });
    const which = onPath("opencode", "opencode2");
    for (let i = 0; i < 3; i++) detectOpencodeMajor("opencode", { which });
    detectOpencodeMajor("opencode2", { which });
    expect(probed).toEqual(["/usr/bin/opencode", "/usr/bin/opencode2"]);
  });

  test("output that is not an OpenCode version reports no major", () => {
    fakeBinaries({ "/usr/bin/opencode": "something odd" });
    const info = detectOpencodeMajor("opencode", { which: onPath("opencode") });
    expect(info).toEqual({ version: "something odd", runnable: true });
  });

  test("a --version that fails is not runnable", () => {
    fakeBinaries({});
    expect(detectOpencodeMajor("opencode", { which: onPath("opencode") })).toEqual({ version: "", runnable: false });
  });
});

describe("the opencode harness chooses its transport from the binary", () => {
  const profile = (bin: string) => ({
    name: "opencode",
    bin,
    args: ["run"],
    stdio: "captured" as const,
    envPassthrough: [],
    parseOutput: "text" as const,
  });

  test("runs an OpenCode 1 binary, or one that reports no OpenCode version, as its CLI; OpenCode 2 embedded", async () => {
    fakeBinaries({ "oc-old": "1.18.34", "not-oc": "true (GNU coreutils) 9.7", "oc-new": "opencode v2.0.26" });
    const harness = getHarness("opencode");
    expect(opencodeBuilder.build(profile("oc-old"), { prompt: "p" }).argv).toEqual(["oc-old", "run"]);
    expect(opencodeBuilder.build(profile("not-oc"), { prompt: "p" }).argv).toEqual(["not-oc", "run"]);
    expect(harness?.runInProcess?.(profile("oc-old"), "p", {})).toBeUndefined();
    expect(harness?.runInProcess?.(profile("not-oc"), "p", {})).toBeUndefined();
    const { calls } = installFakeOpencodeHost({ reply: () => "embedded" });
    expect(await harness?.runInProcess?.(profile("oc-new"), "p", {})).toMatchObject({ ok: true, stdout: "embedded" });
    expect(calls).toHaveLength(1);
  });

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
