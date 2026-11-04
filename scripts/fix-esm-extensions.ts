#!/usr/bin/env bun
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Build-time post-processing step: rewrite extensionless RELATIVE import/export
// specifiers in the emitted `dist/` to fully-qualified `.js` paths so the
// bundle is loadable by Node's strict ESM resolver.
//
// Why this is needed: src/ is compiled with `moduleResolution: "Bundler"` +
// `module: "ESNext"`, which lets source use extensionless relative imports
// (`import x from "./foo"`). Bun's resolver tolerates those at runtime, but
// Node's ESM resolver requires explicit file extensions and does NOT do
// directory-index resolution. Without this rewrite `node dist/cli.js` throws
// ERR_MODULE_NOT_FOUND on the very first relative import.
//
// The rewrite is behaviour-preserving for Bun: appending the real `.js` (or
// `/index.js`) that the specifier already resolved to changes nothing about
// what module loads — Bun resolves the explicit path identically. It is purely
// additive for the Node path.
//
// Resolution rules (mirroring what both runtimes would have resolved to):
//   "./foo"  → "./foo.js"        when dist/.../foo.js exists
//   "./foo"  → "./foo/index.js"  when dist/.../foo/ is a dir with index.js
// Specifiers that already carry an extension (.js/.json/.node/...) and bare
// (non-relative) specifiers are left untouched.

import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DIST = "dist";

// Matches the specifier inside static `import`/`export ... from`, side-effect
// `import "..."`, and dynamic `import("...")` forms. Captures the quote char
// and the relative specifier (must start with "./" or "../").
const SPEC_RE = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.\.?\/[^"']*)\2/g;

function hasExtension(spec: string): boolean {
  // Treat a trailing `.<ext>` on the final path segment as an extension.
  const last = spec.split("/").pop() ?? "";
  return /\.[a-zA-Z0-9]+$/.test(last);
}

/** Resolve an extensionless relative spec against the importing file's dir. */
function rewriteSpec(spec: string, fromFileDir: string): string {
  if (hasExtension(spec)) return spec;
  const abs = resolve(fromFileDir, spec);
  if (existsSync(`${abs}.js`)) return `${spec}.js`;
  try {
    if (statSync(abs).isDirectory() && existsSync(`${abs}/index.js`)) {
      return `${spec}/index.js`;
    }
  } catch {
    // not a directory / does not exist — fall through
  }
  // Could not resolve to a built file; leave untouched so the failure is loud
  // rather than silently rewritten to a wrong path.
  return spec;
}

let filesChanged = 0;
let specsRewritten = 0;

const glob = new Bun.Glob(`${DIST}/**/*.js`);
for await (const file of glob.scan(".")) {
  const fromDir = dirname(file);
  const src = await readFile(file, "utf8");
  let touched = false;
  const out = src.replace(SPEC_RE, (whole, lead: string, quote: string, spec: string) => {
    const next = rewriteSpec(spec, fromDir);
    if (next === spec) return whole;
    touched = true;
    specsRewritten++;
    return `${lead}${quote}${next}${quote}`;
  });
  if (touched) {
    await writeFile(file, out);
    filesChanged++;
  }
}

console.log(`fix-esm-extensions: rewrote ${specsRewritten} specifier(s) across ${filesChanged} file(s).`);
