// Regression guard for the output-shape registry exhaustiveness contract
// (v1 spec §9). Every `output("<name>", ...)` callsite in src/ must have a
// matching `registerOutputShape("<name>", ...)` — otherwise `shapeForCommand`
// throws "output shape not registered for command: <name>" at runtime.
//
// Pre-2026-05-27 we shipped 12 commands (tasks-sync, tasks-add, tasks-show,
// tasks-remove, tasks-run, tasks-history, tasks-doctor, agent-result, setup,
// proposal-accept-batch, proposal-reject-batch, proposal-revert) that would
// throw on every invocation because their shape was never registered. This
// test scans the codebase mechanically so future drift surfaces immediately.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { shapeForCommand } from "../../src/output/shapes";

const SRC_ROOT = path.join(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function collectOutputCommandNames(): { name: string; locations: string[] }[] {
  // Match `output("<name>"` exactly — single source of truth for which
  // names go through the shape dispatcher.
  const RE = /\boutput\(\s*"([a-z][a-z0-9-]*)"/g;
  const found = new Map<string, string[]>();
  for (const file of walk(SRC_ROOT)) {
    const src = fs.readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    RE.lastIndex = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp exec loop
    while ((m = RE.exec(src))) {
      const name = m[1];
      const list = found.get(name) ?? [];
      list.push(path.relative(SRC_ROOT, file));
      found.set(name, list);
    }
  }
  return [...found.entries()]
    .map(([name, locations]) => ({ name, locations }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe("output-shape registry exhaustiveness", () => {
  const allCommandNames = collectOutputCommandNames();

  test("scanner finds at least 50 distinct output command names", () => {
    // Sanity floor: if the regex breaks (e.g. someone moves to a tagged-template
    // call shape) we want this to surface, not silently pass with 0 names.
    expect(allCommandNames.length).toBeGreaterThanOrEqual(50);
  });

  for (const { name, locations } of allCommandNames) {
    test(`shape registered for "${name}" (used in ${locations.length} file${locations.length === 1 ? "" : "s"})`, () => {
      // Use a benign object so passthrough stamp handlers don't throw on null
      // / non-object shapes. We only care that the dispatcher does NOT throw
      // "output shape not registered" — actual shape transformation is
      // covered by other tests.
      const probe: Record<string, unknown> = { ok: true };
      expect(() => shapeForCommand(name, probe, "brief")).not.toThrow(/output shape not registered/);
    });
  }
});
