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

// Soft check: the vendored ECharts payload backs `akm health --format html`
// in self-contained (inline) mode. Missing it is non-fatal — the report can
// still be generated with AKM_ECHARTS=cdn — but warn loudly so a broken
// checkout doesn't silently ship a build without offline reports (#582).
try {
  statSync("src/assets/templates/html/vendor/echarts.min.js");
} catch {
  console.warn(
    "copy-assets: WARNING — src/assets/templates/html/vendor/echarts.min.js is missing; " +
      "`akm health --format html` will only work with AKM_ECHARTS=cdn.",
  );
}

// 3. Copy the Node-runtime entry wrapper + text-import loader hook into dist/.
//    These let `node dist/cli-node.mjs` run akm end-to-end on Node (the bun:*
//    text-import that Bun loads natively needs a loader hook on Node). They are
//    plain Node ESM (.mjs), copied verbatim — never imported under Bun.
const nodeRuntimeFiles = [
  "scripts/node-runtime/cli-node.mjs",
  "scripts/node-runtime/migrate-storage-node.mjs",
  "scripts/node-runtime/text-import-hook.mjs",
];
for (const src of nodeRuntimeFiles) {
  const dest = src.replace(/^scripts\/node-runtime\//, "dist/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
}
chmodSync("dist/cli-node.mjs", 0o755);

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
    target: "node",
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
