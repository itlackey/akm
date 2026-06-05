#!/usr/bin/env bun
// Build-time asset step:
//   1. Mirror src/assets/ → dist/assets/ after tsc.
//      All runtime assets (profiles, task templates, backend templates,
//      prompts, hints, wiki templates) live under src/assets/ with
//      predictable subfolders. Output is always dist/assets/<subfolder>/<file>.
//      To add a new embedded asset: put it in src/assets/, update the
//      importing .ts file's path, done — no glob changes needed.
//   2. Bundle scripts/migrate-storage.ts + scripts/migrations/*.ts into
//      dist/scripts/ so globally-installed users (npm / prebuilt binary)
//      can run them without `../src/...` import paths breaking (#469).
import { mkdir } from "node:fs/promises";
import { chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";

const assetGlob = new Bun.Glob("src/assets/**/*");
for await (const src of assetGlob.scan(".")) {
  const dest = src.replace(/^src\/assets\//, "dist/assets/");
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
