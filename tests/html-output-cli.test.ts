// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CLI-level coverage for `--format html` and the global `--output <path>`
 * flag (#582), driven through the in-process harness.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createProposal, isProposalSkipped } from "../src/commands/proposal/repository";
import { runCliCapture } from "./_helpers/cli";
import { type Cleanup, type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;
let cleanup: Cleanup = () => {};

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

const VALID_LESSON =
  "---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos\n---\n\nPrefer rg.\n";

function seedProposal(ref = "lesson:rg-over-grep"): void {
  const result = createProposal(storage.stashDir, {
    ref,
    source: "reflect",
    force: true,
    payload: { content: VALID_LESSON },
  });
  if (isProposalSkipped(result)) throw new Error("unexpected skip in seedProposal");
}

describe("--format html (default template)", () => {
  test("akm proposal list --format html renders the JSON envelope in the dark template", async () => {
    seedProposal();
    const { code, stdout } = await runCliCapture(["proposal", "list", "--format", "html"]);
    expect(code).toBe(0);
    expect(stdout).toContain("<!DOCTYPE html>");
    expect(stdout).toContain("<title>akm proposal-list</title>");
    // The JSON envelope is HTML-escaped inside the <pre> block.
    expect(stdout).toContain("&quot;totalCount&quot;: 1");
    expect(stdout).toContain("lesson:rg-over-grep");
    expect(stdout).not.toMatch(/%%[A-Z_]+%%/);
  });

  test("invalid --format still rejects unknown values and lists html", async () => {
    const { code, stderr } = await runCliCapture(["proposal", "list", "--format", "xml"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Invalid value for --format: xml");
    expect(stderr).toContain("html");
  });
});

describe("--output <path>", () => {
  test("writes the html document to the file instead of stdout", async () => {
    seedProposal();
    const out = path.join(storage.root, "proposals.html");
    const { code, stdout } = await runCliCapture(["proposal", "list", "--format", "html", "--output", out]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("&quot;totalCount&quot;: 1");
  });

  test("also redirects json output to the file", async () => {
    seedProposal();
    const out = path.join(storage.root, "proposals.json");
    const { code, stdout } = await runCliCapture(["proposal", "list", "--format", "json", `--output=${out}`]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
    const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(parsed.totalCount).toBe(1);
  });
});

describe("akm health --format html", () => {
  test("renders the full report from the bespoke template (cdn mode)", async () => {
    const { code, stdout } = await withEnv({ AKM_ECHARTS: "cdn" }, () => runCliCapture(["health", "--format", "html"]));
    // health maps warn→4; both pass and warn are valid for a fresh sandbox DB.
    expect([0, 4]).toContain(code);
    expect(stdout).toContain("<!DOCTYPE html>");
    expect(stdout).toContain("AKM Health Report");
    // All 7 chart panels are present.
    for (const id of [
      "chartWallTime",
      "chartPhases",
      "chartStash",
      "chartConsOutput",
      "chartSuccess",
      "chartLint",
      "chartDistill",
    ]) {
      expect(stdout).toContain(`id="${id}"`);
    }
    expect(stdout).toContain('<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>');
    expect(stdout).not.toMatch(/%%[A-Z_]+%%/);
    // Default compare window is 24h — surfaced in exec summary.
    expect(stdout).toContain("Trend vs prior 24h");
  });

  test("--compare overrides the trend window and --output writes the file", async () => {
    const out = path.join(storage.root, "health.html");
    const { code, stdout } = await withEnv({ AKM_ECHARTS: "cdn" }, () =>
      runCliCapture(["health", "--format", "html", "--compare", "7d", "--output", out]),
    );
    expect([0, 4]).toContain(code);
    expect(stdout.trim()).toBe("");
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("Trend vs prior 7d");
    expect(html).toContain("AKM Health Report");
  });

  test("inline mode (default) embeds the vendored echarts payload", async () => {
    const out = path.join(storage.root, "health-inline.html");
    const { code } = await runCliCapture(["health", "--format", "html", "--output", out]);
    expect([0, 4]).toContain(code);
    const stat = fs.statSync(out);
    // The vendored echarts.min.js is ~1MB; a self-contained report must carry it.
    expect(stat.size).toBeGreaterThan(1_000_000);
    const html = fs.readFileSync(out, "utf8");
    expect(html).not.toContain("cdn.jsdelivr.net");
  });
});
