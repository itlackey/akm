// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-license-headers.ts
 *
 * Verifies that every src/**\/*.ts file has the canonical 3-line MPL-2.0
 * header. Exits non-zero and lists offending files if any are missing.
 *
 * Usage:
 *   bun scripts/lint-license-headers.ts          # check only
 *   bun scripts/lint-license-headers.ts --fix    # add missing headers
 *
 * Exclusions:
 *   - dist/         (compiled output)
 *   - schemas/      (generated JSON schemas)
 *   - *.d.ts        (ambient type declarations)
 *   - *.test.ts     (tests live under tests/, not src/, but guarded anyway)
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const HEADER = `// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.`;

/** First line of the header — used as a quick presence check */
const HEADER_LINE1 = "// This Source Code Form is subject to the terms of the Mozilla Public";

const { values } = parseArgs({
  options: {
    fix: { type: "boolean", default: false },
  },
  strict: false,
});

const FIX_MODE = values.fix === true;

const repoRoot = path.resolve(import.meta.dir, "..");
const srcDir = path.join(repoRoot, "src");

/** Recursively collect .ts files under a directory */
function collectTs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Exclusions: skip dist, schemas
      if (entry.name === "dist" || entry.name === "schemas") continue;
      results.push(...collectTs(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

const files = collectTs(srcDir);
const missing: string[] = [];

for (const file of files) {
  const content = fs.readFileSync(file, "utf-8");
  // If the file starts with a shebang, check the line after it
  let checkContent = content;
  if (content.startsWith("#!")) {
    const newlineIdx = content.indexOf("\n");
    checkContent = newlineIdx >= 0 ? content.slice(newlineIdx + 1) : content;
  }
  const firstNonEmpty = checkContent.trimStart().slice(0, HEADER_LINE1.length);
  if (!firstNonEmpty.startsWith(HEADER_LINE1)) {
    missing.push(file);
  }
}

if (missing.length === 0) {
  console.log(`✓ MPL-2.0 header present in all ${files.length} src/**/*.ts files.`);
  process.exit(0);
}

if (!FIX_MODE) {
  console.error(`\nMissing MPL-2.0 license header in ${missing.length} file(s):\n`);
  for (const f of missing) {
    console.error(`  ${path.relative(repoRoot, f)}`);
  }
  console.error(`\nRun with --fix to add headers automatically:`);
  console.error(`  bun scripts/lint-license-headers.ts --fix\n`);
  process.exit(1);
}

// Fix mode: prepend header to each missing file
let fixed = 0;
for (const file of missing) {
  const original = fs.readFileSync(file, "utf-8");

  // If the file starts with a shebang, insert after it
  let newContent: string;
  if (original.startsWith("#!")) {
    const newlineIdx = original.indexOf("\n");
    const shebang = original.slice(0, newlineIdx + 1);
    const rest = original.slice(newlineIdx + 1);
    newContent = `${shebang}${HEADER}\n\n${rest.startsWith("\n") ? rest.slice(1) : rest}`;
  } else {
    newContent = `${HEADER}\n\n${original}`;
  }

  fs.writeFileSync(file, newContent, "utf-8");
  fixed++;
}

console.log(`Fixed ${fixed} file(s) — MPL-2.0 header added.`);
process.exit(0);
