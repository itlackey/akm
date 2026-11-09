import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { type CliResult, runCliCapture } from "./cli";

/** Run `akm registry add https://example.com/batch-b.json ...extra` in-process, collecting what it warned. */
export async function runRegistryAdd(extra: string[]): Promise<{ result: CliResult; warnings: string[] }> {
  const warnings: string[] = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    const result = await runCliCapture([
      "registry",
      "add",
      "https://example.com/batch-b.json",
      ...extra,
      "--format=json",
    ]);
    return { result, warnings };
  } finally {
    _setWarnSinkForTests(undefined);
  }
}
