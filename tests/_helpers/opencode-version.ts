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
 * Run `run` with an `opencode` first on PATH that prints a `major` version for `--version` (or, for `"unreadable"`, fails),
 * through the real version probe. The probe's memory of earlier lookups is cleared before and after, so neither another
 * PATH's answer nor this one outlives the call. `run` is handed the directory the fake binaries are in. `names` are the
 * binaries put there (default `opencode`); `exclusive` makes that directory the whole PATH, so a program the machine
 * itself has (an `opencode2`, say) cannot answer.
 */
export async function withOpencodeOnPath<T>(
  major: 1 | 2 | "unreadable",
  run: (dir: string) => Promise<T>,
  options: { names?: readonly string[]; exclusive?: boolean } = {},
): Promise<T> {
  const bin = makeSandboxDir("akm-fake-opencode");
  try {
    const script =
      major === "unreadable"
        ? `#!${process.execPath}\nprocess.exit(1);\n`
        : `#!${process.execPath}\nconsole.log(${JSON.stringify(OUTPUT[major])});\n`;
    for (const name of options.names ?? ["opencode"])
      fs.writeFileSync(path.join(bin.dir, name), script, { mode: 0o755 });
    const searched = options.exclusive ? bin.dir : `${bin.dir}${path.delimiter}${process.env.PATH ?? ""}`;
    return await withEnv({ PATH: searched }, () => {
      _setOpencodeVersionProbeForTests(undefined);
      return run(bin.dir);
    });
  } finally {
    _setOpencodeVersionProbeForTests(undefined);
    bin.cleanup();
  }
}
