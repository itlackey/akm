// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CLI-level coverage for `--format html` and the global `--output <path>`
 * flag (#582), driven through the in-process harness.
 *
 * `--format html` works on every command (D7). `akm health` renders its bespoke
 * report by registering a renderer; every other command falls back to a generic
 * rendering of its shaped envelope. This reverses chunk-9 WI-9.4c, which had
 * removed the HTML fallback and left `html` rejected everywhere except health —
 * the replacement fallback is a real rendering, not the JSON-in-<pre> template
 * that decision deleted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createProposal } from "../src/commands/proposal/repository";
import { runCliCapture } from "./_helpers/cli";
import { type Cleanup, type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

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

function seedProposal(ref = "lessons/rg-over-grep"): void {
  createProposal(storage.stashDir, {
    ref,
    source: "reflect",
    payload: { content: VALID_LESSON },
  });
}

describe("--format html on non-health commands", () => {
  test("akm proposal list --format html renders the envelope generically", async () => {
    seedProposal();
    const { code, stdout } = await runCliCapture(["proposal", "list", "--format", "html"]);
    expect(code).toBe(0);
    expect(stdout).toContain("<!doctype html>");
    expect(stdout).toContain("</html>");
    // The generic renderer titles the document with the command name, which is
    // how you can tell it apart from a registered bespoke renderer.
    expect(stdout).toContain("proposal-list");
    // Not the JSON-in-<pre> template WI-9.4c deleted.
    expect(stdout).not.toMatch(/<pre>\s*\{/);
  });

  test("invalid --format still rejects unknown values and lists html", async () => {
    const { code, stderr } = await runCliCapture(["proposal", "list", "--format", "xml"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Invalid value for --format: xml");
    expect(stderr).toContain("html");
  });
});

describe("--output <path>", () => {
  test("--format html --output writes the rendered document to the file", async () => {
    seedProposal();
    const out = path.join(storage.root, "proposals.html");
    const { code, stdout } = await runCliCapture(["proposal", "list", "--format", "html", "--output", out]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, "utf8")).toContain("<!doctype html>");
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

describe("akm health --report", () => {
  test("--format html renders the full report from the bespoke template (echarts is CDN-only, chunk-9 WI-9.4d)", async () => {
    const { code, stdout } = await runCliCapture(["health", "--report", "--format", "html"]);
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

  test("--window-compare overrides the trend window and --output writes the file", async () => {
    const out = path.join(storage.root, "health.html");
    const { code, stdout } = await runCliCapture([
      "health",
      "--report",
      "--format",
      "html",
      "--window-compare",
      "7d",
      "--output",
      out,
    ]);
    expect([0, 4]).toContain(code);
    expect(stdout.trim()).toBe("");
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("Trend vs prior 7d");
    expect(html).toContain("AKM Health Report");
  });

  test("the report dataset is format-independent: --format json carries the same data", async () => {
    // The pre-D7 design made the full report reachable ONLY as html — the
    // format determined what data you could have. --report is a data flag, so
    // the identical dataset must come back as ordinary JSON.
    const { code, stdout } = await runCliCapture(["health", "--report", "--format", "json"]);
    expect([0, 4]).toContain(code);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed.runs)).toBe(true);
    expect(parsed.report.window).toBe("24h");
    expect(parsed.report.compare).toBe("24h");
    expect(Array.isArray(parsed.report.pendingProposals)).toBe(true);
  });

  test.each([
    ["ISO date", "2026-07-01"],
    ["ISO timestamp", "2026-07-01T12:34:56.000Z"],
    ["epoch milliseconds", String(Date.parse("2026-07-01T12:34:56.000Z"))],
  ] as const)("accepts an absolute %s --since value", async (_label, since) => {
    const { code, stdout } = await runCliCapture(["health", "--report", "--since", since, "--format=json"]);

    expect([0, 4]).toContain(code);
    const parsed = JSON.parse(stdout);
    expect(parsed.report.window).toBe(since);
    expect(Array.isArray(parsed.runs)).toBe(true);
  });

  test("explicit report windows do not conflict with an implicit comparison window", async () => {
    const reportArgs = [
      "health",
      "--report",
      "--since",
      "7d",
      "--windows",
      "name=older,since=2026-07-01T00:00:00.000Z,until=2026-07-02T00:00:00.000Z",
      "--windows",
      "name=newer,since=2026-07-02T00:00:00.000Z,until=2026-07-03T00:00:00.000Z",
    ];
    const { code, stdout } = await runCliCapture([...reportArgs, "--format=json"]);

    expect([0, 4]).toContain(code);
    const parsed = JSON.parse(stdout) as {
      windows?: Array<{ name: string }>;
      report: { window: string; compare: string; comparisonMode: string };
    };
    expect(parsed.report.window).toBe("7d");
    expect(parsed.report.compare).toBe("older → newer");
    expect(parsed.report.comparisonMode).toBe("custom");
    expect(parsed.windows?.map((window) => window.name)).toEqual(["older", "newer"]);

    const html = await runCliCapture([...reportArgs, "--format=html"]);
    expect([0, 4]).toContain(html.code);
    expect(html.stdout).toContain("Trend: older → newer");
    expect(html.stdout).not.toContain("Trend vs prior 24h");
  });

  test("plain akm health carries no report dataset and renders html generically", async () => {
    const { code, stdout } = await runCliCapture(["health", "--format", "json"]);
    expect([0, 4]).toContain(code);
    expect(JSON.parse(stdout).report).toBeUndefined();

    const html = await runCliCapture(["health", "--format", "html"]);
    expect([0, 4]).toContain(html.code);
    // Without the report dataset the registered renderer falls through to the
    // generic rendering — no bespoke template, no error.
    expect(html.stdout).toContain("<h1>akm health</h1>");
    expect(html.stdout).not.toContain("AKM Health Report");
  });
});
