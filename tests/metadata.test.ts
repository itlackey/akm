import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractDescriptionFromComments,
  extractPackageMetadata,
  extractTagsFromPath,
  fileNameToDescription,
  generateMetadata,
  loadStashFile,
  type StashFile,
  validateStashEntry,
  writeStashFile,
} from "../src/metadata";
// Renderers auto-register via ensureBuiltinsRegistered in file-context.ts

const createdTmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-meta-"));
  createdTmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ── loadStashFile ───────────────────────────────────────────────────────────

test("loadStashFile reads valid .stash.json", () => {
  const dir = tmpDir();
  const stash: StashFile = {
    entries: [
      {
        name: "docker-build",
        type: "tool",
        description: "build docker images",
        tags: ["docker", "build"],
        entry: "docker-build.ts",
      },
    ],
  };
  writeFile(path.join(dir, ".stash.json"), JSON.stringify(stash));

  const result = loadStashFile(dir);
  expect(result).not.toBeNull();
  expect(result!.entries).toHaveLength(1);
  expect(result!.entries[0].name).toBe("docker-build");
  expect(result!.entries[0].description).toBe("build docker images");
  expect(result!.entries[0].tags).toEqual(["docker", "build"]);
});

test("loadStashFile returns null for missing file", () => {
  const dir = tmpDir();
  expect(loadStashFile(dir)).toBeNull();
});

test("loadStashFile returns null for invalid JSON", () => {
  const dir = tmpDir();
  writeFile(path.join(dir, ".stash.json"), "not json");
  expect(loadStashFile(dir)).toBeNull();
});

test("loadStashFile returns null for missing entries array", () => {
  const dir = tmpDir();
  writeFile(path.join(dir, ".stash.json"), '{"foo": "bar"}');
  expect(loadStashFile(dir)).toBeNull();
});

test("loadStashFile parses intent field", () => {
  const dir = tmpDir();
  const stash: StashFile = {
    entries: [
      {
        name: "deploy",
        type: "tool",
        intent: { when: "user needs to deploy", input: "service name", output: "deployment status" },
        entry: "deploy.sh",
      },
    ],
  };
  writeFile(path.join(dir, ".stash.json"), JSON.stringify(stash));

  const result = loadStashFile(dir);
  expect(result!.entries[0].intent).toEqual({
    when: "user needs to deploy",
    input: "service name",
    output: "deployment status",
  });
});

// ── writeStashFile ──────────────────────────────────────────────────────────

test("writeStashFile persists .stash.json to disk", () => {
  const dir = tmpDir();
  const stash: StashFile = {
    entries: [{ name: "test", type: "tool", generated: true }],
  };
  writeStashFile(dir, stash);

  const raw = fs.readFileSync(path.join(dir, ".stash.json"), "utf8");
  const parsed = JSON.parse(raw);
  expect(parsed.entries[0].name).toBe("test");
  expect(parsed.entries[0].generated).toBe(true);
});

// ── validateStashEntry ──────────────────────────────────────────────────────

test("validateStashEntry rejects entries without name", () => {
  expect(validateStashEntry({ type: "tool" })).toBeNull();
});

test("validateStashEntry rejects entries without valid type", () => {
  expect(validateStashEntry({ name: "x", type: "invalid" })).toBeNull();
});

test("validateStashEntry accepts minimal valid entry", () => {
  const result = validateStashEntry({ name: "x", type: "tool" });
  expect(result).not.toBeNull();
  expect(result!.name).toBe("x");
  expect(result!.type).toBe("tool");
});

test("validateStashEntry parses quality, confidence, source, and aliases", () => {
  const result = validateStashEntry({
    name: "lint",
    type: "tool",
    quality: "curated",
    confidence: 2,
    source: "manual",
    aliases: ["Lint", "linters"],
  });

  expect(result).not.toBeNull();
  expect(result?.quality).toBe("curated");
  expect(result?.confidence).toBe(1);
  expect(result?.source).toBe("manual");
  expect(result?.aliases).toEqual(["lint", "linters", "linter"]);
});

// ── extractDescriptionFromComments ──────────────────────────────────────────

test("extractDescriptionFromComments parses JSDoc block comment", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tool.ts");
  writeFile(file, `/**\n * Generate docker compose stacks\n */\nconsole.log("hi")\n`);

  const desc = extractDescriptionFromComments(file);
  expect(desc).toBe("Generate docker compose stacks");
});

test("extractDescriptionFromComments parses hash comments after shebang", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tool.sh");
  writeFile(file, `#!/usr/bin/env bash\n# Deploy to production\n# Handles rollback\necho deploy\n`);

  const desc = extractDescriptionFromComments(file);
  expect(desc).toBe("Deploy to production Handles rollback");
});

test("extractDescriptionFromComments returns null for no comments", () => {
  const dir = tmpDir();
  const file = path.join(dir, "tool.ts");
  writeFile(file, `console.log("no comments")\n`);

  expect(extractDescriptionFromComments(file)).toBeNull();
});

// ── extractPackageMetadata ──────────────────────────────────────────────────

test("extractPackageMetadata reads package.json fields", () => {
  const dir = tmpDir();
  writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "my-tool", description: "A useful tool", keywords: ["deploy", "ci"] }),
  );

  const meta = extractPackageMetadata(dir);
  expect(meta).not.toBeNull();
  expect(meta!.name).toBe("my-tool");
  expect(meta!.description).toBe("A useful tool");
  expect(meta!.keywords).toEqual(["deploy", "ci"]);
});

test("extractPackageMetadata returns null when no package.json", () => {
  const dir = tmpDir();
  expect(extractPackageMetadata(dir)).toBeNull();
});

// ── fileNameToDescription ───────────────────────────────────────────────────

test("fileNameToDescription converts dashes and underscores to spaces", () => {
  expect(fileNameToDescription("docker-compose-generator")).toBe("docker compose generator");
  expect(fileNameToDescription("my_script_tool")).toBe("my script tool");
});

test("fileNameToDescription handles camelCase", () => {
  expect(fileNameToDescription("dockerBuild")).toBe("docker build");
});

// ── extractTagsFromPath ─────────────────────────────────────────────────────

test("extractTagsFromPath extracts tokens from path segments", () => {
  const root = "/stash/tools";
  const file = path.join(root, "docker", "compose-generator.ts");
  const tags = extractTagsFromPath(file, root);
  expect(tags).toContain("docker");
  expect(tags).toContain("compose");
  expect(tags).toContain("generator");
});

// ── generateMetadata ────────────────────────────────────────────────────────

test("generateMetadata creates entries from script files with filename heuristics", () => {
  const dir = tmpDir();
  const tool1 = path.join(dir, "summarize-diff.ts");
  writeFile(tool1, `console.log("summarize")\n`);

  const stash = generateMetadata(dir, "tool", [tool1]);
  expect(stash.entries).toHaveLength(1);
  expect(stash.entries[0].name).toBe("summarize-diff.ts");
  expect(stash.entries[0].type).toBe("tool");
  expect(stash.entries[0].description).toBe("summarize diff");
  expect(stash.entries[0].generated).toBe(true);
  expect(stash.entries[0].quality).toBe("generated");
  expect(stash.entries[0].source).toBe("filename");
  expect(stash.entries[0].confidence).toBe(0.55);
  expect(stash.entries[0].aliases).toContain("summarize diff");
  expect(stash.entries[0].entry).toBe("summarize-diff.ts");
});

test("generateMetadata extracts description from code comments", () => {
  const dir = tmpDir();
  const tool1 = path.join(dir, "deploy.sh");
  writeFile(tool1, `#!/usr/bin/env bash\n# Deploy services to production\necho deploy\n`);

  const stash = generateMetadata(dir, "tool", [tool1]);
  expect(stash.entries[0].description).toBe("Deploy services to production");
  expect(stash.entries[0].source).toBe("comments");
});

test("generateMetadata extracts metadata from package.json", () => {
  const dir = tmpDir();
  const tool1 = path.join(dir, "run.ts");
  writeFile(tool1, `console.log("run")\n`);
  writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ description: "Git diff summarizer", keywords: ["git", "diff"] }),
  );

  const stash = generateMetadata(dir, "tool", [tool1]);
  expect(stash.entries[0].description).toBe("Git diff summarizer");
  expect(stash.entries[0].source).toBe("package");
  expect(stash.entries[0].confidence).toBe(0.8);
  expect(stash.entries[0].tags).toEqual(["git", "diff"]);
});

test("generateMetadata skips non-tool extensions for tool type", () => {
  const dir = tmpDir();
  const mdFile = path.join(dir, "README.md");
  writeFile(mdFile, "# Readme\n");

  const stash = generateMetadata(dir, "tool", [mdFile]);
  expect(stash.entries).toHaveLength(0);
});

test("generateMetadata handles multi-tool directories", () => {
  const dir = tmpDir();
  const tool1 = path.join(dir, "docker-build.ts");
  const tool2 = path.join(dir, "docker-compose.ts");
  writeFile(tool1, `/**\n * Build docker images\n */\n`);
  writeFile(tool2, `/**\n * Generate docker compose stacks\n */\n`);

  const stash = generateMetadata(dir, "tool", [tool1, tool2]);
  expect(stash.entries).toHaveLength(2);
  expect(stash.entries[0].name).toBe("docker-build.ts");
  expect(stash.entries[0].description).toBe("Build docker images");
  expect(stash.entries[1].name).toBe("docker-compose.ts");
  expect(stash.entries[1].description).toBe("Generate docker compose stacks");
});

// ── validateStashEntry with intents ─────────────────────────────────────────

test("validateStashEntry accepts entries with intents array", () => {
  const result = validateStashEntry({
    name: "test",
    type: "tool",
    intents: ["summarize commits", "explain changes"],
  });
  expect(result).not.toBeNull();
  expect(result!.intents).toEqual(["summarize commits", "explain changes"]);
});

test("validateStashEntry filters non-string elements from intents", () => {
  const result = validateStashEntry({
    name: "test",
    type: "tool",
    intents: ["valid", 42, "", "also valid", null],
  });
  expect(result).not.toBeNull();
  expect(result!.intents).toEqual(["valid", "also valid"]);
});

test("validateStashEntry omits intents if all filtered out", () => {
  const result = validateStashEntry({
    name: "test",
    type: "tool",
    intents: ["", "  "],
  });
  expect(result).not.toBeNull();
  expect(result!.intents).toBeUndefined();
});

test("validateStashEntry accepts usage as string", () => {
  const result = validateStashEntry({
    name: "test",
    type: "tool",
    usage: "Run after checking branch state",
  });
  expect(result).not.toBeNull();
  expect(result!.usage).toEqual(["Run after checking branch state"]);
});

test("validateStashEntry normalizes usage array", () => {
  const result = validateStashEntry({
    name: "test",
    type: "tool",
    usage: ["  First step  ", "", "Second step", 2, null],
  });
  expect(result).not.toBeNull();
  expect(result!.usage).toEqual(["First step", "Second step"]);
});

test("loadStashFile parses usage field", () => {
  const dir = tmpDir();
  const stash: StashFile = {
    entries: [
      {
        name: "git-diff",
        type: "tool",
        usage: ["Run after fetching main", "Use --stat for quick output"],
        entry: "run.ts",
      },
    ],
  };
  writeFile(path.join(dir, ".stash.json"), JSON.stringify(stash));

  const result = loadStashFile(dir);
  expect(result!.entries[0].usage).toEqual(["Run after fetching main", "Use --stat for quick output"]);
});

test("loadStashFile parses intents field", () => {
  const dir = tmpDir();
  const stash: StashFile = {
    entries: [
      {
        name: "git-diff",
        type: "tool",
        intents: ["summarize git commits", "explain what changed"],
        entry: "run.ts",
      },
    ],
  };
  writeFile(path.join(dir, ".stash.json"), JSON.stringify(stash));

  const result = loadStashFile(dir);
  expect(result!.entries[0].intents).toEqual(["summarize git commits", "explain what changed"]);
});

// ── generateMetadata populates intents ──────────────────────────────────────

test("generateMetadata does not generate heuristic intents (LLM-only)", () => {
  const dir = tmpDir();
  const tool = path.join(dir, "summarize-diff.ts");
  writeFile(tool, `/**\n * Summarize git diff changes\n */\n`);

  const stash = generateMetadata(dir, "tool", [tool]);
  // Intents are only generated when LLM is configured, not heuristically
  expect(stash.entries[0].intents).toBeUndefined();
});
