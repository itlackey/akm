/**
 * `src/core/children.ts` records every child akm starts asynchronously, so that akm-web can stop what is left on
 * shutdown. A start that bypasses it runs on after the server exits. This test fails on one: an asynchronous
 * `node:child_process` function (`spawn`, `exec`, `execFile`, `fork`) used anywhere but `src/core/children.ts`, or
 * `Bun.spawn` anywhere but `src/runtime.ts`, which records it. Synchronous starts block until the child exits and are
 * allowed. `src/assets/` runs inside other programs (the OpenCode plugin) and is not scanned.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..", "..", "..");
const ASYNC = new Set(["spawn", "exec", "execFile", "fork"]);
const CHILD_PROCESS = `["'](?:node:)?child_process["']`;

/** The asynchronous child starts in `source` that do not go through the record. */
function unrecordedStarts(source: string, file: string): string[] {
  const found: string[] = [];
  if (file !== "src/core/children.ts") {
    for (const [, names] of source.matchAll(
      new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${CHILD_PROCESS}`, "g"),
    )) {
      for (const name of (names ?? "").split(",")) {
        const [imported] = name.trim().split(/\s+as\s+/);
        if (imported && ASYNC.has(imported)) found.push(imported);
      }
    }
    const namespaces = [
      ...source.matchAll(new RegExp(String.raw`import\s+(?:\*\s+as\s+)?(\w+)\s+from\s*${CHILD_PROCESS}`, "g")),
      ...source.matchAll(new RegExp(String.raw`(\w+)\s*=\s*(?:await\s+import|require)\(\s*${CHILD_PROCESS}\s*\)`, "g")),
    ].map(([, name]) => name);
    for (const ns of namespaces) {
      for (const [call] of source.matchAll(
        new RegExp(String.raw`\b${ns}\.(?:spawn|exec|execFile|fork)\b(?!Sync)`, "g"),
      )) {
        found.push(call);
      }
    }
  }
  if (file !== "src/runtime.ts") {
    for (const [call] of source.matchAll(/\b(?:Bun|bunGlobal\(\))\.spawn\s*\(/g)) found.push(call);
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return file === "src/assets" ? [] : sourceFiles(file);
    return /\.(?:ts|mts|js|mjs)$/.test(entry.name) ? [file] : [];
  });
}

describe("child process record", () => {
  test("every asynchronous child start in src goes through src/core/children.ts", () => {
    const offenders = sourceFiles("src").flatMap((file) =>
      unrecordedStarts(readFileSync(path.join(ROOT, file), "utf8"), file).map((call) => `${file}: ${call}`),
    );
    expect(offenders).toEqual([]);
  });

  test("finds the forms an unrecorded start takes", () => {
    const sample = [
      `import { execFile, spawnSync, spawn as start, type ChildProcess } from "node:child_process";`,
      `import * as cp from "child_process";`,
      `cp.fork("x"); cp.execFileSync("y");`,
      `const lazy = await import("node:child_process"); lazy.exec("z");`,
      `Bun.spawn(["a"]); Bun.spawnSync(["b"]);`,
    ].join("\n");
    expect(unrecordedStarts(sample, "src/x.ts")).toEqual(["execFile", "spawn", "cp.fork", "lazy.exec", "Bun.spawn("]);
    expect(unrecordedStarts(`import { spawnSync } from "node:child_process";`, "src/x.ts")).toEqual([]);
  });
});
