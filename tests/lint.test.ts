import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmLint } from "../src/commands/lint/index";
import { runCliCapture } from "./_helpers/cli";
import { withEnv } from "./_helpers/sandbox";

// ── Temp dir management ──────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempStash(prefix = "akm-lint-stash-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

function writeFile(stashDir: string, subdir: string, name: string, content: string): string {
  const dir = path.join(stashDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function _buildFrontmatter(fields: Record<string, string | boolean | number>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: ${String(v)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

// ── Detection tests ───────────────────────────────────────────────────────────

describe("akmLint detection", () => {
  test("unquoted-colon: flags description with unquoted colon", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "skills",
      "foo.md",
      `---\nname: foo\ntype: skill\ndescription: Does X: and Y\n---\n\nBody content here.\n`,
    );

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "unquoted-colon");
    expect(issue).toBeDefined();
    expect(issue?.file).toContain("foo.md");
    expect(issue?.fixed).toBe(false);
  });

  test("unquoted-colon: does NOT flag quoted description", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "skills",
      "bar.md",
      `---\nname: bar\ntype: skill\ndescription: "Does X: and Y"\n---\n\nBody content here.\n`,
    );

    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "unquoted-colon")).toHaveLength(0);
  });

  test("missing-updated: flags file with no updated field", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "knowledge",
      "note.md",
      `---\nname: note\ntype: knowledge\ndescription: A note\n---\n\nSome content.\n`,
    );

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "missing-updated");
    expect(issue).toBeDefined();
    expect(issue?.fixed).toBe(false);
  });

  test("missing-updated: does NOT flag file that already has updated field", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "knowledge",
      "note.md",
      `---\nname: note\ntype: knowledge\nupdated: 2025-01-01\n---\n\nSome content.\n`,
    );

    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "missing-updated")).toHaveLength(0);
  });

  test("orphaned-stub: flags inferenceProcessed stub with short body and no derived sibling", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "memories",
      "stub.md",
      `---\nname: stub\ntype: memory\ninferenceProcessed: true\n---\n\nShort.\n`,
    );

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "orphaned-stub");
    expect(issue).toBeDefined();
    expect(issue?.fixed).toBe(false);
  });

  test("orphaned-stub: does NOT flag when derived sibling exists", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "memories",
      "stub.md",
      `---\nname: stub\ntype: memory\ninferenceProcessed: true\n---\n\nShort.\n`,
    );
    // Create the derived sibling
    writeFile(stashDir, "memories", "stub.derived.md", `---\nname: stub.derived\ntype: memory\n---\n\nDerived.\n`);

    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "orphaned-stub")).toHaveLength(0);
  });

  test("orphaned-stub: does NOT flag when body is >= 100 chars", () => {
    const stashDir = makeTempStash();
    const longBody = "x".repeat(100);
    writeFile(
      stashDir,
      "memories",
      "stub.md",
      `---\nname: stub\ntype: memory\ninferenceProcessed: true\n---\n\n${longBody}\n`,
    );

    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "orphaned-stub")).toHaveLength(0);
  });

  test("placeholder-stub: flags file with placeholder text", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "workflows",
      "wf.md",
      `---\nname: wf\ntype: workflow\n---\n\nDescribe what this workflow accomplishes\n`,
    );

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "placeholder-stub");
    expect(issue).toBeDefined();
    expect(issue?.fixed).toBe(false);
  });

  test("placeholder-stub: flags file with 'Example Workflow' text", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "workflows",
      "wf2.md",
      `---\nname: wf2\ntype: workflow\n---\n\n# Example Workflow\n\nSome description.\n`,
    );

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "placeholder-stub");
    expect(issue).toBeDefined();
  });

  test("missing-name-or-type: flags file missing both name and type", () => {
    const stashDir = makeTempStash();
    writeFile(stashDir, "agents", "no-meta.md", `---\ndescription: An agent\n---\n\nBody content here.\n`);

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "missing-name-or-type");
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain("name");
    expect(issue?.detail).toContain("type");
    // suggested slug should be derived from filename
    expect(issue?.detail).toContain("no-meta");
    expect(issue?.fixed).toBe(false);
  });

  test("missing-name-or-type: flags file missing only type", () => {
    const stashDir = makeTempStash();
    writeFile(stashDir, "agents", "no-type.md", `---\nname: no-type\ndescription: something\n---\n\nBody.\n`);

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "missing-name-or-type");
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain("type");
    expect(issue?.detail).not.toContain("name");
  });

  test("missing-name-or-type: does NOT flag file with no frontmatter", () => {
    const stashDir = makeTempStash();
    writeFile(stashDir, "agents", "plain.md", `# Just a plain document\n\nNo frontmatter here.\n`);

    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "missing-name-or-type")).toHaveLength(0);
  });

  test("stale-path: flags body containing nonexistent /home/ path", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "knowledge",
      "paths.md",
      `---\nname: paths\ntype: knowledge\n---\n\nSee /home/nonexistent_user_xyz/file.txt for details.\n`,
    );

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "stale-path");
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain("/home/nonexistent_user_xyz/file.txt");
    expect(issue?.fixed).toBe(false);
  });

  test("stale-path: does NOT flag existing /home/ paths", () => {
    const stashDir = makeTempStash();
    // Use the temp stash dir itself as an existing path in body
    writeFile(
      stashDir,
      "knowledge",
      "paths-ok.md",
      `---\nname: paths-ok\ntype: knowledge\n---\n\nSee ${stashDir} for details.\n`,
    );

    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "stale-path")).toHaveLength(0);
  });

  test("clean file produces no issues", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "skills",
      "clean.md",
      `---\nname: clean\ntype: skill\ndescription: "Does X and Y"\nupdated: 2025-01-01\n---\n\nThis skill does clean work without any placeholders.\n`,
    );

    const result = akmLint({ dir: stashDir });
    expect(result.ok).toBe(true);
    expect(result.flagged).toHaveLength(0);
    expect(result.summary.flagged).toBe(0);
  });
});

// ── Fix tests ─────────────────────────────────────────────────────────────────

describe("akmLint --fix", () => {
  test("fixes unquoted-colon by wrapping description in quotes", () => {
    const stashDir = makeTempStash();
    const filePath = writeFile(
      stashDir,
      "skills",
      "colon.md",
      `---\nname: colon\ntype: skill\ndescription: Does X: and Y\nupdated: 2025-01-01\n---\n\nBody content.\n`,
    );

    const result = akmLint({ dir: stashDir, fix: true });
    expect(result.fixed.find((i) => i.issue === "unquoted-colon")).toBeDefined();

    // Verify file mutation
    const updated = fs.readFileSync(filePath, "utf8");
    expect(updated).toContain('description: "Does X: and Y"');
  });

  test("fixes missing-updated by stamping file mtime", () => {
    const stashDir = makeTempStash();
    const filePath = writeFile(
      stashDir,
      "knowledge",
      "no-updated.md",
      `---\nname: no-updated\ntype: knowledge\ndescription: "Something"\n---\n\nBody content.\n`,
    );

    const mtime = fs.statSync(filePath).mtime;
    const expectedDate = `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, "0")}-${String(mtime.getDate()).padStart(2, "0")}`;

    const result = akmLint({ dir: stashDir, fix: true });
    expect(result.fixed.find((i) => i.issue === "missing-updated")).toBeDefined();

    const updated = fs.readFileSync(filePath, "utf8");
    expect(updated).toContain(`updated: ${expectedDate}`);
  });

  test("deletes orphaned stubs", () => {
    const stashDir = makeTempStash();
    const filePath = writeFile(
      stashDir,
      "memories",
      "orphan.md",
      `---\nname: orphan\ntype: memory\ninferenceProcessed: true\n---\n\nShort.\n`,
    );

    const result = akmLint({ dir: stashDir, fix: true });
    expect(result.fixed.find((i) => i.issue === "orphaned-stub")).toBeDefined();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("deletes placeholder stubs", () => {
    const stashDir = makeTempStash();
    const filePath = writeFile(
      stashDir,
      "workflows",
      "placeholder.md",
      `---\nname: placeholder\ntype: workflow\n---\n\nDescribe what this workflow accomplishes\n`,
    );

    const result = akmLint({ dir: stashDir, fix: true });
    expect(result.fixed.find((i) => i.issue === "placeholder-stub")).toBeDefined();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  test("does NOT fix missing-name-or-type (non-auto-fixable)", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "agents",
      "no-meta.md",
      `---\ndescription: An agent\nupdated: 2025-01-01\n---\n\nBody content here.\n`,
    );

    const result = akmLint({ dir: stashDir, fix: true });
    // Should still be in flagged, not fixed
    const issue = result.flagged.find((i) => i.issue === "missing-name-or-type");
    expect(issue).toBeDefined();
    expect(issue?.fixed).toBe(false);
  });

  test("does NOT fix stale-path (non-auto-fixable)", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "knowledge",
      "stale.md",
      `---\nname: stale\ntype: knowledge\nupdated: 2025-01-01\n---\n\nSee /home/ghost_user_xyz/file.txt\n`,
    );

    const result = akmLint({ dir: stashDir, fix: true });
    const issue = result.flagged.find((i) => i.issue === "stale-path");
    expect(issue).toBeDefined();
    expect(issue?.fixed).toBe(false);
  });
});

// ── SkillLinter tests ─────────────────────────────────────────────────────────

describe("SkillLinter", () => {
  test("missing-skill-md: flags a skill directory without SKILL.md", () => {
    const stashDir = makeTempStash();
    // Create a skill subdir with only a non-SKILL.md file
    const skillDir = path.join(stashDir, "skills", "my-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "README.md"),
      "---\nname: my-skill\ntype: skill\nupdated: 2025-01-01\n---\n\nContent.\n",
      "utf8",
    );

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "missing-skill-md");
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain("no SKILL.md in skills/my-skill");
    expect(issue?.fixed).toBe(false);
  });

  test("missing-skill-md: does NOT flag a skill directory that contains SKILL.md", () => {
    const stashDir = makeTempStash();
    const skillDir = path.join(stashDir, "skills", "good-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      '---\nname: good-skill\ntype: skill\ndescription: "A good skill"\nupdated: 2025-01-01\n---\n\nThis skill does useful work.\n',
      "utf8",
    );

    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "missing-skill-md")).toHaveLength(0);
  });
});

// ── TaskLinter tests ──────────────────────────────────────────────────────────

describe("TaskLinter", () => {
  test("passes when all required fields are present (prompt variant)", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "tasks",
      "full-task.yml",
      'schedule: "0 9 * * *"\nenabled: true\nprompt: Do something useful\n',
    );

    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "invalid-task-yaml")).toHaveLength(0);
  });

  test("passes when all required fields are present (workflow variant)", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "tasks",
      "workflow-task.yml",
      'schedule: "@daily"\nenabled: false\nworkflow: "workflow:daily-backup"\n',
    );

    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "invalid-task-yaml")).toHaveLength(0);
  });

  test("invalid-task-yaml: flags task missing schedule field", () => {
    const stashDir = makeTempStash();
    writeFile(stashDir, "tasks", "no-schedule.yml", "enabled: true\nprompt: Do something\n");

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "invalid-task-yaml");
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain("schedule");
    expect(issue?.fixed).toBe(false);
  });

  test("invalid-task-yaml: flags task missing enabled field", () => {
    const stashDir = makeTempStash();
    writeFile(stashDir, "tasks", "no-enabled.yml", 'schedule: "0 * * * *"\nprompt: Do something\n');

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "invalid-task-yaml");
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain("enabled");
    expect(issue?.fixed).toBe(false);
  });

  test("invalid-task-yaml: flags task with neither prompt nor workflow nor command", () => {
    const stashDir = makeTempStash();
    writeFile(stashDir, "tasks", "no-target.yml", 'schedule: "0 * * * *"\nenabled: true\n');

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "invalid-task-yaml");
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain("prompt, workflow, or command");
    expect(issue?.fixed).toBe(false);
  });
});

// ── stale-path in BaseLinter tests ───────────────────────────────────────────

describe("stale-path in base (non-knowledge assets)", () => {
  test("stale-path: flags nonexistent /home/ path in a memories/ asset", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "memories",
      "stale-mem.md",
      `---\nname: stale-mem\ntype: memory\nupdated: 2025-01-01\n---\n\nSee /home/nonexistent-path-xyz/data.txt for context.\n`,
    );

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "stale-path");
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain("/home/nonexistent-path-xyz/data.txt");
    expect(issue?.fixed).toBe(false);
  });
});

// ── missing-ref tests ─────────────────────────────────────────────────────────

describe("missing-ref check", () => {
  test("missing-ref: flags a ref to a workflow that does not exist", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "agents",
      "my-agent.md",
      "---\nname: my-agent\ntype: agent\nupdated: 2025-01-01\n---\n\nRun `workflow:does-not-exist` to do the thing.\n",
    );

    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "missing-ref");
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain("workflow:does-not-exist");
    expect(issue?.detail).toContain("workflows/does-not-exist.md");
    expect(issue?.fixed).toBe(false);
  });

  test("missing-ref: does NOT flag a ref when the target file exists", () => {
    const stashDir = makeTempStash();
    // Create the referenced workflow
    writeFile(
      stashDir,
      "workflows",
      "my-flow.md",
      "---\nname: my-flow\ntype: workflow\nupdated: 2025-01-01\n---\n\nWorkflow content.\n",
    );
    // Create the agent that references it
    writeFile(
      stashDir,
      "agents",
      "ref-agent.md",
      "---\nname: ref-agent\ntype: agent\nupdated: 2025-01-01\n---\n\nRun `workflow:my-flow` to do the thing.\n",
    );

    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "missing-ref")).toHaveLength(0);
  });

  test("missing-ref: does NOT flag remote refs (npm: origin prefix)", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "agents",
      "remote-agent.md",
      "---\nname: remote-agent\ntype: agent\nupdated: 2025-01-01\n---\n\nInstall npm:@scope/pkg//workflow:foo first.\n",
    );

    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "missing-ref")).toHaveLength(0);
  });

  test("missing-ref: outer-frontmatter `refs:` array suppresses body scan", () => {
    const stashDir = makeTempStash();
    // The referenced asset DOES exist, so a frontmatter-listed ref does
    // not produce a missing-ref flag — and the body's `memory:foo`
    // literal (which would normally be flagged) is silently ignored.
    writeFile(stashDir, "memories", "real-target.md", "---\nupdated: 2025-01-01\n---\nx\n");
    writeFile(
      stashDir,
      "memories",
      "captured.md",
      "---\nupdated: 2025-01-01\nrefs:\n  - memory:real-target\n---\n\n## Bash output\nThe heredoc contained literal memory:foo and knowledge:projects/akm/bar.\n",
    );
    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "missing-ref")).toHaveLength(0);
  });

  test("missing-ref: outer-frontmatter `refs:` flags entries that no longer resolve", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "memories",
      "captured.md",
      "---\nupdated: 2025-01-01\nrefs:\n  - memory:was-deleted\n---\n\nbody\n",
    );
    const result = akmLint({ dir: stashDir });
    const missing = result.flagged.filter((i) => i.issue === "missing-ref");
    expect(missing).toHaveLength(1);
    expect(missing[0].detail).toContain("memory:was-deleted");
  });

  test("missing-ref: inner-frontmatter `refs:` (session-checkpoint nesting) also suppresses body scan", () => {
    const stashDir = makeTempStash();
    writeFile(stashDir, "memories", "rollout-notes.md", "---\nupdated: 2025-01-01\n---\nx\n");
    // Session-checkpoint pattern: `akm remember` wraps the file in a
    // `---\n…\n---` block, and the hook's own `---\nakm_memory_kind:…\n---`
    // block is preserved at the top of the body.
    writeFile(
      stashDir,
      "memories",
      "claude-session-20260520-abc.md",
      "---\ncaptureMode: hot\nupdated: 2025-01-01\n---\n---\nakm_memory_kind: session_checkpoint\nrefs:\n  - memory:rollout-notes\n---\n\nGrep ran `memory:foo|knowledge:bar` and printed `memory:baz`.\n",
    );
    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "missing-ref")).toHaveLength(0);
  });

  test("missing-ref: empty `refs:` array suppresses body scan entirely", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "memories",
      "captured.md",
      "---\nupdated: 2025-01-01\nrefs: []\n---\n\nLiteral memory:nothing-here-resolves.\n",
    );
    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "missing-ref")).toHaveLength(0);
  });

  // ── H4: registry-derived REF_RE + path mapping ────────────────────────────
  // env/secret are 0.9 asset types that the legacy hand-written REF_RE +
  // refToRelPath omitted, so refs to them were invisible to the missing-ref
  // linter. Now that both are derived from the asset registry, env:/secret:
  // refs are matched and path-resolved like any other type.

  test("missing-ref: flags a missing env: ref (env/<name>.env)", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "agents",
      "env-agent.md",
      "---\nname: env-agent\ntype: agent\nupdated: 2025-01-01\n---\n\nLoads `env:prod` before running.\n",
    );
    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "missing-ref" && i.detail.includes("env:prod"));
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain(path.join("env", "prod.env"));
  });

  test("missing-ref: flags a missing secret: ref (secrets/<name>)", () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "agents",
      "secret-agent.md",
      "---\nname: secret-agent\ntype: agent\nupdated: 2025-01-01\n---\n\nAuth via `secret:deploy-key` here.\n",
    );
    const result = akmLint({ dir: stashDir });
    const issue = result.flagged.find((i) => i.issue === "missing-ref" && i.detail.includes("secret:deploy-key"));
    expect(issue).toBeDefined();
    expect(issue?.detail).toContain(path.join("secrets", "deploy-key"));
  });

  test("missing-ref: does NOT flag env:/secret: refs when the target files exist", () => {
    const stashDir = makeTempStash();
    // env:default -> env/.env ; env:prod -> env/prod.env ; secret:id_rsa -> secrets/id_rsa
    writeFile(stashDir, "env", ".env", "TOKEN=x\n");
    writeFile(stashDir, "env", "prod.env", "TOKEN=y\n");
    writeFile(stashDir, "secrets", "id_rsa", "-----BEGIN-----\n");
    writeFile(
      stashDir,
      "agents",
      "uses-real.md",
      "---\nname: uses-real\ntype: agent\nupdated: 2025-01-01\n---\n\nUses `env:default`, `env:prod`, and `secret:id_rsa`.\n",
    );
    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "missing-ref")).toHaveLength(0);
  });

  test("missing-ref: all previously-supported types still resolve unchanged", () => {
    const stashDir = makeTempStash();
    writeFile(stashDir, "agents", "a.md", "---\nupdated: 2025-01-01\n---\nx\n");
    writeFile(stashDir, "commands", "c.md", "---\nupdated: 2025-01-01\n---\nx\n");
    writeFile(stashDir, "knowledge", "k.md", "---\nupdated: 2025-01-01\n---\nx\n");
    writeFile(stashDir, "memories", "m.md", "---\nupdated: 2025-01-01\n---\nx\n");
    writeFile(stashDir, "workflows", "w.md", "---\nupdated: 2025-01-01\n---\nx\n");
    writeFile(stashDir, "lessons", "l.md", "---\nupdated: 2025-01-01\n---\nx\n");
    writeFile(stashDir, "wikis", "wk.md", "---\nupdated: 2025-01-01\n---\nx\n");
    writeFile(stashDir, "tasks", "t.md", "---\nupdated: 2025-01-01\n---\nx\n");
    writeFile(path.join(stashDir, "skills", "s"), "", "SKILL.md", "---\nupdated: 2025-01-01\n---\nx\n");
    writeFile(
      stashDir,
      "agents",
      "hub.md",
      "---\nname: hub\ntype: agent\nupdated: 2025-01-01\n---\n\n" +
        "Refs: `agent:a` `command:c` `knowledge:k` `memory:m` `workflow:w` " +
        "`lesson:l` `wiki:wk` `task:t` `skill:s`. Also `script:nested/foo` is skipped.\n",
    );
    const result = akmLint({ dir: stashDir });
    expect(result.flagged.filter((i) => i.issue === "missing-ref")).toHaveLength(0);
  });
});

// ── Exit code simulation tests ────────────────────────────────────────────────

describe("akmLint result.ok semantics", () => {
  // `ok: true` always — `ok` reflects "the lint run completed", NOT "no
  // issues found". Callers check summary.flagged for findings; the CLI
  // gates exit code on --fail-on-flagged.
  test("ok stays true even when issues remain unfixed; findings surface via summary.flagged", () => {
    const stashDir = makeTempStash();
    writeFile(stashDir, "agents", "broken.md", `---\ndescription: Has colon: here\n---\n\nBody.\n`);

    const result = akmLint({ dir: stashDir });
    expect(result.ok).toBe(true);
    expect(result.summary.flagged).toBeGreaterThan(0);
  });

  test("ok is true when all fixable issues are fixed", () => {
    const stashDir = makeTempStash();
    // Only fixable issues: missing-updated and unquoted-colon
    writeFile(
      stashDir,
      "skills",
      "fixable.md",
      `---\nname: fixable\ntype: skill\ndescription: Has colon: here\n---\n\nThis is a reasonably long body text without any placeholder content.\n`,
    );

    const result = akmLint({ dir: stashDir, fix: true });
    // After fixing, ok should be true (no remaining unfixed issues)
    expect(result.ok).toBe(true);
    expect(result.summary.flagged).toBe(0);
    expect(result.summary.fixed).toBeGreaterThan(0);
  });

  test("ok is true for empty stash", () => {
    const stashDir = makeTempStash();
    const result = akmLint({ dir: stashDir });
    expect(result.ok).toBe(true);
    expect(result.summary.fixed).toBe(0);
    expect(result.summary.flagged).toBe(0);
  });

  test("summary counts match arrays", () => {
    const stashDir = makeTempStash();
    writeFile(stashDir, "skills", "s1.md", `---\ndescription: Has colon: value\n---\n\nBody.\n`);
    writeFile(stashDir, "agents", "a1.md", `---\nname: a1\n---\n\nBody.\n`);

    const result = akmLint({ dir: stashDir });
    expect(result.summary.flagged).toBe(result.flagged.length);
    expect(result.summary.fixed).toBe(result.fixed.length);
  });
});

// ── CLI exit-code semantics ─────────────────────────────────────────────────
//
// Drive the real CLI in-process (via runCliCapture) so we cover the
// args-to-process.exit wiring in src/cli.ts, not just the akmLint() return
// value. Migrated from spawnSync("bun", [cli, ...]): the harness shims
// process.exit into the returned `code`, so `lint --fail-on-flagged`'s
// `process.exit(EXIT_GENERAL)` surfaces as code=1 after the JSON envelope is
// emitted to stdout. Each run targets a temp stash via `--dir` and wraps the
// call in `withEnv` (the allowlisted env wrapper) to pin HOME/XDG at the stash
// dir for isolation, matching what the spawned subprocess got, restoring env
// afterward so the per-test isolation tripwire stays satisfied.
describe("akm lint CLI exit code", () => {
  function runLintCli(stashDir: string, extraArgs: string[] = []): Promise<{ status: number; stdout: string }> {
    return withEnv(
      {
        HOME: stashDir,
        XDG_CONFIG_HOME: stashDir,
        XDG_DATA_HOME: stashDir,
        XDG_STATE_HOME: stashDir,
        XDG_CACHE_HOME: stashDir,
        AKM_STASH_DIR: undefined,
      },
      async () => {
        const { code, stdout } = await runCliCapture(["lint", "--dir", stashDir, "--format", "json", ...extraArgs]);
        return { status: code, stdout };
      },
    );
  }

  test("exits 0 when findings exist and --fail-on-flagged is not set", async () => {
    const stashDir = makeTempStash();
    writeFile(stashDir, "agents", "broken.md", `---\ndescription: Has colon: here\n---\n\nBody.\n`);

    const { status, stdout } = await runLintCli(stashDir);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout) as { ok: boolean; summary: { flagged: number } };
    expect(payload.ok).toBe(true);
    expect(payload.summary.flagged).toBeGreaterThan(0);
  });

  test("exits 0 with --fail-on-flagged when there are no findings", async () => {
    const stashDir = makeTempStash();
    writeFile(
      stashDir,
      "skills",
      "clean.md",
      `---\nname: clean\ntype: skill\ndescription: "Does X cleanly"\nupdated: 2025-01-01\n---\n\nClean body content without placeholders.\n`,
    );

    const { status, stdout } = await runLintCli(stashDir, ["--fail-on-flagged"]);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout) as { ok: boolean; summary: { flagged: number } };
    expect(payload.ok).toBe(true);
    expect(payload.summary.flagged).toBe(0);
  });

  test("exits non-zero with --fail-on-flagged when findings exist", async () => {
    const stashDir = makeTempStash();
    writeFile(stashDir, "agents", "broken.md", `---\ndescription: Has colon: here\n---\n\nBody.\n`);

    const { status, stdout } = await runLintCli(stashDir, ["--fail-on-flagged"]);
    expect(status).not.toBe(0);
    // The result envelope is still written before exit; `ok` stays true
    // because the lint run itself completed without error.
    const payload = JSON.parse(stdout) as { ok: boolean; summary: { flagged: number } };
    expect(payload.ok).toBe(true);
    expect(payload.summary.flagged).toBeGreaterThan(0);
  });
});
