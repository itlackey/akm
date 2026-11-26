// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint` parity net: the findings, their order, the exit code, the `--json` shape, the warnings and (for `--fix`)
 * the bytes left on disk, over bundles of the akm, akm-workflow, okf and generic-files adapters, with `--type`
 * filters, a `.yaml` near-miss task, a skill folder without `SKILL.md`, `.env` files in other bundles, and moved and
 * dangling refs. The goldens in `tests/fixtures/lint-parity/golden/` were recorded on the code before lint moved into
 * the adapters (#1750) and must not change with it: a refactor that changes one is wrong. Re-record only for an
 * approved behaviour change, with `RECORD_LINT_PARITY=1`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint";
import { localDateStamp } from "../../src/core/common";
import { resetConfigCache } from "../../src/core/config/config";
import type { EventEnvelope } from "../../src/core/events-types";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const FIXTURES = path.resolve(import.meta.dir, "..", "fixtures", "lint-parity");
const GOLDEN = path.join(FIXTURES, "golden");
const RECORD = process.env.RECORD_LINT_PARITY === "1";

const ADAPTERS: Record<string, string> = {
  main: "akm",
  envb: "akm",
  okf: "okf",
  wf: "akm-workflow",
  gen: "generic-files",
};

let storage: IsolatedAkmStorage;
let bundlesDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  resetConfigCache();
  bundlesDir = path.join(storage.root, "bundles");
  fs.cpSync(path.join(FIXTURES, "bundles"), bundlesDir, { recursive: true });
  // A `missing-updated` fix stamps the file's modification date: pin it so the goldens do not move with the calendar.
  const pinned = new Date("2026-11-02T12:00:00Z");
  const pin = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pin(full);
      else fs.utimesSync(full, pinned, pinned);
    }
  };
  pin(bundlesDir);
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function configure(primary: string): void {
  const bundles: Record<string, unknown> = {};
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    bundles[name] = { path: path.join(bundlesDir, name), writable: true, adapter };
  }
  writeSandboxConfig({ semanticSearchMode: "off", defaultBundle: primary, bundles });
}

function scrub(text: string): string {
  return text.split(storage.root).join("<ROOT>");
}

/** Every file under `dir` with its text, by relative path. */
function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}

function check(name: string, actual: unknown): void {
  const file = path.join(GOLDEN, `${name}.json`);
  // The writer stamps today's `updated` on every write, so the goldens name that date, not the calendar's.
  const text = `${JSON.stringify(actual, null, 2)}\n`.replaceAll(
    `updated: ${localDateStamp(new Date())}`,
    "updated: <TODAY>",
  );
  if (RECORD) {
    fs.mkdirSync(GOLDEN, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  expect(text).toBe(fs.readFileSync(file, "utf8"));
}

interface CliCase {
  name: string;
  primary: string;
  args?: string[];
  /** The bundle whose files are recorded afterwards (a `--fix` run). */
  fixes?: string;
}

const CASES: CliCase[] = [
  { name: "akm-default", primary: "main" },
  { name: "akm-type-knowledge", primary: "main", args: ["--type", "knowledge"] },
  { name: "akm-type-workflows", primary: "main", args: ["--type", "workflows"] },
  { name: "akm-type-tasks", primary: "main", args: ["--type", "tasks"] },
  { name: "akm-type-skills", primary: "main", args: ["--type", "skills"] },
  { name: "akm-type-typo", primary: "main", args: ["--type", "workflo"] },
  { name: "akm-rule-missing-ref", primary: "main", args: ["--rule", "missing-ref"] },
  { name: "akm-fix", primary: "main", args: ["--fix"], fixes: "main" },
  { name: "akm-fix-prune", primary: "main", args: ["--fix", "--prune-dangling-edges"], fixes: "main" },
  { name: "akm-fix-type-knowledge", primary: "main", args: ["--fix", "--type", "knowledge"], fixes: "main" },
  { name: "akm-fail-on-flagged", primary: "main", args: ["--fail-on-flagged"] },
  { name: "env-bundle-default", primary: "envb" },
  { name: "okf-default", primary: "okf" },
  { name: "okf-type", primary: "okf", args: ["--type", "knowledge"] },
  { name: "okf-fix", primary: "okf", args: ["--fix"], fixes: "okf" },
  { name: "workflow-default", primary: "wf" },
  { name: "workflow-type", primary: "wf", args: ["--type", "workflows"] },
  { name: "generic-default", primary: "gen" },
  { name: "generic-type", primary: "gen", args: ["--type", "knowledge"] },
  { name: "file-akm", primary: "main", args: ["{main}/knowledge/colon.md"] },
  { name: "file-akm-fix", primary: "main", args: ["{main}/knowledge/colon.md", "--fix"], fixes: "main" },
  { name: "file-akm-type-mismatch", primary: "main", args: ["{main}/knowledge/colon.md", "--type", "tasks"] },
  { name: "file-akm-task-near-miss", primary: "main", args: ["{main}/tasks/nightly.yaml"] },
  { name: "file-okf", primary: "okf", args: ["{okf}/untyped.md"] },
  { name: "file-generic", primary: "gen", args: ["{gen}/notes.md"] },
];

describe("akm lint parity (#1750)", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      configure(c.primary);
      const args = (c.args ?? []).map((a) => a.replace(/\{(\w+)\}/g, (_, n: string) => path.join(bundlesDir, n)));
      const isFile = args[0] !== undefined && !args[0].startsWith("--");
      const lint = isFile
        ? ["lint", args[0] as string, ...args.slice(1)]
        : ["lint", "--dir", path.join(bundlesDir, c.primary), ...args];
      const run = await runCliCapture([...lint, "--format", "json"]);
      const json = (() => {
        try {
          return JSON.parse(run.stdout);
        } catch {
          return scrub(run.stdout);
        }
      })();
      check(c.name, {
        code: run.code,
        stdout: JSON.parse(scrub(JSON.stringify(json))),
        stderr: scrub(run.stderr),
        ...(c.fixes ? { files: tree(path.join(bundlesDir, c.fixes)) } : {}),
      });
    });
  }

  test("akm-fix-moved-refs", async () => {
    configure("main");
    const moved = {
      ref: "main//memories/new",
      metadata: { from: "main//memories/old" },
    } as unknown as EventEnvelope;
    const result = await akmLint({
      dir: path.join(bundlesDir, "main"),
      fixMovedRefs: true,
      readMoves: () => [moved],
    });
    check("akm-fix-moved-refs", {
      result: JSON.parse(scrub(JSON.stringify(result))),
      files: tree(path.join(bundlesDir, "main")),
    });
  });

  test("akm-moved-refs-listing", async () => {
    configure("main");
    const moved = { ref: "main//memories/new", metadata: { from: "main//memories/old" } } as unknown as EventEnvelope;
    const result = await akmLint({ dir: path.join(bundlesDir, "main"), readMoves: () => [moved] });
    check("akm-moved-refs-listing", JSON.parse(scrub(JSON.stringify(result))));
  });
});
