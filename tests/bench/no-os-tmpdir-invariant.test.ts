/**
 * Invariant: no bench source under `tests/bench/*.ts` may reference
 * `os.tmpdir`. All bench tmp dirs MUST go through `benchTmpRoot()` /
 * `benchMkdtemp()` from `./tmp`, which redirects to
 * `${AKM_CACHE_DIR}/bench/` (#276).
 *
 * Allowlist: `tests/bench/tmp.ts` and this test file. The helper is
 * permitted to mention `os.tmpdir` in its docstrings/comments because it
 * documents what it replaces; this test file mentions the symbol in its
 * grep target.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ALLOWLIST = new Set<string>(["tmp.ts", "no-os-tmpdir-invariant.test.ts"]);

const benchDir = path.resolve(import.meta.dir);

describe("bench source invariant: no os.tmpdir (#276)", () => {
  test("no bench *.ts file (outside the allowlist) references os.tmpdir", () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const entry of fs.readdirSync(benchDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts")) continue;
      if (ALLOWLIST.has(entry.name)) continue;
      const full = path.join(benchDir, entry.name);
      const lines = fs.readFileSync(full, "utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (/os\.tmpdir/.test(line) || /\btmpdir\s*\(/.test(line)) {
          offenders.push({ file: entry.name, line: i + 1, text: line.trim() });
        }
      }
    }
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n");
      throw new Error(
        `Found ${offenders.length} disallowed os.tmpdir reference(s) under tests/bench/.\n` +
          `Use benchTmpRoot()/benchMkdtemp() from ./tmp instead (#276):\n${detail}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
