import fs from "node:fs";
import path from "node:path";
import { _setOpencodeVersionProbeForTests } from "../../src/integrations/harnesses/opencode/version";
import { makeSandboxDir, withEnv } from "./sandbox";
import { overrideSeam } from "./seams";

const OUTPUT = { 1: "1.18.34", 2: "opencode v2.0.26" } as const;

/**
 * Make every OpenCode binary report `major` from `--version` for the current
 * test (restored automatically). `1` selects the OpenCode 1 adapters, `2` the
 * OpenCode 2 adapters. Pass a function to answer per binary.
 */
export function fakeOpencodeMajor(major: 1 | 2 | ((bin: string) => string | undefined)): void {
  overrideSeam(_setOpencodeVersionProbeForTests, typeof major === "function" ? major : () => OUTPUT[major]);
}

/**
 * Run `run` with an `opencode` first on PATH that prints a `major` version for `--version`, through the real
 * version probe. The probe's memory of earlier lookups is cleared before and after, so neither another PATH's
 * answer nor this one outlives the call.
 */
export async function withOpencodeOnPath<T>(major: 1 | 2, run: () => Promise<T>): Promise<T> {
  const bin = makeSandboxDir("akm-fake-opencode");
  try {
    const script = `#!${process.execPath}\nconsole.log(${JSON.stringify(OUTPUT[major])});\n`;
    fs.writeFileSync(path.join(bin.dir, "opencode"), script, { mode: 0o755 });
    return await withEnv({ PATH: `${bin.dir}${path.delimiter}${process.env.PATH ?? ""}` }, () => {
      _setOpencodeVersionProbeForTests(undefined);
      return run();
    });
  } finally {
    _setOpencodeVersionProbeForTests(undefined);
    bin.cleanup();
  }
}
