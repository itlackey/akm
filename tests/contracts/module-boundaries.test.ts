import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// Import direction: files under core/ and storage/ are the bottom layer and must not
// value-import from any other src/ top-level dir. `import type` is exempt (erased).
// ALLOWED_UPWARD holds today's edges as "from>to": count. It may only shrink.
const ALLOWED_UPWARD: Record<string, number> = {
  "core>commands": 2,
  "core>execution": 4,
  "core>indexer": 4,
  "core>integrations": 2,
  "core>tasks": 7,
  "core>workflows": 3,
  "storage>indexer": 6,
  "storage>llm": 1,
  "storage>workflows": 1,
};
const LOW = new Set(["core", "storage"]);
const src = path.resolve(import.meta.dir, "..", "..", "src");
const IMPORT = /^(?:import|export)\s+(?!type\b)[^;]*?from\s+["'](\.[^"']*)["']|^import\s+["'](\.[^"']*)["']/gm;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("core and storage do not import upward beyond the allowlist", () => {
  const found: Record<string, number> = {};
  for (const file of walk(src)) {
    const from = path.relative(src, file).split(path.sep)[0] ?? "";
    if (!LOW.has(from)) continue;
    for (const m of fs.readFileSync(file, "utf8").matchAll(IMPORT)) {
      const to =
        path.relative(src, path.resolve(path.dirname(file), (m[1] ?? m[2]) as string)).split(path.sep)[0] ?? "";
      if (to === from || LOW.has(to) || !fs.existsSync(path.join(src, to, ".")) || to.startsWith("..")) continue;
      found[`${from}>${to}`] = (found[`${from}>${to}`] ?? 0) + 1;
    }
  }
  const over = Object.entries(found).filter(([k, n]) => n > (ALLOWED_UPWARD[k] ?? 0));
  const stale = Object.entries(ALLOWED_UPWARD).filter(([k, n]) => (found[k] ?? 0) < n);
  expect({ over, stale, found }).toEqual({ over: [], stale: [], found: ALLOWED_UPWARD });
});
