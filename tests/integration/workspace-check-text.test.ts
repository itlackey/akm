// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `documents.check` says what akm makes of text before it is saved: the findings `akm lint` reports for that file and
 * whether akm could still read the asset. It is the lint pass on the text, so the same text in a file lints the same.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmLint } from "../../src/commands/lint";
import { resetConfigCache } from "../../src/core/config/config";
import { documents } from "../../src/workspace";
import { makeConfig } from "../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let claude: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  claude = path.join(storage.root, "claude");
  fs.mkdirSync(claude, { recursive: true });
  writeSandboxConfig({
    ...makeConfig(storage.stashDir),
    semanticSearchMode: "off",
    bundles: {
      stash: { path: storage.stashDir, writable: true, components: { main: { root: ".", adapter: "akm" } } },
      claude: { path: claude, writable: true, components: { main: { root: ".", adapter: "claude" } } },
    },
  });
  resetConfigCache();
});
afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

const check = (relative: string, content: string, bundle = "stash") =>
  documents.check({ bundle, path: relative, content });

const GOOD =
  "---\ndescription: Careful restores\nwhen_to_use: Before a restore\nupdated: 2026-11-01\n---\n\n# Careful\n";
const WORKFLOW = [
  "---",
  "type: workflow",
  "description: Cut a release",
  "updated: 2026-11-01",
  "steps:",
  "  - id: cut",
  "---",
  "",
  "## cut",
  "",
  "Cut the branch.",
  "",
].join("\n");

describe("the findings", () => {
  test("clean text has no findings and can be read", async () => {
    expect(await check("lessons/careful.md", GOOD)).toMatchObject({
      type: "lesson",
      findings: [],
      warnings: [],
      readable: true,
    });
  });

  test("text lints as the same text in a file does, and nothing is written", async () => {
    const text = "---\ndescription: Note\n---\n\nSee /tmp/akm-5-gone/current.md\n";
    const file = path.join(storage.stashDir, "knowledge/note.md");
    const before = fs.readdirSync(storage.stashDir, { recursive: true });
    const leftovers = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("akm-check-"));

    const checked = await check("knowledge/note.md", text);

    expect(fs.readdirSync(storage.stashDir, { recursive: true })).toEqual(before);
    expect(leftovers()).toEqual([]);
    fs.writeFileSync(file, text);
    const linted = (await akmLint({ dir: storage.stashDir })).flagged;
    expect(checked.findings.map(({ issue, detail, line }) => ({ issue, detail, line }))).toEqual(
      linted.map(({ issue, detail, line }) => ({ issue, detail, line })),
    );
    expect(checked.findings.map((finding) => finding.issue).sort()).toEqual(["missing-updated", "stale-path"]);
    expect(checked.findings.find((finding) => finding.issue === "stale-path")?.line).toBe(5);
  });

  test("a loose file is linted by the type the indexer gives it", async () => {
    const checked = await check("reports/q3.md", "---\ndescription: Q3\n---\n\nBody.\n");

    expect(checked.findings.map((finding) => finding.issue)).toEqual(["missing-updated"]);
  });

  test("a file that is no asset has no type and nothing to read", async () => {
    expect(await check("notes/todo.txt", "one\ntwo\n")).toMatchObject({
      type: null,
      findings: [],
      readable: true,
    });
  });
});

describe("whether akm could still read the asset", () => {
  test("malformed frontmatter cannot be read, with its line", async () => {
    const checked = await check(
      "lessons/bad.md",
      "---\ndescription: ok\nwhen_to_use: [unclosed\nupdated: 2026-11-01\n---\n\nBody.\n",
    );

    expect(checked.readable).toBe(false);
    expect(checked.unreadable).toEqual({
      reason: "AKM Markdown has malformed YAML frontmatter.",
      line: expect.any(Number),
    });
    expect(checked.unreadable?.line).toBeGreaterThanOrEqual(3);
  });

  test("a workflow that does not compile cannot be read, a good one can", async () => {
    const broken = await check("workflows/release.md", WORKFLOW.replace("  - id: cut\n", "  nope\n"));
    const good = await check("workflows/release.md", WORKFLOW);

    expect(broken.readable).toBe(false);
    expect(broken.unreadable?.reason).toMatch(/Workflow|workflow/);
    // The reason names the file by its path in the bundle, never the scratch folder the check ran in.
    expect(broken.unreadable?.reason).toContain("workflows/release.md");
    expect(broken.unreadable?.reason).not.toContain("akm-check-");
    expect(broken.unreadable?.reason).not.toContain(os.tmpdir());
    expect(
      broken.findings.some((finding) => finding.issue === "invalid-workflow-structure" && finding.line !== undefined),
    ).toBe(true);
    expect(good).toMatchObject({ type: "workflow", readable: true });
  });

  test("a task that does not parse cannot be read", async () => {
    const broken = await check("tasks/nightly.yml", "version: 4\nuses: [unclosed\n");
    const good = await check("tasks/nightly.yml", 'version: 4\nrun: echo hi\nschedule: "0 3 * * *"\n');

    expect(broken.readable).toBe(false);
    expect(broken.unreadable?.reason).toBeTruthy();
    expect(good.readable).toBe(true);
  });
});

describe("the places akm does not check", () => {
  test("a bundle of another adapter, a path outside the bundle, and protected places are refused", async () => {
    await expect(check("agents/x.md", GOOD, "claude")).rejects.toThrow("akm checks the files of akm bundles");
    await expect(check("../x.md", GOOD)).rejects.toThrow("inside the bundle");
    await expect(check("env/prod.env", "A=1\n")).rejects.toThrow("protected-file view");
    await expect(check(".git/config", "[core]\n")).rejects.toThrow("managed by akm");
    await expect(check("knowledge/x.md", GOOD, "missing")).rejects.toThrow("disabled or unavailable");
  });
});
