import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recognizeMatch } from "../../src/core/adapter/adapters/akm-adapter";
import type { StashEntry } from "../../src/indexer/passes/metadata";
import { applyMetadataContributors } from "../../src/indexer/passes/metadata-contributors";
import {
  buildFileContext,
  buildRenderContext,
  getAllRenderers,
  getRenderer,
} from "../../src/indexer/walk/file-context";
import { directoryMatcher, smartMdMatcher } from "../../src/indexer/walk/matchers";
import { walkStashFlat } from "../../src/indexer/walk/walker";

// ── Temp directory helpers ──────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined || value === null) {
    throw new Error("Expected value to be defined");
  }
  return value;
}

function tmpDir(prefix = "akm-fc-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 1. buildFileContext tests ───────────────────────────────────────────────

describe("buildFileContext", () => {
  test("computes path fields correctly for nested file", () => {
    const root = tmpDir();
    const realPath = path.join(root, "scripts", "azure", "deploy.sh");
    writeFile(realPath, "#!/bin/bash\necho deploy\n");

    const ctx = buildFileContext(root, realPath);

    expect(ctx.relPath).toBe("scripts/azure/deploy.sh");
    expect(ctx.ext).toBe(".sh");
    expect(ctx.fileName).toBe("deploy.sh");
    expect(ctx.parentDir).toBe("azure");
    expect(ctx.ancestorDirs).toEqual(["scripts", "azure"]);
    expect(ctx.stashRoot).toBe(root);
  });

  test("lazy content() reads file and caches result", () => {
    const root = tmpDir();
    const filePath = path.join(root, "test.txt");
    writeFile(filePath, "hello world");

    const ctx = buildFileContext(root, filePath);

    // First call reads the file
    const firstRead = ctx.content();
    expect(firstRead).toBe("hello world");

    // Modify the file on disk to verify caching
    fs.writeFileSync(filePath, "changed content");

    // Second call should return cached value
    const secondRead = ctx.content();
    expect(secondRead).toBe("hello world");
  });

  test("lazy frontmatter() returns parsed data for .md with frontmatter", () => {
    const root = tmpDir();
    const mdPath = path.join(root, "agents", "reviewer.md");
    writeFile(
      mdPath,
      ["---", "description: Code reviewer", "model: gpt-4", "---", "You are a code reviewer."].join("\n"),
    );

    const ctx = buildFileContext(root, mdPath);
    const fm = ctx.frontmatter();

    expect(fm).not.toBeNull();
    expect(fm?.description).toBe("Code reviewer");
    expect(fm?.model).toBe("gpt-4");
  });

  test("lazy frontmatter() returns null for .md without frontmatter", () => {
    const root = tmpDir();
    const mdPath = path.join(root, "knowledge", "guide.md");
    writeFile(mdPath, "# Just a heading\nSome content.");

    const ctx = buildFileContext(root, mdPath);
    expect(ctx.frontmatter()).toBeNull();
  });

  test("lazy frontmatter() returns null for non-.md files", () => {
    const root = tmpDir();
    const shPath = path.join(root, "scripts", "deploy.sh");
    writeFile(shPath, "#!/bin/bash\necho deploy\n");

    const ctx = buildFileContext(root, shPath);
    expect(ctx.frontmatter()).toBeNull();
  });

  test("lazy stat() returns fs.Stats", () => {
    const root = tmpDir();
    const filePath = path.join(root, "test.txt");
    writeFile(filePath, "hello world");

    const ctx = buildFileContext(root, filePath);
    const stat = ctx.stat();

    expect(stat).toBeDefined();
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(11);
  });

  test("handles file directly in stashRoot (no parent dirs)", () => {
    const root = tmpDir();
    const filePath = path.join(root, "README.md");
    writeFile(filePath, "# Root file");

    const ctx = buildFileContext(root, filePath);

    expect(ctx.relPath).toBe("README.md");
    expect(ctx.fileName).toBe("README.md");
    expect(ctx.ancestorDirs).toEqual([]);
  });

  test("handles deeply nested files", () => {
    const root = tmpDir();
    const filePath = path.join(root, "a", "b", "c", "d", "deep.ts");
    writeFile(filePath, "console.log('deep')\n");

    const ctx = buildFileContext(root, filePath);

    expect(ctx.relPath).toBe("a/b/c/d/deep.ts");
    expect(ctx.ext).toBe(".ts");
    expect(ctx.fileName).toBe("deep.ts");
    expect(ctx.parentDir).toBe("d");
    expect(ctx.ancestorDirs).toEqual(["a", "b", "c", "d"]);
  });
});

// ── 2. recognizeMatch tests ────────────────────────────────────────────────────

describe("recognizeMatch", () => {
  test("directoryMatcher matches .sh file under scripts/ as 'script'", () => {
    const root = tmpDir();
    const filePath = path.join(root, "scripts", "deploy.sh");
    writeFile(filePath, "#!/bin/bash\necho deploy\n");

    const ctx = buildFileContext(root, filePath);
    const result = directoryMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("script");
    expect(result?.specificity).toBe(10);
  });

  test("directoryMatcher matches SKILL.md under skills/ as 'skill'", () => {
    const root = tmpDir();
    const filePath = path.join(root, "skills", "review", "SKILL.md");
    writeFile(filePath, "# Review Skill");

    const ctx = buildFileContext(root, filePath);
    const result = directoryMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("skill");
    expect(result?.specificity).toBe(10);
  });

  test("directoryMatcher matches .md under commands/ as 'command'", () => {
    const root = tmpDir();
    const filePath = path.join(root, "commands", "deploy.md");
    writeFile(filePath, "---\ndescription: Deploy\n---\nDeploy it.");

    const ctx = buildFileContext(root, filePath);
    const result = directoryMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("command");
  });

  test("directoryMatcher matches .md under agents/ as 'agent'", () => {
    const root = tmpDir();
    const filePath = path.join(root, "agents", "reviewer.md");
    writeFile(filePath, "You are a code reviewer.");

    const ctx = buildFileContext(root, filePath);
    const result = directoryMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("agent");
  });

  test("directoryMatcher matches .md under nested agents/ path as 'agent'", () => {
    const root = tmpDir();
    const filePath = path.join(root, "agent-stash", "agents", "blog", "topic-discovery.md");
    writeFile(filePath, "You are a topic discovery agent.");

    const ctx = buildFileContext(root, filePath);
    const result = directoryMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("agent");
    expect(result?.specificity).toBe(10);
    expect(result?.renderer).toBe("agent-md");
  });

  test("directoryMatcher matches .md under knowledge/ as 'knowledge'", () => {
    const root = tmpDir();
    const filePath = path.join(root, "knowledge", "guide.md");
    writeFile(filePath, "# Guide\nSome knowledge.");

    const ctx = buildFileContext(root, filePath);
    const result = directoryMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("knowledge");
  });

  test("directoryMatcher matches .py under scripts/ as 'script'", () => {
    const root = tmpDir();
    const filePath = path.join(root, "scripts", "analyze.py");
    writeFile(filePath, "print('hello')");

    const ctx = buildFileContext(root, filePath);
    const result = directoryMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("script");
  });

  test("directoryMatcher matches .yml under tasks/ as 'task' (tasks migrated .md -> .yml in 0.8.0)", () => {
    const root = tmpDir();
    const filePath = path.join(root, "tasks", "nightly-report.yml");
    writeFile(filePath, ['schedule: "@daily"', "enabled: false", 'prompt: "Say hello"'].join("\n"));

    const ctx = buildFileContext(root, filePath);
    const result = directoryMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("task");
    expect(result?.specificity).toBe(10);
    expect(result?.renderer).toBe("task-yaml");
  });

  test("smartMdMatcher matches .md with 'model' frontmatter as 'agent' at specificity 8 (weak signal)", () => {
    const root = tmpDir();
    const filePath = path.join(root, "misc", "assistant.md");
    writeFile(filePath, ["---", "model: gpt-4", "---", "You are an assistant."].join("\n"));

    const ctx = buildFileContext(root, filePath);
    const result = smartMdMatcher(ctx);

    // model alone is a weak agent signal -- commands also use model
    expect(result).not.toBeNull();
    expect(result?.type).toBe("agent");
    expect(result?.specificity).toBe(8);
  });

  test("smartMdMatcher matches .md with 'tools' frontmatter as 'agent'", () => {
    const root = tmpDir();
    const filePath = path.join(root, "misc", "builder.md");
    writeFile(filePath, ["---", "tools:", "  read: allow", "---", "You are a builder."].join("\n"));

    const ctx = buildFileContext(root, filePath);
    const result = smartMdMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("agent");
    expect(result?.specificity).toBe(20);
  });

  test("smartMdMatcher classifies .md without agent/command signals as knowledge", () => {
    const root = tmpDir();
    const filePath = path.join(root, "misc", "deploy.md");
    writeFile(filePath, ["---", "description: Deploy to prod", "---", "Run deploy."].join("\n"));

    const ctx = buildFileContext(root, filePath);
    const result = smartMdMatcher(ctx);

    // No agent or command signals; falls back to knowledge
    expect(result).not.toBeNull();
    expect(result?.type).toBe("knowledge");
    expect(result?.specificity).toBe(5);
  });

  test("smartMdMatcher detects 'agent' frontmatter as command signal at specificity 18", () => {
    const root = tmpDir();
    const filePath = path.join(root, "misc", "build.md");
    writeFile(
      filePath,
      ["---", "agent: build", "description: Build the project", "---", "Build $ARGUMENTS."].join("\n"),
    );

    const ctx = buildFileContext(root, filePath);
    const result = smartMdMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("command");
    expect(result?.specificity).toBe(18);
    expect(result?.renderer).toBe("command-md");
  });

  test("smartMdMatcher detects $ARGUMENTS placeholder as command signal at specificity 18", () => {
    const root = tmpDir();
    const filePath = path.join(root, "misc", "deploy.md");
    writeFile(filePath, "Deploy $ARGUMENTS to production.");

    const ctx = buildFileContext(root, filePath);
    const result = smartMdMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("command");
    expect(result?.specificity).toBe(18);
  });

  test("smartMdMatcher detects $1/$2/$3 placeholders as command signal", () => {
    const root = tmpDir();
    const filePath = path.join(root, "misc", "greet.md");
    writeFile(filePath, "Hello $1, welcome to $2.");

    const ctx = buildFileContext(root, filePath);
    const result = smartMdMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("command");
    expect(result?.specificity).toBe(18);
  });

  test("smartMdMatcher: tools/toolPolicy (20) beats agent frontmatter command signal (18)", () => {
    const root = tmpDir();
    const filePath = path.join(root, "misc", "hybrid.md");
    writeFile(filePath, ["---", "tools:", "  read: allow", "agent: build", "---", "You are a hybrid."].join("\n"));

    const ctx = buildFileContext(root, filePath);
    const result = smartMdMatcher(ctx);

    // tools is agent-exclusive at 20, wins over agent dispatch at 18
    expect(result?.type).toBe("agent");
    expect(result?.specificity).toBe(20);
  });

  test("smartMdMatcher: agent frontmatter (18) beats model-only (8)", () => {
    const root = tmpDir();
    const filePath = path.join(root, "misc", "deploy.md");
    writeFile(filePath, ["---", "model: gpt-4", "agent: build", "---", "Deploy things."].join("\n"));

    const ctx = buildFileContext(root, filePath);
    const result = smartMdMatcher(ctx);

    // agent frontmatter is a command signal at 18
    expect(result?.type).toBe("command");
    expect(result?.specificity).toBe(18);
  });

  test("smartMdMatcher falls back to 'knowledge' at specificity 5 for plain .md", () => {
    const root = tmpDir();
    const filePath = path.join(root, "misc", "guide.md");
    writeFile(filePath, "# Guide\nJust a plain markdown document.");

    const ctx = buildFileContext(root, filePath);
    const result = smartMdMatcher(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("knowledge");
    expect(result?.specificity).toBe(5);
  });

  test("smartMdMatcher returns null for non-.md files", () => {
    const root = tmpDir();
    const filePath = path.join(root, "scripts", "deploy.sh");
    writeFile(filePath, "#!/bin/bash\necho deploy\n");

    const ctx = buildFileContext(root, filePath);
    expect(smartMdMatcher(ctx)).toBeNull();
  });

  test("specificity ordering: strong agent signal (tools) beats directoryMatcher", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "commands", "hybrid.md");
    writeFile(filePath, ["---", "tools:", "  read: allow", "---", "Agent in commands dir."].join("\n"));

    const ctx = buildFileContext(root, filePath);

    // directoryMatcher says "command" at specificity 10
    const dirResult = directoryMatcher(ctx);
    expect(dirResult?.type).toBe("command");
    expect(dirResult?.specificity).toBe(10);

    // smartMdMatcher says "agent" at specificity 20 (tools is a strong signal)
    const smartResult = smartMdMatcher(ctx);
    expect(smartResult?.type).toBe("agent");
    expect(smartResult?.specificity).toBe(20);

    // recognizeMatch should pick the higher specificity
    const best = recognizeMatch(ctx);
    expect(best).not.toBeNull();
    expect(best?.type).toBe("agent");
    expect(best?.specificity).toBe(20);
  });

  test("specificity ordering: directoryMatcher(10) beats smartMdMatcher(5) for plain .md", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "knowledge", "reference.md");
    writeFile(filePath, "# Reference\nPlain knowledge document.");

    const ctx = buildFileContext(root, filePath);

    // directoryMatcher says "knowledge" at specificity 10
    expect(directoryMatcher(ctx)?.specificity).toBe(10);
    // smartMdMatcher says "knowledge" at specificity 5
    expect(smartMdMatcher(ctx)?.specificity).toBe(5);

    // recognizeMatch should pick specificity 10
    const best = recognizeMatch(ctx);
    expect(best?.specificity).toBeGreaterThanOrEqual(10);
  });

  test("recognizeMatch returns null for unmatched file types", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "data", "config.json");
    writeFile(filePath, '{"key": "value"}');

    const ctx = buildFileContext(root, filePath);
    const result = recognizeMatch(ctx);
    expect(result).toBeNull();
  });

  // Regression test for the task-matcher defect (chunk-0b, WI-0b.1): the
  // "tasks" DIR_TYPE_MAP rule in matchers.ts tested `ext === ".md"`, a
  // leftover from before tasks migrated to `.yml` in 0.8.0 (commit
  // 031c659f updated every other consumer — asset-spec, asset-registry,
  // renderers, task-linter — but missed this matcher). As a result
  // tasks/*.yml never recognized: recognizeMatch() returned null for every
  // task file, `akm show task:<name>` threw "unrecognized layout", the
  // flat indexer silently dropped tasks (never indexed/searchable), and
  // the task-yaml metadata contributor was dead code. This test must FAIL
  // if the "tasks" rule regresses back to `.md`.
  test("recognizeMatch recognizes tasks/<name>.yml as type 'task' with renderer 'task-yaml'", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "tasks", "nightly-report.yml");
    writeFile(filePath, ['schedule: "@daily"', "enabled: false", 'prompt: "Say hello"'].join("\n"));

    const ctx = buildFileContext(root, filePath);
    const result = recognizeMatch(ctx);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("task");
    expect(result?.renderer).toBe("task-yaml");
  });
});

// ── 2b. task-yaml metadata contributor ──────────────────────────────────────
//
// Regression test for the applyTaskMetadata() defect: it called
// applyFrontmatterDescriptionAndTags(), which parses `---`-fenced frontmatter
// via parseFrontmatter(). Real task assets (src/tasks/schema.ts TaskDocument)
// are PLAIN YAML documents with no `---` fences, so that parse silently
// returned `{}` and the schedule/workflow/prompt searchHints never populated
// -- only the static "task"/"scheduled" tags were ever emitted. This test
// must FAIL (searchHints missing schedule:/workflow:/prompt: entries) if the
// contributor regresses back to the frontmatter parser.
describe("task-yaml metadata contributor", () => {
  const TASK_MATCH = { type: "task", specificity: 10, renderer: "task-yaml" };

  test("populates schedule/workflow/prompt searchHints and task/scheduled tags from plain YAML", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "tasks", "nightly-report.yml");
    writeFile(
      filePath,
      ["schedule: '0 9 * * *'", "enabled: true", "workflow: workflow:daily-backup", "prompt: agent:my-agent"].join(
        "\n",
      ),
    );

    const ctx = buildFileContext(root, filePath);
    const renderCtx = buildRenderContext(ctx, TASK_MATCH, [root]);
    const entry: StashEntry = { name: "nightly-report", type: "task" };
    await applyMetadataContributors(entry, { rendererName: "task-yaml", renderContext: renderCtx });

    expect(entry.tags).toContain("task");
    expect(entry.tags).toContain("scheduled");
    expect(entry.searchHints).toBeDefined();
    expect(entry.searchHints).toContain("schedule:0 9 * * *");
    expect(entry.searchHints).toContain("workflow:workflow:daily-backup");
    expect(entry.searchHints).toContain("prompt:agent:my-agent");
  });

  test("still applies task/scheduled tags without throwing when the YAML is unparseable", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "tasks", "broken.yml");
    writeFile(filePath, "schedule: [unterminated\n");

    const ctx = buildFileContext(root, filePath);
    const renderCtx = buildRenderContext(ctx, TASK_MATCH, [root]);
    const entry: StashEntry = { name: "broken", type: "task" };

    await expect(
      applyMetadataContributors(entry, { rendererName: "task-yaml", renderContext: renderCtx }),
    ).resolves.toBeUndefined();

    expect(entry.tags).toContain("task");
    expect(entry.tags).toContain("scheduled");
    expect(entry.searchHints ?? []).toEqual([]);
  });
});

// ── 3. Renderer tests ───────────────────────────────────────────────────────

describe("Renderer", () => {
  test("getRenderer('script-source') returns the script renderer", async () => {
    const renderer = await getRenderer("script-source");
    expect(renderer).toBeDefined();
    expect(renderer?.name).toBe("script-source");
  });

  test("getRenderer('agent-md') builds show response with prompt prefix", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "agents", "reviewer.md");
    writeFile(
      filePath,
      ["---", "description: Code reviewer", "model: gpt-4", "---", "You are a code reviewer."].join("\n"),
    );

    const renderer = expectDefined(await getRenderer("agent-md"));
    const ctx = buildFileContext(root, filePath);
    const match = { type: "agent", specificity: 20, renderer: "agent-md", meta: { name: "reviewer.md" } };
    const renderCtx = buildRenderContext(ctx, match, [root]);
    const response = renderer.buildShowResponse(renderCtx);

    expect(response.type).toBe("agent");
    expect(response.action).toContain("verbatim");
    expect(response.prompt).toBeDefined();
    expect(response.prompt).toContain("You are a code reviewer.");
    expect(response.description).toBe("Code reviewer");
    expect(response.modelHint).toBe("gpt-4");
  });

  test("getRenderer('command-md') extracts template from body", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "commands", "deploy.md");
    writeFile(
      filePath,
      ["---", "description: Deploy to production", "---", "Run the deploy script with {{env}}."].join("\n"),
    );

    const renderer = expectDefined(await getRenderer("command-md"));
    const ctx = buildFileContext(root, filePath);
    const match = { type: "command", specificity: 10, renderer: "command-md", meta: { name: "deploy.md" } };
    const renderCtx = buildRenderContext(ctx, match, [root]);
    const response = renderer.buildShowResponse(renderCtx);

    expect(response.type).toBe("command");
    expect(response.template).toBe("Run the deploy script with {{env}}.");
    expect(response.description).toBe("Deploy to production");
  });

  test("getRenderer('knowledge-md') handles toc view", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "knowledge", "guide.md");
    writeFile(
      filePath,
      [
        "---",
        "title: Guide",
        "---",
        "# Introduction",
        "Welcome.",
        "",
        "## Setup",
        "Install.",
        "",
        "## Usage",
        "Use.",
      ].join("\n"),
    );

    const renderer = expectDefined(await getRenderer("knowledge-md"));
    const ctx = buildFileContext(root, filePath);
    const match = {
      type: "knowledge",
      specificity: 10,
      renderer: "knowledge-md",
      meta: { name: "guide.md", view: { mode: "toc" as const } },
    };
    const renderCtx = buildRenderContext(ctx, match, [root]);
    const response = renderer.buildShowResponse(renderCtx);

    expect(response.content).toContain("Introduction");
    expect(response.content).toContain("Setup");
    expect(response.content).toContain("Usage");
  });

  test("getRenderer('knowledge-md') handles section view", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "knowledge", "guide.md");
    writeFile(
      filePath,
      ["# Intro", "Welcome.", "", "## Setup", "Install things.", "", "## Usage", "Use things."].join("\n"),
    );

    const renderer = expectDefined(await getRenderer("knowledge-md"));
    const ctx = buildFileContext(root, filePath);
    const match = {
      type: "knowledge",
      specificity: 10,
      renderer: "knowledge-md",
      meta: { name: "guide.md", view: { mode: "section" as const, heading: "Setup" } },
    };
    const renderCtx = buildRenderContext(ctx, match, [root]);
    const response = renderer.buildShowResponse(renderCtx);

    expect(response.content).toContain("## Setup");
    expect(response.content).toContain("Install things.");
  });

  test("getRenderer('knowledge-md') handles lines view", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "knowledge", "guide.md");
    writeFile(filePath, ["# Intro", "Welcome.", "", "## Setup", "Install things."].join("\n"));

    const renderer = expectDefined(await getRenderer("knowledge-md"));
    const ctx = buildFileContext(root, filePath);
    const match = {
      type: "knowledge",
      specificity: 10,
      renderer: "knowledge-md",
      meta: { name: "guide.md", view: { mode: "lines" as const, start: 1, end: 2 } },
    };
    const renderCtx = buildRenderContext(ctx, match, [root]);
    const response = renderer.buildShowResponse(renderCtx);

    expect(response.content).toContain("Intro");
    expect(response.content).toContain("Welcome");
    expect(response.content).not.toContain("Setup");
  });

  test("getAllRenderers() returns all 15 built-in renderers", async () => {
    const all = await getAllRenderers();
    expect(all).toHaveLength(15);

    const names = all.map((r) => r.name).sort();
    expect(names).toEqual([
      "agent-md",
      "command-md",
      "env-file",
      "fact-md",
      "knowledge-md",
      "lesson-md",
      "memory-md",
      "script-source",
      "secret-file",
      "session-md", // #561
      "skill-md",
      "task-yaml",
      "wiki-md",
      "workflow-md",
      "workflow-program-yaml", // redesign addendum R1
    ]);
  });

  test("getRenderer returns undefined for unknown renderer name", async () => {
    expect(await getRenderer("nonexistent")).toBeUndefined();
  });

  test("workflow renderer builds origin-aware shell-quoted action text", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "workflows", "release flow.md");
    writeFile(
      filePath,
      [
        "---",
        "description: Ship a release safely",
        "---",
        "# Workflow: Release Flow",
        "",
        "## Step: Validate",
        "Step ID: validate",
        "",
        "### Instructions",
        "Check inputs.",
      ].join("\n"),
    );

    const renderer = expectDefined(await getRenderer("workflow-md"));
    const ctx = buildFileContext(root, filePath);
    const match = { type: "workflow", specificity: 10, renderer: "workflow-md", meta: { name: "release flow" } };
    const renderCtx = buildRenderContext(ctx, match, [root], "npm:@scope/pkg");
    const response = renderer.buildShowResponse(renderCtx);

    expect(response.action).toContain("akm workflow next 'npm:@scope/pkg//workflow:release flow'");
  });
});

// ── 4. walkStashFlat tests ──────────────────────────────────────────────────

describe("walkStashFlat", () => {
  test("returns empty array for non-existent directory", () => {
    expect(walkStashFlat("/nonexistent/path")).toEqual([]);
  });

  test("returns empty array for empty directory", () => {
    const root = tmpDir();
    expect(walkStashFlat(root)).toEqual([]);
  });

  test("finds files across nested directories", () => {
    const root = tmpDir();
    writeFile(path.join(root, "scripts", "deploy.sh"), "echo deploy\n");
    writeFile(path.join(root, "agents", "reviewer.md"), "You are a reviewer.");
    writeFile(path.join(root, "knowledge", "guide.md"), "# Guide");
    writeFile(path.join(root, "scripts", "deep", "nested", "analyze.py"), "print('hi')");

    const results = walkStashFlat(root);
    expect(results.length).toBe(4);

    const relPaths = results.map((ctx) => ctx.relPath).sort();
    expect(relPaths).toContain("scripts/deploy.sh");
    expect(relPaths).toContain("agents/reviewer.md");
    expect(relPaths).toContain("knowledge/guide.md");
    expect(relPaths).toContain("scripts/deep/nested/analyze.py");
  });

  test("skips .git directories", () => {
    const root = tmpDir();
    writeFile(path.join(root, "scripts", "deploy.sh"), "echo deploy\n");
    writeFile(path.join(root, ".git", "config"), "[core]\n");

    const results = walkStashFlat(root);
    expect(results.length).toBe(1);
    expect(results[0].relPath).toBe("scripts/deploy.sh");
  });

  test("skips node_modules directories", () => {
    const root = tmpDir();
    writeFile(path.join(root, "scripts", "deploy.sh"), "echo deploy\n");
    writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = {}");

    const results = walkStashFlat(root);
    expect(results.length).toBe(1);
    expect(results[0].relPath).toBe("scripts/deploy.sh");
  });

  test("skips .stash.json files", () => {
    const root = tmpDir();
    writeFile(path.join(root, "scripts", "deploy.sh"), "echo deploy\n");
    writeFile(path.join(root, "scripts", ".stash.json"), '{"entries":[]}');
    writeFile(path.join(root, ".stash.json"), '{"meta":true}');

    const results = walkStashFlat(root);
    expect(results.length).toBe(1);
    expect(results[0].relPath).toBe("scripts/deploy.sh");
  });

  test("each returned item is a valid FileContext with correct fields", () => {
    const root = tmpDir();
    writeFile(path.join(root, "scripts", "azure", "deploy.sh"), "#!/bin/bash\necho deploy\n");
    writeFile(path.join(root, "agents", "reviewer.md"), "You are a reviewer.");

    const results = walkStashFlat(root);
    expect(results.length).toBe(2);

    for (const ctx of results) {
      expect(typeof ctx.absPath).toBe("string");
      expect(path.isAbsolute(ctx.absPath)).toBe(true);
      expect(typeof ctx.relPath).toBe("string");
      expect(typeof ctx.ext).toBe("string");
      expect(typeof ctx.fileName).toBe("string");
      expect(ctx.stashRoot).toBe(root);
      expect(Array.isArray(ctx.ancestorDirs)).toBe(true);
      expect(typeof ctx.content).toBe("function");
      expect(typeof ctx.frontmatter).toBe("function");
      expect(typeof ctx.stat).toBe("function");
    }

    const deployCtx = results.find((ctx) => ctx.fileName === "deploy.sh");
    expect(deployCtx).toBeDefined();
    expect(deployCtx?.relPath).toBe("scripts/azure/deploy.sh");
    expect(deployCtx?.ext).toBe(".sh");
    expect(deployCtx?.parentDir).toBe("azure");
    expect(deployCtx?.ancestorDirs).toEqual(["scripts", "azure"]);
    expect(deployCtx?.content()).toBe("#!/bin/bash\necho deploy\n");
  });

  test("handles multiple files in the same directory", () => {
    const root = tmpDir();
    writeFile(path.join(root, "scripts", "build.sh"), "echo build\n");
    writeFile(path.join(root, "scripts", "test.sh"), "echo test\n");
    writeFile(path.join(root, "scripts", "deploy.sh"), "echo deploy\n");

    const results = walkStashFlat(root);
    expect(results.length).toBe(3);

    const fileNames = results.map((ctx) => ctx.fileName).sort();
    expect(fileNames).toEqual(["build.sh", "deploy.sh", "test.sh"]);
  });
});
