/**
 * Subdirectory asset creation via `--path` (issue #503).
 *
 * A created asset is placed inside a subdirectory of its type folder by passing
 * `--path` — a relative directory applied rooted at the type directory. The
 * filename still comes from `--name` (or the content/source slug):
 *   akm remember "buy milk" --path personal --name grocery-list
 *     → <stash>/memories/personal/grocery-list.md  (ref memory:personal/grocery-list)
 *   akm remember "buy milk" --path personal
 *     → <stash>/memories/personal/<slug>.md
 *   akm import doc.md --path projects/example --name overview
 *     → <stash>/knowledge/projects/example/overview.md
 *
 * `--name` is a FLAT name: a `/` in `--name` is rejected and points the user at
 * `--path`. `..`/`.` segments in either are rejected and write nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { assertFlatAssetName, normalizeCreateSubPath } from "../../../src/commands/read/knowledge";
import { runCliCapture } from "../../_helpers/cli";
import {
  type Cleanup,
  makeSandboxDir,
  type SandboxedDir,
  sandboxStashDir,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

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

describe("normalizeCreateSubPath — --path guards", () => {
  test("returns '' when unset or empty, strips surrounding slashes", () => {
    expect(normalizeCreateSubPath(undefined)).toBe("");
    expect(normalizeCreateSubPath("")).toBe("");
    expect(normalizeCreateSubPath("/personal/projects/")).toBe("personal/projects");
  });

  test("rejects '.'/'..' segments and absolute traversal", () => {
    expect(() => normalizeCreateSubPath("../escape")).toThrow(/relative directory/);
    expect(() => normalizeCreateSubPath("a/../../escape")).toThrow(/relative directory/);
    expect(() => normalizeCreateSubPath("a/./b")).toThrow(/relative directory/);
  });
});

describe("assertFlatAssetName — flat-name enforcement", () => {
  test("accepts a flat name or undefined", () => {
    expect(() => assertFlatAssetName("grocery-list")).not.toThrow();
    expect(() => assertFlatAssetName(undefined)).not.toThrow();
  });

  test("rejects a '/' in --name and points at --path", () => {
    expect(() => assertFlatAssetName("personal/grocery-list")).toThrow(/--path/);
  });
});

describe("akm remember — --path", () => {
  test("places the memory under --path with name from --name", async () => {
    const result = await runCli(["remember", "buy milk", "--path", "personal", "--name", "grocery-list"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("memories/personal/grocery-list");

    const expectedPath = path.join(currentStashDir, "memories", "personal", "grocery-list.md");
    expect(json.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.existsSync(path.join(currentStashDir, "memories", "personal"))).toBe(true);
  });

  test("places the memory under a multi-segment --path with an auto-slug name", async () => {
    const result = await runCli(["remember", "# Sprint retro\n\nNotes.", "--path", "team/projects"]);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ref: string; path: string };
    expect(json.ref).toMatch(/^memories\/team\/projects\//);
    expect(json.path.startsWith(path.join(currentStashDir, "memories", "team", "projects"))).toBe(true);
    expect(fs.existsSync(json.path)).toBe(true);
  });

  test("rejects a '/' in --name and writes nothing", async () => {
    const result = await runCli(["remember", "should not persist", "--name", "personal/grocery-list"]);
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toMatch(/--path/);
    expect(fs.existsSync(path.join(currentStashDir, "memories", "personal"))).toBe(false);
  });

  test("rejects a '..' traversal --path and writes nothing", async () => {
    const result = await runCli(["remember", "should not persist", "--path", "../escape", "--name", "x"]);
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toMatch(/relative directory/);
    expect(fs.existsSync(path.join(currentStashDir, "memories", "escape.md"))).toBe(false);
  });

  test("re-creating without --force errors; --force overwrites", async () => {
    const first = await runCli(["remember", "original body", "--path", "team", "--name", "handbook"]);
    expect(first.status).toBe(0);
    const filePath = path.join(currentStashDir, "memories", "team", "handbook.md");
    expect(fs.existsSync(filePath)).toBe(true);

    const dup = await runCli(["remember", "second body", "--path", "team", "--name", "handbook"]);
    expect(dup.status).not.toBe(0);
    expect(JSON.stringify(JSON.parse(dup.stderr))).toContain("RESOURCE_ALREADY_EXISTS");

    const forced = await runCli(["remember", "overwritten body", "--path", "team", "--name", "handbook", "--force"]);
    expect(forced.status).toBe(0);
    expect(fs.readFileSync(filePath, "utf8")).toContain("overwritten body");
  });
});

describe("akm import — --path", () => {
  test("places knowledge under --path with name from --name", async () => {
    const sourcePath = makeSourceFile("doc.md", "# Overview\n\nProject overview content.\n");
    const result = await runCli(["import", sourcePath, "--path", "projects/example", "--name", "overview"]);
    expect(result.status).toBe(0);

    const json = JSON.parse(result.stdout) as { ok: boolean; ref: string; path: string };
    expect(json.ok).toBe(true);
    expect(json.ref).toBe("knowledge/projects/example/overview");

    const expectedPath = path.join(currentStashDir, "knowledge", "projects", "example", "overview.md");
    expect(json.path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  test("rejects a '/' in --name and writes nothing", async () => {
    const sourcePath = makeSourceFile("doc.md", "# Nope\n\nContent.\n");
    const result = await runCli(["import", sourcePath, "--name", "projects/overview"]);
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stderr) as { error: string };
    expect(json.error).toMatch(/--path/);
  });
});

describe("akm workflow create — --path", () => {
  test("places the workflow under --path and returns a nested ref", async () => {
    const result = await runCli(["workflow", "create", "myflow", "--path", "release"]);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as { ref: string; path: string };
    expect(json.ref).toBe("workflows/release/myflow");
    expect(fs.existsSync(path.join(currentStashDir, "workflows", "release", "myflow.md"))).toBe(true);
  });

  test("rejects a '/' in the name positional and points at --path", async () => {
    const result = await runCli(["workflow", "create", "release/myflow"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatch(/--path/);
    expect(fs.existsSync(path.join(currentStashDir, "workflows", "release"))).toBe(false);
  });
});

describe("akm env create — --path", () => {
  test("places the env file under --path", async () => {
    const result = await runCli(["env", "create", "prod", "--path", "staging"]);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(currentStashDir, "env", "staging", "prod.env"))).toBe(true);
  });

  test("rejects a '/' in the env name and points at --path", async () => {
    const result = await runCli(["env", "create", "staging/prod"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatch(/--path/);
    expect(fs.existsSync(path.join(currentStashDir, "env", "staging"))).toBe(false);
  });
});

describe("akm secret set / akm propose — flat-name enforcement", () => {
  test("secret set rejects a '/' in the ref name and points at --path", async () => {
    const result = await runCli(["secret", "set", "team/deploy-key"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatch(/--path/);
    expect(fs.existsSync(path.join(currentStashDir, "secrets", "team"))).toBe(false);
  });

  test("propose rejects a '/' in the name positional before invoking any agent", async () => {
    const result = await runCli(["propose", "skill", "team/helper", "--task", "do a thing"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error).toMatch(/--path/);
  });
});
