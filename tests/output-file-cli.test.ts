// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The global `--output <path>` flag and the `akm health --report` dataset, driven through the in-process harness
 * (#582). `--report` is a data flag: the full report comes back in every format, not only as a rendered document.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createProposal } from "../src/commands/proposal/repository";
import { resolveOutputMode } from "../src/output/context";
import { deliverRendered } from "../src/output/stdout";
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
  createProposal(storage.stashDir, { ref, source: "reflect", payload: { content: VALID_LESSON } });
}

describe("--output <path>", () => {
  test("--output and --output= populate the output path; it is absent otherwise", () => {
    expect(resolveOutputMode(["--output", "/tmp/x.md"]).outputPath).toBe("/tmp/x.md");
    expect(resolveOutputMode(["--output=/tmp/y.md"]).outputPath).toBe("/tmp/y.md");
    expect(resolveOutputMode([]).outputPath).toBeUndefined();
  });

  test("deliverRendered creates parent folders and ends the file with exactly one newline", () => {
    const out = path.join(storage.root, "nested", "report.md");
    deliverRendered("# report", out);
    expect(fs.readFileSync(out, "utf8")).toBe("# report\n");
    deliverRendered("# report\n", out);
    expect(fs.readFileSync(out, "utf8")).toBe("# report\n");
  });

  test("--format md --output writes the rendered document to the file", async () => {
    seedProposal();
    const out = path.join(storage.root, "proposals.md");
    const { code, stdout } = await runCliCapture(["proposal", "list", "--format", "md", "--output", out]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
    expect(fs.readFileSync(out, "utf8")).toContain("lessons/rg-over-grep");
  });

  test("also redirects json output to the file", async () => {
    seedProposal();
    const out = path.join(storage.root, "proposals.json");
    const { code, stdout } = await runCliCapture(["proposal", "list", "--format", "json", `--output=${out}`]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
    expect(JSON.parse(fs.readFileSync(out, "utf8")).totalCount).toBe(1);
  });
});

describe("akm health --report", () => {
  test("--format json carries the full report dataset", async () => {
    const { code, stdout } = await runCliCapture(["health", "--report", "--format", "json"]);
    expect([0, 4]).toContain(code);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed.runs)).toBe(true);
    expect(parsed.report.window).toBe("24h");
    expect(parsed.report.compare).toBe("24h");
    expect(Array.isArray(parsed.report.pendingProposals)).toBe(true);
  });

  test("--window-compare overrides the trend window and --output writes the md report", async () => {
    const json = await runCliCapture(["health", "--report", "--window-compare", "7d", "--format=json"]);
    expect([0, 4]).toContain(json.code);
    expect(JSON.parse(json.stdout).report.compare).toBe("7d");

    const out = path.join(storage.root, "health.md");
    const md = await runCliCapture(["health", "--report", "--window-compare", "7d", "--format", "md", "--output", out]);
    expect([0, 4]).toContain(md.code);
    expect(md.stdout.trim()).toBe("");
    expect(fs.readFileSync(out, "utf8").trim().length).toBeGreaterThan(0);
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
    const { code, stdout } = await runCliCapture([
      "health",
      "--report",
      "--since",
      "7d",
      "--windows",
      "name=older,since=2026-07-01T00:00:00.000Z,until=2026-07-02T00:00:00.000Z",
      "--windows",
      "name=newer,since=2026-07-02T00:00:00.000Z,until=2026-07-03T00:00:00.000Z",
      "--format=json",
    ]);
    expect([0, 4]).toContain(code);
    const parsed = JSON.parse(stdout) as {
      windows?: Array<{ name: string }>;
      report: { window: string; compare: string; comparisonMode: string };
    };
    expect(parsed.report.window).toBe("7d");
    expect(parsed.report.compare).toBe("older → newer");
    expect(parsed.report.comparisonMode).toBe("custom");
    expect(parsed.windows?.map((window) => window.name)).toEqual(["older", "newer"]);
  });

  test("plain akm health carries no report dataset", async () => {
    const { code, stdout } = await runCliCapture(["health", "--format", "json"]);
    expect([0, 4]).toContain(code);
    expect(JSON.parse(stdout).report).toBeUndefined();
  });
});
