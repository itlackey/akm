// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * All six `--format` values work on every non-exempt command — a contract
 * `STABILITY.md` calls Stable. The failure modes this guards: `md` silently
 * emitting the JSON envelope, `html` throwing `INVALID_FLAG_VALUE`, and
 * `akm health` reaching neither format through `output()` because it
 * intercepted the format itself.
 *
 * This suite is deliberately table-driven over real commands rather than over
 * hand-picked payloads: a new command inherits the coverage, and the failure it
 * catches is the one that actually shipped — a format that "works" by handing
 * back a different format's bytes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runCliCapture } from "./_helpers/cli";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
} from "./_helpers/sandbox";

const FORMATS = ["json", "jsonl", "yaml", "text", "md", "html"] as const;

/**
 * Read-only commands exercised in every format. Each must be safe to run
 * against an empty-ish stash and must reach `output()` — that is the contract
 * under test. Mutating commands are covered by the html-does-not-block case
 * below rather than by running them six times each.
 */
const READ_COMMANDS: readonly (readonly string[])[] = [
  ["search", "alias"],
  ["bundle", "list"],
  ["info"],
  ["config", "list"],
  ["env", "list"],
  ["secret", "list"],
  ["proposal", "list"],
  ["health"],
];

let stashDir = "";
let cleanup: Cleanup = () => {};

beforeEach(() => {
  const dataResult = sandboxXdgDataHome();
  const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
  const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
  const stashResult = sandboxStashDir(cfgResult.cleanup);
  stashDir = stashResult.dir;
  cleanup = stashResult.cleanup;

  const notePath = path.join(stashDir, "memories", "alias-note.md");
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, ["---", "description: Shell alias tip", "---", "", "Use aliases.", ""].join("\n"), "utf8");
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  stashDir = "";
});

describe("every --format value produces real output on every read command", () => {
  for (const command of READ_COMMANDS) {
    for (const format of FORMATS) {
      test(`akm ${command.join(" ")} --format ${format}`, async () => {
        const result = await runCliCapture([...command, `--format=${format}`]);

        // `akm health` exits 4 on a health warning, which is success-shaped.
        expect([0, 4]).toContain(result.code);
        expect(result.stdout.trim().length).toBeGreaterThan(0);

        if (format === "html") {
          expect(result.stdout).toContain("<html");
          // The retired JSON-in-<pre> fallback is not an acceptable rendering.
          expect(result.stdout).not.toMatch(/<pre>\s*\{/);
        }
        if (format === "md") {
          // Must not be the JSON envelope wearing a markdown flag — that silent
          // wrong-format output is exactly what this suite guards against.
          expect(result.stdout.trimStart().startsWith("{")).toBe(false);
        }
        if (format === "text") {
          // Same guard as `md`, symmetric: a command with no registered text
          // formatter must fall through to the generic text renderer, not to
          // the JSON envelope wearing a text flag (that silent wrong-format
          // output shipped undetected because this suite only checked
          // non-empty output for `text` — see `renderGenericText` in
          // `output()`'s `text` case, src/cli/shared.ts).
          expect(result.stdout.trimStart().startsWith("{")).toBe(false);
          // Stronger than the `md` guard above on purpose: a fallback that reused
          // `renderGenericMarkdown` for `text` would pass the JSON-envelope check above
          // while still emitting `#` heading markers, `_..._` emphasis, and `| ... |`
          // table syntax — markdown wearing a text flag instead of JSON wearing one.
          // Assert no markdown heading-marker line at all, which is exactly what that
          // reuse would have produced for every top-level and nested key
          // (`renderGenericMarkdown` headers each key it recurses into).
          expect(result.stdout).not.toMatch(/^#{1,6}\s/m);
        }
        if (format === "json") {
          expect(() => JSON.parse(result.stdout)).not.toThrow();
        }
      });
    }
  }
});

describe("html is no longer health-only", () => {
  test("a non-health read command renders html instead of exiting 2", async () => {
    const result = await runCliCapture(["bundle", "list", "--format=html"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("<!doctype html>");
  });

  test("a mutating command completes its write under --format html", async () => {
    // `--format html` with `--output` must both write and render: it must neither
    // be rejected at startup (exit 2 without writing) nor write and THEN throw.
    const result = await runCliCapture(["remember", "html format probe", "--format=html"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("<html");
    const memories = fs.readdirSync(path.join(stashDir, "memories"));
    expect(memories.some((f) => f !== "alias-note.md")).toBe(true);
  });
});

describe("akm health keeps its bespoke reports through the registry", () => {
  test("--report --format html renders the report template, not the generic fallback", async () => {
    const result = await runCliCapture(["health", "--report", "--format=html"]);

    expect([0, 4]).toContain(result.code);
    // The report template carries content the generic renderer never emits.
    expect(result.stdout).toContain("<html");
    expect(result.stdout).not.toContain("<h1>akm health</h1>");
  });

  test("--format md renders the per-run table for a run-grouped read", async () => {
    const result = await runCliCapture(["health", "--group-by=run", "--format=md"]);

    expect([0, 4]).toContain(result.code);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.stdout.trimStart().startsWith("{")).toBe(false);
  });

  test("the renderers are data-driven: plain health under html falls to the generic rendering", async () => {
    const result = await runCliCapture(["health", "--format=html"]);

    expect([0, 4]).toContain(result.code);
    expect(result.stdout).toContain("<h1>akm health</h1>");
  });
});
