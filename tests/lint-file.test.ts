// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm lint <file>`: the bundle lint's own rules on one file. In a bundle the
 * type comes from the file's location and cross-file checks run; outside one
 * the file needs `--type` and only its own rules run.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../src/commands/lint/index";
import { UsageError } from "../src/core/errors";
import { runCliCapture } from "./_helpers/cli";
import { makeConfig } from "./_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

const VALID_TASK = "version: 4\nrun: echo hi\n";
const BAD_TASK = "version: 4\nrun: 'echo hi\nname:\n\tbroken: '@daily'\n";
// Valid frontmatter, but `xrefs` names a memory that does not exist (a cross-file finding).
const BROKEN_REF = "---\ndescription: points nowhere\nupdated: 2026-01-01\nxrefs:\n  - memories/gone\n---\n\nBody.\n";
// Fixable: frontmatter without `updated`.
const NEEDS_UPDATED = "---\ndescription: needs a date\n---\n\nBody.\n";

function write(root: string, rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

async function usageError(run: () => Promise<unknown>): Promise<UsageError> {
  try {
    await run();
  } catch (e) {
    expect(e).toBeInstanceOf(UsageError);
    return e as UsageError;
  }
  throw new Error("expected a UsageError");
}

describe("akm lint <file>", () => {
  let storage: IsolatedAkmStorage;
  let loose: string; // a directory outside the bundle
  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    loose = fs.mkdtempSync(path.join(path.dirname(storage.stashDir), "loose-"));
  });
  afterEach(() => storage.cleanup());
  const lint = (file: string, extra: Record<string, unknown> = {}) =>
    akmLint({ file, dir: storage.stashDir, config: makeConfig(storage.stashDir), ...extra });

  test("a bundle markdown file reports only its own issues", async () => {
    const broken = write(storage.stashDir, "memories/a.md", BROKEN_REF);
    write(storage.stashDir, "memories/b.md", BROKEN_REF);
    const result = await lint(broken);
    expect(result.flagged.map((i) => i.file)).toEqual(["memories/a.md"]);
    expect(result.flagged[0]?.issue).toBe("missing-ref");
    expect(result.summary.flagged).toBe(1);
  });

  test("the result has the same top-level keys as a bundle lint", async () => {
    const file = write(storage.stashDir, "memories/a.md", BROKEN_REF);
    const bundle = await akmLint({ dir: storage.stashDir, config: makeConfig(storage.stashDir) });
    expect(Object.keys(await lint(file)).sort()).toEqual(Object.keys(bundle).sort());
  });

  test("a task file in a bundle: valid is clean, invalid is flagged", async () => {
    const good = write(storage.stashDir, "tasks/good.yml", VALID_TASK);
    const bad = write(storage.stashDir, "tasks/bad.yml", BAD_TASK);
    expect((await lint(good)).summary.flagged).toBe(0);
    const result = await lint(bad);
    expect(result.flagged.map((i) => [i.file, i.issue])).toEqual([["tasks/bad.yml", "invalid-task-yaml"]]);
  });

  test("a task file outside any bundle needs --type tasks and is then checked", async () => {
    const good = write(loose, "good.yml", VALID_TASK);
    const bad = write(loose, "bad.yml", BAD_TASK);
    expect((await lint(good, { typeFilter: "tasks" })).summary.flagged).toBe(0);
    expect((await lint(bad, { typeFilter: "tasks" })).flagged[0]?.issue).toBe("invalid-task-yaml");
    const err = await usageError(() => lint(good));
    expect(err.message).toContain("--type");
    expect(err.message).toContain("tasks");
  });

  test("a .yaml near miss gets the message the bundle lint gives it", async () => {
    const near = write(loose, "nightly.yaml", VALID_TASK);
    const result = await lint(near, { typeFilter: "tasks" });
    expect(result.flagged.some((i) => i.issue === "invalid-task-yaml" && /\.yml/.test(i.detail))).toBe(true);
  });

  test("--type that disagrees with the file's location is a usage error", async () => {
    const file = write(storage.stashDir, "tasks/good.yml", VALID_TASK);
    const err = await usageError(() => lint(file, { typeFilter: "memories" }));
    expect(err.message).toContain("tasks");
  });

  test("a directory and a missing path are usage errors; the directory message names --dir", async () => {
    expect((await usageError(() => lint(storage.stashDir))).message).toContain("--dir");
    await usageError(() => lint(path.join(loose, "nope.yml")));
  });

  test("--prune-dangling-edges with a file is a usage error", async () => {
    const file = write(storage.stashDir, "memories/a.md", BROKEN_REF);
    await usageError(() => lint(file, { pruneDanglingEdges: true }));
  });

  test("--fix repairs only the named file", async () => {
    const a = write(storage.stashDir, "knowledge/a.md", NEEDS_UPDATED);
    const b = write(storage.stashDir, "knowledge/b.md", NEEDS_UPDATED);
    const result = await lint(a, { fix: true });
    expect(result.fixed.map((i) => i.file)).toEqual(["knowledge/a.md"]);
    expect(fs.readFileSync(a, "utf8")).toContain("updated:");
    expect(fs.readFileSync(b, "utf8")).toBe(NEEDS_UPDATED);
  });

  test("a broken ref is reported inside a bundle and not checked for a copy outside it", async () => {
    const inside = write(storage.stashDir, "memories/a.md", BROKEN_REF);
    const outside = write(loose, "a.md", BROKEN_REF);
    expect((await lint(inside)).flagged.some((i) => i.issue === "missing-ref")).toBe(true);
    const result = await lint(outside, { typeFilter: "memories" });
    expect(result.flagged.some((i) => i.issue === "missing-ref")).toBe(false);
  });

  test("through the CLI: exit codes for the usage errors, 0 for a lint run", async () => {
    const good = write(loose, "good.yml", VALID_TASK);
    const bad = write(loose, "bad.yml", BAD_TASK);
    expect((await runCliCapture(["lint", good, "--type", "tasks"])).code).toBe(0);
    const badRun = await runCliCapture(["lint", bad, "--type", "tasks"]);
    expect(badRun.code).toBe(0);
    expect(JSON.parse(badRun.stdout).summary.flagged).toBe(1);
    expect((await runCliCapture(["lint", bad, "--type", "tasks", "--fail-on-flagged"])).code).toBe(1);
    const noType = await runCliCapture(["lint", good]);
    expect(noType.code).toBe(2);
    expect(noType.stderr + noType.stdout).toContain("--type");
    const dir = await runCliCapture(["lint", loose]);
    expect(dir.code).toBe(2);
    expect(dir.stderr + dir.stdout).toContain("--dir");
    expect((await runCliCapture(["lint", path.join(loose, "nope.yml")])).code).toBe(2);
    expect((await runCliCapture(["lint", good, "--type", "tasks", "--prune-dangling-edges"])).code).toBe(2);
    const inBundle = write(storage.stashDir, "tasks/in.yml", VALID_TASK);
    expect((await runCliCapture(["lint", inBundle, "--type", "memories"])).code).toBe(2);
  });
});
