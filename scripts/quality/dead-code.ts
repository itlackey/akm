// quality:dead-code — unused files, exports and types in src/ (knip).
import fs from "node:fs";
import path from "node:path";
import { die, finish, pins, run, target } from "./lib";

const { dir, out } = target("dead-code", process.argv.slice(2));
// package.json "exports" plus tsconfig outDir make knip treat every src file as an entry, which hides all
// dead code. So: explicit entries (knip.json) and a tsconfig with outDir cleared. The tsconfig is written to
// the report dir because the measured tree may be an old checkout that does not have one.
const tsconfig = path.join(out, "tsconfig.knip.json");
fs.writeFileSync(
  tsconfig,
  JSON.stringify({ extends: path.join(dir, "tsconfig.json"), compilerOptions: { outDir: null } }),
);
// files/exports/types only: dependency checks need installed modules, which an extracted tree lacks.
// knip exits 1 when it finds issues; that is a result, not a failure.
const r = run(
  [
    "bunx",
    pins.knip,
    "--config",
    path.join(import.meta.dir, "knip.json"),
    "--tsConfig",
    tsconfig,
    "--include",
    "files,exports,types",
    "--reporter",
    "json",
    "--no-progress",
    "--no-config-hints",
  ],
  dir,
);
fs.writeFileSync(path.join(out, "knip.json"), r.out);
let issues: { file: string; files: unknown[]; exports: unknown[]; types: unknown[] }[];
try {
  issues = (JSON.parse(r.out) as { issues: typeof issues }).issues;
} catch {
  die(r);
}
const src = issues.filter((i) => i.file.startsWith("src/"));
const files = src.filter((i) => i.files.length > 0);
const exportsN = src.reduce((a, i) => a + i.exports.length, 0);
const typesN = src.reduce((a, i) => a + i.types.length, 0);

const summary = [
  `dead code (knip 6.47.0, src/ only): ${files.length} unused files, ${exportsN} unused exports, ${typesN} unused types`,
  ...files.map((i) => `  unused file: ${i.file}`),
  "Means: nothing reachable from the entry points (src/cli.ts, src/api.ts, src/workspace.ts, *-entry.ts, scripts, tests) imports it.",
  "Does not mean: safe to delete. Files loaded by path string or spawned by tests, and exports used only by tests, look unused or used respectively; dependency checks are not run.",
].join("\n");

finish(out, summary, { unused_files: files.length, unused_exports: exportsN, unused_types: typesN });
