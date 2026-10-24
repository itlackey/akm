// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm workflow` command family. Pins the full
 * JSON envelope (stdout payload shape + the {ok:false,…} error envelope on
 * stderr / exit code) for representative subcommands, proving the extraction of
 * the family from cli.ts into src/commands/workflow-cli.ts and the migration of
 * the leaf handlers onto `defineJsonCommand` is byte-identical. Workflows are
 * authored in-process via `workflow create --from <file>` against an isolated
 * stash dir; the CLI reads that stash back through AKM_BUNDLE_DIR via the
 * in-process harness.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runCliCapture } from "../_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv, writeWorkflowTestConfig } from "../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

// Unified-format fixture (frontmatter graph + `## <id>` body — spec §2.2).
const ONE_STEP_WORKFLOW = `---
type: workflow
description: Envelope test workflow
params:
  release: { type: string }
steps:
  - id: choose
    route:
      input: params.release
      when: [{ match: stable, step: deploy }]
      default: deploy
  - id: deploy
---

# Release Flow

## choose

## deploy

Run the deployment command and watch health checks.

`;

function makeStashDir(): string {
  const d = makeSandboxDir("akm-workflow-envelope-");
  disposers.push(d);
  for (const sub of ["lessons", "skills", "memories", "knowledge", "workflows"]) {
    fs.mkdirSync(path.join(d.dir, sub), { recursive: true });
  }
  return d.dir;
}

function writeWorkflowSource(): string {
  const d = makeSandboxDir("akm-workflow-envelope-src-");
  disposers.push(d);
  const file = path.join(d.dir, "wf.md");
  fs.writeFileSync(file, ONE_STEP_WORKFLOW, "utf8");
  return file;
}

async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
  const { code, stdout, stderr } = await withEnv(
    { AKM_BUNDLE_DIR: stashDir, XDG_CONFIG_HOME: path.join(stashDir, ".config") },
    () => {
      writeWorkflowTestConfig();
      return runCliCapture(args);
    },
  );
  return { stdout, stderr, status: code };
}

async function createReleaseFlow(stash: string): Promise<void> {
  const src = writeWorkflowSource();
  const { status, stderr } = await runCli(["workflow", "create", "release-flow", "--from", src], stash);
  if (status !== 0) throw new Error(`workflow create failed: ${stderr}`);
}

describe("akm workflow — JSON envelope snapshot (WS6)", () => {
  test("workflow create: success envelope reports the written workflow", async () => {
    const stash = makeStashDir();
    const src = writeWorkflowSource();
    const { stdout, status } = await runCli(["workflow", "create", "release-flow", "--from", src], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(typeof env.path).toBe("string");
    expect(fs.existsSync(env.path as string)).toBe(true);
    // 0.9.2 review round 2 (P4 sweep criterion-21 caveat, spec
    // docs/plans/specs/p4-deletions-closeout.md §4.1 row B-49): the
    // envelope's third member is `bundleDir` — BREAKING vs 0.9.1, which
    // leaked `stashDir` here (src/workflows/authoring/authoring.ts).
    expect(env.bundleDir).toBe(stash);
    expect(env.stashDir).toBeUndefined();
  });

  test("workflow list: envelope wraps runs under `runs`", async () => {
    const stash = makeStashDir();
    await createReleaseFlow(stash);
    const { stdout, status } = await runCli(["workflow", "list"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.runs)).toBe(true);
  });

  test("workflow run + status: success envelopes carry typed params, run id, and steps", async () => {
    const stash = makeStashDir();
    await createReleaseFlow(stash);
    const run = await runCli(
      ["workflow", "run", "workflows/release-flow", "--release=stable", "--max-steps", "1"],
      stash,
    );
    expect(run.status).toBe(0);
    const runEnv = JSON.parse(run.stdout);
    const runId = runEnv.run.id as string;
    expect(typeof runId).toBe("string");
    expect(runEnv.run.params).toEqual({ release: "stable" });

    const status = await runCli(["workflow", "status", runId], stash);
    expect(status.status).toBe(0);
    const statusEnv = JSON.parse(status.stdout);
    expect(Array.isArray(statusEnv.workflow.steps)).toBe(true);
  });

  test("workflow create --print: raw template on stdout (no envelope), writes nothing", async () => {
    const stash = makeStashDir();
    const { stdout, status } = await runCli(["workflow", "create", "print-flow", "--print"], stash);
    expect(status).toBe(0);
    // Deliberately NOT an envelope even under --json: --print's contract is a
    // pipeable raw starter document (parity with the removed `workflow
    // template`, which was format-exempt for the same reason).
    expect(stdout.trimStart().startsWith("{")).toBe(false);
    // Unified template: no "# Workflow:"/"Step ID:" grammar — frontmatter
    // carries the graph, `## <id>` headings carry the body (spec §2.2).
    expect(stdout).toContain("type: workflow");
    expect(stdout).toContain("## first-step");
    expect(fs.existsSync(path.join(stash, "workflows", "print-flow.md"))).toBe(false);
  });

  test("workflow create YAML --print is a usage error", async () => {
    const stash = makeStashDir();
    const { stdout, stderr, status } = await runCli(["workflow", "create", "print-flow.yaml", "--print"], stash);
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr).error).toContain("markdown-only");
  });

  test("workflow status: unknown run → byte-identical {ok:false} not-found envelope on stderr", async () => {
    const stash = makeStashDir();
    const { stderr, status } = await runCli(["workflow", "status", "00000000-0000-4000-8000-000000000000"], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("WORKFLOW_NOT_FOUND");
  });

  test("workflow status <ref>: never run in this scope → not-found envelope names the scope and suggests --all-scopes (#942)", async () => {
    const stash = makeStashDir();
    await createReleaseFlow(stash);
    const { stderr, status } = await runCli(["workflow", "status", "workflows/release-flow"], stash);
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("WORKFLOW_NOT_FOUND");
    expect(env.error).toContain("workflows/release-flow");
    expect(env.error).toContain("scope");
    expect(env.hint).toContain("--all-scopes");
  });

  test("retired workflow next returns an unknown-command envelope with a migration hint", async () => {
    const stash = makeStashDir();
    await createReleaseFlow(stash);
    const { stderr, status } = await runCli(["workflow", "next", "workflows/release-flow", "--dry-run"], stash);
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("UNKNOWN_COMMAND");
    expect(env.hint).toContain("workflow run");
  });

  // P3b Lane B (spec docs/plans/specs/p3b-child-executor.md §4.6, §6 F-B2):
  // ONE additive arm, in the same additive convention P2b used for
  // `task explain` (tests/integration/commands/tasks-explain.test.ts) —
  // every pre-existing test above is byte-unchanged.
  test("workflow plan --format json: envelope carries ok, planHash, published:false, and a steps array", async () => {
    const stash = makeStashDir();
    await createReleaseFlow(stash);
    const { stdout, status } = await runCli(["workflow", "plan", "workflows/release-flow", "--format", "json"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(typeof env.planHash).toBe("string");
    expect(env.published).toBe(false);
    expect(Array.isArray(env.steps)).toBe(true);
  });
});
