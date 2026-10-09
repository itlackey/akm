import { _setOpencodeVersionProbeForTests } from "../../src/integrations/harnesses/opencode/version";
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
