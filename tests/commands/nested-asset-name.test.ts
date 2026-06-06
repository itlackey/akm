/**
 * Nested asset-name creation (issue #503).
 *
 * Users can place a created asset inside a subdirectory of its type folder by
 * passing an explicit `--name` containing `/`-separated segments, e.g.
 *   akm remember "buy milk" --name personal/grocery-list
 *     → <stash>/memories/personal/grocery-list.md  (ref memory:personal/grocery-list)
 *   akm import doc.md --name projects/example/overview
 *     → <stash>/knowledge/projects/example/overview.md (ref knowledge:projects/example/overview)
 *
 * These tests lock in:
 *   - the file lands at the nested path and parent dirs are auto-created,
 *   - the returned ref carries the nested name with no `.md`,
 *   - `..` traversal in a nested name is rejected (UsageError) and writes nothing,
 *   - re-creating without --force errors RESOURCE_ALREADY_EXISTS; --force overwrites.
 *
 * Unit-level guards on the shared normaliser are also asserted directly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { normalizeMarkdownAssetName } from "../../src/commands/knowledge";
import { runCliCapture } from "../_helpers/cli";
import {
  type Cleanup,
  makeSandboxDir,
  type SandboxedDir,
  sandboxStashDir,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];
let stashCleanup: Cleanup = () => {};
let currentStashDir = "";

function makeSourceFile(name: string, body: string): string {
  const d = makeSandboxDir("akm-nested-source-");
  disposers.push(d);
  const filePath = path.join(d.dir, name);
  fs.writeFileSync(filePath, body, "utf8");
  return filePath;
}

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await runCliCapture(args);
  return { status: code, stdout, stderr };
}

beforeEach(() => {
  const stash = sandboxStashDir();
  currentStashDir = stash.dir;
  stashCleanup = stash.cleanup;
  writeSandboxConfig({ semanticSearchMode: "off" });
});

afterEach(() => {
  stashCleanup();
  stashCleanup = () => {};
  currentStashDir = "";
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("normalizeMarkdownAssetName — nested-path guards", () => {
  test("accepts a nested relative path and strips .md", () => {
    expect(normalizeMarkdownAssetName("personal/grocery-list", "fallback")).toBe("personal/grocery-list");
    expect(normalizeMarkdownAssetName("projects/example/overview.md", "fallback")).toBe("projects/example/overview");
  });

  test("rejects a '..' traversal segment", () => {
    expect(() => normalizeMarkdownAssetName("../escape", "fallback")).toThrow(/relative path/);
    expect(() => normalizeMarkdownAssetName("a/../../escape", "fallback")).toThrow(/relative path/);
  });

  test("rejects a '.' segment", () => {
    expect(() => normalizeMarkdownAssetName("a/./b", "fallback")).toThrow(/relative path/);
  });
});

describe("akm remember — nested --name", () => {
  test("writes memory to a nested subdirectory and returns a nested ref", async () => {
    const result = await runCli(["remember", "buy milk", "--name", "personal/grocery-list"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("memory:personal/grocery-list");

    const expectedPath = path.join(currentStashDir, "memories", "personal", "grocery-list.md");
    expect(json.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    // Parent subdirectory was auto-created.
    expect(fs.existsSync(path.join(currentStashDir, "memories", "personal"))).toBe(true);
  });

  test("rejects a '..' traversal name and writes nothing", async () => {
    const result = await runCli(["remember", "should not persist", "--name", "../escape"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toMatch(/relative path/);
    expect(fs.existsSync(path.join(currentStashDir, "memories", "escape.md"))).toBe(false);
  });

  test("re-creating a nested memory without --force errors; --force overwrites", async () => {
    const first = await runCli(["remember", "original body", "--name", "team/handbook"]);
    expect(first.status).toBe(0);
    const filePath = path.join(currentStashDir, "memories", "team", "handbook.md");
    expect(fs.existsSync(filePath)).toBe(true);

    const dup = await runCli(["remember", "second body", "--name", "team/handbook"]);
    expect(dup.status).not.toBe(0);
    const dupJson = JSON.parse(dup.stderr) as { error: string; code?: string };
    expect(JSON.stringify(dupJson)).toContain("RESOURCE_ALREADY_EXISTS");

    const forced = await runCli(["remember", "overwritten body", "--name", "team/handbook", "--force"]);
    expect(forced.status).toBe(0);
    expect(fs.readFileSync(filePath, "utf8")).toContain("overwritten body");
  });
});

describe("akm import — nested --name", () => {
  test("writes knowledge to a nested subdirectory and returns a nested ref", async () => {
    const sourcePath = makeSourceFile("doc.md", "# Overview\n\nProject overview content.\n");
    const result = await runCli(["import", sourcePath, "--name", "projects/example/overview"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("knowledge:projects/example/overview");

    const expectedPath = path.join(currentStashDir, "knowledge", "projects", "example", "overview.md");
    expect(json.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(path.join(currentStashDir, "knowledge", "projects", "example"))).toBe(true);
  });

  test("rejects a '..' traversal name and writes nothing", async () => {
    const sourcePath = makeSourceFile("doc.md", "# Nope\n\nContent.\n");
    const result = await runCli(["import", sourcePath, "--name", "../escape"]);
    expect(result.status).toBe(2);

    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toMatch(/relative path/);
    expect(fs.existsSync(path.join(currentStashDir, "knowledge", "escape.md"))).toBe(false);
  });
});
