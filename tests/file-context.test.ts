import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recognizeMatch } from "../src/core/adapter/adapters/akm-adapter";
import { applyFoldedMetadata, foldRecognizedMetadata } from "../src/core/adapter/adapters/akm-metadata";
import type { IndexDocument } from "../src/indexer/passes/metadata";
import { buildFileContext, buildRenderContext, getAllRenderers, getRenderer } from "../src/indexer/walk/file-context";
import { directoryMatcher, parentDirHintMatcher, smartMdMatcher } from "../src/indexer/walk/matchers";
import { walkStashFlat } from "../src/indexer/walk/walker";

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

  test("nested skill references are not classified by typed ancestor directories", () => {
    const root = tmpDir();
    const markdownPath = path.join(root, "skills", "cloudflare", "references", "workflows", "api.md");
    writeFile(markdownPath, "# Workflow API reference\nDocumentation only.\n");

    const markdown = buildFileContext(root, markdownPath);

    expect(directoryMatcher(markdown)).toBeNull();
    expect(parentDirHintMatcher(markdown)).toBeNull();
  });

  test("direct markdown files under skills remain skill assets", () => {
    const root = tmpDir();
    const filePath = path.join(root, "skills", "deploy.md");
    writeFile(filePath, "# Deploy\n");

    const result = parentDirHintMatcher(buildFileContext(root, filePath));

    expect(result?.type).toBe("skill");
    expect(result?.specificity).toBe(15);
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

  test("smartMdMatcher: a toolPolicy-only file is not an agent", () => {
    const root = tmpDir();
    const filePath = path.join(root, "misc", "legacy-policy.md");
    writeFile(filePath, ["---", "toolPolicy:", "  read: allow", "---", "You are an agent."].join("\n"));

    const ctx = buildFileContext(root, filePath);
    const result = smartMdMatcher(ctx);

    expect(result?.type).toBe("knowledge");
  });

  test("smartMdMatcher: tools (20) beats agent frontmatter command signal (18)", () => {
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

// ── 2b. task-yaml metadata fold ──────────────────────────────────────────────
//
// Regression test for the task-yaml defect: extraction must parse the PLAIN
// strict-v3 YAML document (no `---` fences) through the canonical source
// parser, not the frontmatter parser (which would silently return `{}`).
describe("task-yaml metadata fold", () => {
  test("populates schedule/workflow searchHints and task/scheduled tags from strict task source YAML", () => {
    const root = tmpDir();
    const filePath = path.join(root, "tasks", "nightly-report.yml");
    writeFile(filePath, ["version: 4", "uses: workflows/daily-backup", "schedule: '0 9 * * *'"].join("\n"));

    const ctx = buildFileContext(root, filePath);
    const entry: IndexDocument = { name: "nightly-report", type: "task" };
    applyFoldedMetadata(entry, foldRecognizedMetadata("task-yaml", ctx));

    expect(entry.tags).toContain("task");
    expect(entry.tags).toContain("scheduled");
    expect(entry.searchHints).toBeDefined();
    expect(entry.searchHints).toContain("schedule:0 9 * * *");
    expect(entry.searchHints).toContain("workflow:workflows/daily-backup");
  });

  test("projects a stored command target through the canonical v3 metadata shape", () => {
    const root = tmpDir();
    const filePath = path.join(root, "tasks", "review.yml");
    writeFile(
      filePath,
      ["version: 4", "uses: akm/command", "with:", "  ref: commands/review", "schedule: '@daily'"].join("\n"),
    );

    const ctx = buildFileContext(root, filePath);
    const entry: IndexDocument = { name: "review", type: "task" };
    applyFoldedMetadata(entry, foldRecognizedMetadata("task-yaml", ctx));

    expect(entry.searchHints).toContain("schedule:@daily");
    expect(entry.searchHints).toContain("prompt:commands/review");
  });

  test("records the asset a task targets as `uses` (#935); a run: or inline-command task targets none", () => {
    const root = tmpDir();
    const cases: Array<[string, string[], string[] | undefined]> = [
      [
        "workflow.yml",
        ["version: 4", "uses: workflows/daily-backup", "schedule: '@daily'"],
        ["workflows/daily-backup"],
      ],
      ["script.yml", ["version: 4", "uses: other//scripts/report", "schedule: '@daily'"], ["other//scripts/report"]],
      [
        "stored.yml",
        ["version: 4", "uses: akm/command", "with:", "  ref: commands/review", "schedule: '@daily'"],
        ["commands/review"],
      ],
      [
        "inline.yml",
        ["version: 4", "uses: akm/command", "with:", "  content: Summarize the day", "schedule: '@daily'"],
        undefined,
      ],
      ["run.yml", ["version: 4", "run: echo hi", "schedule: '@daily'"], undefined],
    ];
    for (const [file, lines, uses] of cases) {
      const filePath = path.join(root, "tasks", file);
      writeFile(filePath, lines.join("\n"));
      const entry: IndexDocument = { name: file, type: "task" };
      applyFoldedMetadata(entry, foldRecognizedMetadata("task-yaml", buildFileContext(root, filePath)));
      expect(entry.uses, file).toEqual(uses);
    }
  });

  test("still applies task/scheduled tags without throwing when the YAML is unparseable", () => {
    const root = tmpDir();
    const filePath = path.join(root, "tasks", "broken.yml");
    writeFile(filePath, "schedule: [unterminated\n");

    const ctx = buildFileContext(root, filePath);
    const entry: IndexDocument = { name: "broken", type: "task" };

    // The fold swallows the YAML parse error rather than throwing.
    expect(() => applyFoldedMetadata(entry, foldRecognizedMetadata("task-yaml", ctx))).not.toThrow();

    expect(entry.tags).toContain("task");
    expect(entry.tags).toContain("scheduled");
    expect(entry.searchHints ?? []).toEqual([]);
  });
});

// ── 2c. workflow metadata fold: step targets (#935) ─────────────────────────
describe("workflow-md metadata fold", () => {
  test("records each child workflow step's ref as `uses`, in step order, once each", () => {
    const root = tmpDir();
    const filePath = path.join(root, "workflows", "release.md");
    writeFile(
      filePath,
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: cut",
        "    unit: { workflow: workflows/cut-release }",
        "  - id: notify",
        "    unit: { workflow: other//workflows/notify }",
        "  - id: cut-again",
        "    unit: { workflow: workflows/cut-release }",
        "  - id: shell",
        "    unit: { exec: { command: [echo, done] } }",
        "---",
        "",
        "## cut",
        "",
        "Cut.",
        "",
        "## notify",
        "",
        "Notify.",
        "",
        "## cut-again",
        "",
        "Cut again.",
        "",
        "## shell",
        "",
        "Done.",
      ].join("\n"),
    );
    const entry: IndexDocument = { name: "release", type: "workflow" };
    applyFoldedMetadata(entry, foldRecognizedMetadata("workflow-md", buildFileContext(root, filePath)));
    expect(entry.uses).toEqual(["workflows/cut-release", "other//workflows/notify"]);
  });

  test("a Markdown workflow's prose steps target no asset", () => {
    const root = tmpDir();
    const filePath = path.join(root, "workflows", "review.md");
    writeFile(
      filePath,
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: read",
        "---",
        "",
        "# Review",
        "",
        "## read",
        "",
        "Read the diff.",
      ].join("\n"),
    );
    const entry: IndexDocument = { name: "review", type: "workflow" };
    applyFoldedMetadata(entry, foldRecognizedMetadata("workflow-md", buildFileContext(root, filePath)));
    expect(entry.searchHints).toContain("read");
    expect(entry.uses).toBeUndefined();
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

  test("getRenderer('knowledge-md') returns the whole document", async () => {
    const root = tmpDir();
    const filePath = path.join(root, "knowledge", "guide.md");
    const content = ["---", "title: Guide", "---", "# Introduction", "Welcome.", "", "## Setup", "Install."].join("\n");
    writeFile(filePath, content);

    const renderer = expectDefined(await getRenderer("knowledge-md"));
    const ctx = buildFileContext(root, filePath);
    const match = {
      type: "knowledge",
      specificity: 10,
      renderer: "knowledge-md",
      meta: { name: "guide.md" },
    };
    const renderCtx = buildRenderContext(ctx, match, [root]);
    const response = renderer.buildShowResponse(renderCtx);

    // Section selection is the ref's `#fragment`, applied by showLocal — the
    // renderer itself has no view modes to branch on.
    expect(response.content).toBe(content);
    expect(response.action).toContain("#fragment");
  });

  test("getAllRenderers() returns all 13 built-in renderers", async () => {
    const all = await getAllRenderers();
    expect(all).toHaveLength(13);

    const names = all.map((r) => r.name).sort();
    // `wiki-md` was removed in chunk 4 (the wiki asset-type is retired).
    // `workflow-program-yaml` is removed by workflow-format-unification
    // (spec §3): the YAML workflow *program* is deleted as a distinct
    // on-disk format — one workflow renderer (`workflow-md`) now.
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
      "workflow-md",
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
        "type: workflow",
        "description: Ship a release safely",
        "steps:",
        "  - id: validate",
        "---",
        "",
        "# Release Flow",
        "",
        "## validate",
        "",
        "Check inputs.",
      ].join("\n"),
    );

    const renderer = expectDefined(await getRenderer("workflow-md"));
    const ctx = buildFileContext(root, filePath);
    const match = { type: "workflow", specificity: 10, renderer: "workflow-md", meta: { name: "release flow" } };
    const renderCtx = buildRenderContext(ctx, match, [root], "npm:@scope/pkg");
    const response = renderer.buildShowResponse(renderCtx);

    expect(response.action).toContain("akm workflow run 'npm:@scope/pkg//workflows/release flow'");
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
    expect(results[0]!.relPath).toBe("scripts/deploy.sh");
  });

  test("skips node_modules directories", () => {
    const root = tmpDir();
    writeFile(path.join(root, "scripts", "deploy.sh"), "echo deploy\n");
    writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = {}");

    const results = walkStashFlat(root);
    expect(results.length).toBe(1);
    expect(results[0]!.relPath).toBe("scripts/deploy.sh");
  });

  test("skips .stash.json files", () => {
    const root = tmpDir();
    writeFile(path.join(root, "scripts", "deploy.sh"), "echo deploy\n");
    writeFile(path.join(root, "scripts", ".stash.json"), '{"entries":[]}');
    writeFile(path.join(root, ".stash.json"), '{"meta":true}');

    const results = walkStashFlat(root);
    expect(results.length).toBe(1);
    expect(results[0]!.relPath).toBe("scripts/deploy.sh");
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
