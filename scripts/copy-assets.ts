#!/usr/bin/env bun
import { chmodSync, statSync } from "node:fs";
// Build-time asset step:
//   1. Mirror src/assets/ → dist/assets/ after tsc.
//      All runtime assets (profiles, task templates, backend templates,
//      prompts, hints, wiki templates) live under src/assets/ with
//      predictable subfolders. Output is always dist/assets/<subfolder>/<file>.
//      To add a new embedded asset: put it in src/assets/, update the
//      importing .ts file's path, done — no glob changes needed.
//   2. Mirror module-local YAML templates next to compiler outputs in `dist/`.
//      The files are imported `with { type: "text" }` from nearby TypeScript
//      modules, so this keeps runtime-compatible paths intact.
//   3. Copy schema artifacts (`schemas/**`) so published packages expose
//      contract artifacts in `dist/schemas` for source-less deploys.
//   4. Bundle scripts/migrate-storage.ts + scripts/migrations/*.ts into
//      dist/scripts/ so globally-installed users (npm / prebuilt binary)
//      can run them without `../src/...` import paths breaking (#469).
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

const assetGlob = new Bun.Glob("src/assets/**/*");
for await (const src of assetGlob.scan(".")) {
  const dest = src.replace(/^src\/assets\//, "dist/assets/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
}

// Module-local YAML templates (e.g. src/workflows/authoring/
// workflow-program-template.yaml) are imported `with { type: "text" }` and
// live NEXT TO the module that uses them rather than under src/assets/.
// tsc only emits .ts sources, so mirror them into dist/ at the same relative
// path the compiled importer expects.
const yamlTemplateGlob = new Bun.Glob("src/**/*.{yaml,yml}");
for await (const src of yamlTemplateGlob.scan(".")) {
  if (src.startsWith("src/assets/")) continue; // already mirrored above
  const dest = src.replace(/^src\//, "dist/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
}

const schemaGlob = new Bun.Glob("schemas/**/*");
for await (const src of schemaGlob.scan(".")) {
  const dest = src.replace(/^schemas\//, "dist/schemas/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
}

// 5. Copy the published launchers plus the Node-runtime entry wrapper and
//    text-import loader hook into dist/. The shell launchers keep the npm/bun
//    global-install contract runtime-agnostic: prefer Bun when present, fall
//    back to Node wrappers otherwise.
const runtimeFiles = [
  "scripts/node-runtime/akm",
  "scripts/node-runtime/akm-migrate-storage",
  "scripts/node-runtime/cli-node.mjs",
  "scripts/node-runtime/migrate-storage-node.mjs",
  "scripts/node-runtime/text-import-hook.mjs",
];
for (const src of runtimeFiles) {
  const dest = src.replace(/^scripts\/node-runtime\//, "dist/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
  chmodSync(dest, 0o755);
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
    target: "node",
    outdir: dirname(outfile),
    naming: basename(outfile),
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
