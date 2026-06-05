#!/usr/bin/env bun
// Build-time asset step:
//   1. Copy non-TS asset files from src/ to dist/ after tsc. Includes:
//      - *.md, *.xml  — documentation and Windows task XML templates
//      - *.json       — embedded profile files (src/commands/profiles/)
//      - *.yml/*.yaml — embedded task templates (src/tasks/templates/)
//      Prefer small embedded files over large in-source string constants;
//      keep the file-system import pattern consistent across the project.
//   2. Bundle scripts/migrate-storage.ts + scripts/migrations/*.ts into
//      dist/scripts/ so globally-installed users (npm / prebuilt binary)
//      can run them without `../src/...` import paths breaking (#469).
import { mkdir } from "node:fs/promises";
import { chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";

const assetGlob = new Bun.Glob("src/**/*.{md,xml,json,yml,yaml}");
for await (const src of assetGlob.scan(".")) {
  const dest = src.replace(/^src\//, "dist/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
}

const migrationEntrypoints = [
  "scripts/migrate-storage.ts",
  "scripts/migrations/import-fs-improve-runs-to-db.ts",
  "scripts/migrations/v16-to-v17.ts",
];

for (const entry of migrationEntrypoints) {
  try {
    statSync(entry);
  } catch {
    continue;
  }
  const outfile = entry.replace(/\.ts$/, ".js").replace(/^scripts\//, "dist/scripts/");
  await mkdir(dirname(outfile), { recursive: true });
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    outdir: dirname(outfile),
    naming: outfile.split("/").pop()!,
    minify: false,
    // Bun.build preserves the source file's shebang; no banner needed.
  });
  if (!result.success) {
    console.error(`copy-assets: failed to bundle ${entry}:`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  // Bundled scripts are invoked via bin entries; make them executable.
  chmodSync(outfile, 0o755);
}
