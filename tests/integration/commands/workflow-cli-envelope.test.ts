// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WS6 characterization test for the `akm workflow` command family. Pins the full
 * JSON envelope (stdout payload shape + the {ok:false,…} error envelope on
 * stderr / exit code) for representative subcommands, proving the extraction of
 * the family from cli.ts into src/commands/workflow-cli.ts and the migration of
 * the leaf handlers onto `defineJsonCommand` is byte-identical. `workflow
 * template` is verified separately because it writes the markdown template
 * straight to stdout with no JSON envelope. Workflows are authored in-process
 * via `workflow create --from <file>` against an isolated stash dir; the CLI
 * reads that stash back through AKM_STASH_DIR via the in-process harness.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { runCliCapture } from "../../_helpers/cli";
import { makeSandboxDir, type SandboxedDir, withEnv, writeWorkflowTestConfig } from "../../_helpers/sandbox";

const disposers: SandboxedDir[] = [];

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

const ONE_STEP_WORKFLOW = `---
description: Envelope test workflow
---

# Workflow: Release Flow

## Step: Deploy
Step ID: deploy

### Instructions
Run the deployment command and watch health checks.

### Completion Criteria
- Deployment confirmed
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
    { AKM_STASH_DIR: stashDir, XDG_CONFIG_HOME: path.join(stashDir, ".config") },
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
    const { stdout, status } = await runCli(["--json", "workflow", "create", "release-flow", "--from", src], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(env.ok).toBe(true);
    expect(typeof env.path).toBe("string");
    expect(fs.existsSync(env.path as string)).toBe(true);
  });

  test("workflow list: envelope wraps runs under `runs`", async () => {
    const stash = makeStashDir();
    await createReleaseFlow(stash);
    const { stdout, status } = await runCli(["--json", "workflow", "list"], stash);
    expect(status).toBe(0);
    const env = JSON.parse(stdout);
    expect(Array.isArray(env.runs)).toBe(true);
  });

  test("workflow start + status: success envelopes carry the run id and steps", async () => {
    const stash = makeStashDir();
    await createReleaseFlow(stash);
    const started = await runCli(["--json", "workflow", "start", "workflows/release-flow"], stash);
    expect(started.status).toBe(0);
    const startEnv = JSON.parse(started.stdout);
    const runId = startEnv.run.id as string;
    expect(typeof runId).toBe("string");

    const status = await runCli(["--json", "workflow", "status", runId], stash);
    expect(status.status).toBe(0);
    const statusEnv = JSON.parse(status.stdout);
    expect(Array.isArray(statusEnv.workflow.steps)).toBe(true);
  });

  test("workflow template: writes markdown to stdout with no JSON envelope", async () => {
    const stash = makeStashDir();
    const { stdout, status } = await runCli(["workflow", "template"], stash);
    expect(status).toBe(0);
    expect(stdout).toContain("# Workflow:");
    expect(stdout).toContain("Step ID:");
  });

  test("workflow status: unknown run → byte-identical {ok:false} not-found envelope on stderr", async () => {
    const stash = makeStashDir();
    const { stderr, status } = await runCli(
      ["--json", "workflow", "status", "00000000-0000-4000-8000-000000000000"],
      stash,
    );
    expect(status).toBe(1);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("WORKFLOW_NOT_FOUND");
  });

  test("workflow next: --dry-run is rejected with the INVALID_FLAG_VALUE usage envelope", async () => {
    const stash = makeStashDir();
    await createReleaseFlow(stash);
    const { stderr, status } = await runCli(
      ["--json", "workflow", "next", "workflows/release-flow", "--dry-run"],
      stash,
    );
    expect(status).toBe(2);
    const env = JSON.parse(stderr);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("INVALID_FLAG_VALUE");
  });
});
