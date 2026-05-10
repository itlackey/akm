#!/usr/bin/env bun
// Copies non-TS asset files (*.md, *.xml) from src/ to dist/ after tsc.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const glob = new Bun.Glob("src/**/*.{md,xml}");
for await (const src of glob.scan(".")) {
  const dest = src.replace(/^src\//, "dist/");
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, Bun.file(src));
}
