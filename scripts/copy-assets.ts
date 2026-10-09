#!/usr/bin/env bun
import { chmodSync } from "node:fs";
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
//   3. Bundle runtime-specific migration tools into dist/scripts/ so
//      globally-installed npm users can run them without
//      `../src/...` import paths breaking (#469). Bun and Node must never run
//      each other's target because their runtime dependencies differ.
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

// `Bun.Glob.scan()` yields paths using the PLATFORM separator, so on Windows
// every entry comes back backslash-separated (`src\assets\...`). The
// forward-slash rewrites below would then silently not match, leaving
// `dest === src` — `Bun.write` would copy each asset onto itself and
// `dist/assets/` would never be created at all. That is invisible on
// Linux/macOS and breaks every `with { type: "text" }` import on Windows at
// runtime (ERR_MODULE_NOT_FOUND on the first embedded asset). Normalize once,
// here, so the rewrites are separator-independent.
const toPosix = (filePath: string): string => filePath.replaceAll("\\", "/");

const assetGlob = new Bun.Glob("src/assets/**/*");
for await (const entry of assetGlob.scan(".")) {
  const src = toPosix(entry);
  const dest = src.replace(/^src\/assets\//, "dist/assets/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
}

// Module-local YAML templates may be imported `with { type: "text" }` and
// live NEXT TO the module that uses them rather than under src/assets/.
// tsc only emits .ts sources, so mirror them into dist/ at the same relative
// path the compiled importer expects.
const yamlTemplateGlob = new Bun.Glob("src/**/*.{yaml,yml}");
for await (const entry of yamlTemplateGlob.scan(".")) {
  const src = toPosix(entry); // see the separator note above — Windows yields backslashes
  if (src.startsWith("src/assets/")) continue; // already mirrored above
  const dest = src.replace(/^src\//, "dist/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
}

// 5. Copy the published launchers plus the core CLI's Node-runtime entry
//    wrapper and text-import loader hook into dist/. Both launchers prefer Bun
//    and fall back to Node.
const runtimeFiles = [
  "scripts/node-runtime/akm",
  "scripts/node-runtime/akm-migrate",
  "scripts/node-runtime/cli-node.mjs",
  "scripts/node-runtime/text-import-hook.mjs",
  "scripts/node-runtime/api-node.mjs",
  "scripts/node-runtime/api.d.ts",
];
for (const src of runtimeFiles) {
  const dest = src.replace(/^scripts\/node-runtime\//, "dist/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
  chmodSync(dest, 0o755);
}

const migrationBuilds = [
  { entry: "scripts/akm-migrate.ts", outfile: "dist/scripts/akm-migrate.js", target: "bun" as const },
  { entry: "scripts/akm-migrate.ts", outfile: "dist/scripts/akm-migrate-node.js", target: "node" as const },
];

for (const { entry, outfile, target } of migrationBuilds) {
  await mkdir(dirname(outfile), { recursive: true });
  const result = await Bun.build({
    entrypoints: [entry],
    target,
    outdir: dirname(outfile),
    naming: basename(outfile),
    minify: false,
    // Bun.build preserves the source file's shebang; no banner needed.
  });
  if (!result.success) {
    console.error(`copy-assets: failed to bundle ${entry} for ${target}:`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  // Bundled scripts are invoked via bin entries; make them executable.
  chmodSync(outfile, 0o755);
}
