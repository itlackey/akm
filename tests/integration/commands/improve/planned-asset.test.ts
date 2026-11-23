import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isDeprecatedOrSuperseded } from "../../../../src/commands/improve/preparation";
import { type AkmConfig, saveConfig } from "../../../../src/core/config/config";
import { type Cleanup, makeStashDir, sandboxXdgConfigHome, sandboxXdgDataHome } from "../../../_helpers/sandbox";

let cleanups: Cleanup[] = [];
beforeEach(() => {
  cleanups = [sandboxXdgConfigHome().cleanup, sandboxXdgDataHome().cleanup];
});
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

test("a planned ref whose qualified asset is gone reads false, not another bundle's copy of the concept", () => {
  const a = makeStashDir();
  const b = makeStashDir();
  cleanups.push(a.cleanup, b.cleanup);
  for (const root of [a.dir, b.dir]) {
    fs.mkdirSync(path.join(root, "memories"), { recursive: true });
    fs.writeFileSync(path.join(root, "memories", "note.md"), "---\nbeliefState: deprecated\n---\n\nbody\n");
  }
  saveConfig({
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles: { a: { path: a.dir, writable: true }, b: { path: b.dir, writable: true } },
    defaultBundle: "a",
  } as AkmConfig);
  const planned = { ref: "memories/note", type: "memory", reason: "scope-type" as const, filePath: "x" };

  expect(isDeprecatedOrSuperseded({ ...planned, itemRef: "a//memories/note" })).toBe(true);
  fs.rmSync(path.join(a.dir, "memories", "note.md"));
  expect(isDeprecatedOrSuperseded({ ...planned, itemRef: "a//memories/note" })).toBe(false);
  expect(isDeprecatedOrSuperseded({ ...planned, itemRef: "b//memories/note" })).toBe(true);
});
