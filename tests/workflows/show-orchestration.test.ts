// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm show`'s per-step orchestration projection (`summarizeStepOrchestration`
 * in `src/workflows/renderer.ts`) — the object `akm show --format json`
 * serializes under `steps[].orchestration`.
 *
 * The regression this suite pins: the projection is a CLAIM about what will
 * run, so it must never say something the plan does not do. An `exec` (shell)
 * unit names NO engine — the parser rejects `engine`/`model`/`llm` alongside
 * `exec:` — but the projection merged `defaults.engine`/`defaults.model` into
 * every step unconditionally, so `show` described an exec step as running on
 * the workflow's default engine and omitted the argv that actually executes.
 *
 * The call shape below is exactly `showLocal`'s (`src/commands/read/show.ts`):
 * `buildFileContext` -> `recognizeMatch` -> `getRenderer` ->
 * `buildRenderContext` -> `buildShowResponse`. `showLocal`'s post-processing
 * (related/editable/activeRun/…) never touches `steps`, so what this suite
 * asserts is byte-for-byte what the CLI emits.
 */

import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recognizeMatch } from "../../src/core/adapter/adapters/akm-adapter";
import { buildFileContext, buildRenderContext, getRenderer } from "../../src/indexer/walk/file-context";
import type { ShowResponse, WorkflowStepOrchestrationSummary } from "../../src/sources/types";

// A plain fixture dir (not an AKM env path), so raw mkdtempSync is fine.
const fixtureDirs: string[] = [];

afterAll(() => {
  for (const dir of fixtureDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Render `markdown` as `workflows/<name>.md` the way `akm show` would. */
async function showWorkflow(markdown: string, name = "demo"): Promise<ShowResponse> {
  const stashRoot = fs.mkdtempSync(path.join(os.tmpdir(), "akm-show-orch-"));
  fixtureDirs.push(stashRoot);
  const absPath = path.join(stashRoot, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, markdown, "utf8");

  const fileCtx = buildFileContext(stashRoot, absPath);
  const match = recognizeMatch(fileCtx);
  if (!match) throw new Error("fixture must be recognized as a workflow");
  match.meta = { ...match.meta, name };
  const renderer = await getRenderer(match.renderer);
  if (!renderer) throw new Error(`no renderer registered for "${match.renderer}"`);
  return renderer.buildShowResponse(buildRenderContext(fileCtx, match, [stashRoot], undefined));
}

async function orchestrationOf(markdown: string, stepId: string): Promise<WorkflowStepOrchestrationSummary> {
  const response = await showWorkflow(markdown);
  const step = response.steps?.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`fixture must contain a step "${stepId}"`);
  return step.orchestration ?? {};
}

/**
 * One exec step and one ordinary LLM step under the SAME run-level defaults,
 * so "the defaults are suppressed" and "the defaults still apply" are pinned
 * against a single document.
 */
const MIXED_WORKFLOW = [
  "---",
  "type: workflow",
  "description: Exec projection fixture",
  "defaults:",
  "  engine: default-engine",
  "  model: default-model",
  '  timeout: "5m"',
  "steps:",
  "  - id: build",
  "    unit:",
  "      exec:",
  '        command: ["bun", "run", "build", "--target", "node", "--minify"]',
  "        cwd: packages/core",
  "        pass_env: [CARGO_HOME]",
  "  - id: review",
  "---",
  "",
  "# Fixture",
  "",
  "## build",
  "",
  "Build the package.",
  "",
  "## review",
  "",
  "Review the build output.",
  "",
].join("\n");

describe("show projection: exec steps", () => {
  test("an exec step projects its argv and NEVER claims the workflow's default engine", async () => {
    const orchestration = await orchestrationOf(MIXED_WORKFLOW, "build");
    // The claim that was false: an exec unit reaches no engine and no model,
    // so neither key may appear — not even inherited from `defaults`.
    expect(orchestration.engine).toBeUndefined();
    expect(orchestration.model).toBeUndefined();
    // ...and the thing that WILL run has to be visible.
    expect(orchestration.exec?.command).toEqual(["bun", "run", "build", "--target", "node", "--minify"]);
  });

  test("the exec projection carries where it runs and what environment it can see — names only", async () => {
    const orchestration = await orchestrationOf(MIXED_WORKFLOW, "build");
    expect(orchestration.exec?.cwd).toBe("packages/core");
    // `pass_env` is a list of variable NAMES; no value is resolved at parse
    // time and none is ever projected.
    expect(orchestration.exec?.passEnv).toEqual(["CARGO_HOME"]);
    expect(orchestration.exec?.inheritEnv).toBeUndefined();
  });

  test("`inherit_env: true` is surfaced — it changes what the command can see", async () => {
    const orchestration = await orchestrationOf(
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: build",
        "    unit:",
        "      exec:",
        '        command: ["make"]',
        "        inherit_env: true",
        "---",
        "",
        "## build",
        "",
        "Build it.",
        "",
      ].join("\n"),
      "build",
    );
    expect(orchestration.exec).toEqual({ command: ["make"], inheritEnv: true });
  });

  test("timeout still merges the defaults — an exec unit really does inherit `defaults.timeout`", async () => {
    const orchestration = await orchestrationOf(MIXED_WORKFLOW, "build");
    expect(orchestration.timeoutMs).toBe(5 * 60_000);
  });

  test("suppression is exec-scoped: a sibling engine step still reports the merged defaults", async () => {
    const orchestration = await orchestrationOf(MIXED_WORKFLOW, "review");
    expect(orchestration.engine).toBe("default-engine");
    expect(orchestration.model).toBe("default-model");
    expect(orchestration.exec).toBeUndefined();
  });

  test("a map of exec units carries BOTH the fan-out and the argv", async () => {
    const orchestration = await orchestrationOf(
      [
        "---",
        "type: workflow",
        "defaults:",
        "  engine: default-engine",
        "steps:",
        "  - id: discover",
        "  - id: lint",
        "    map:",
        "      over: steps.discover.output.files",
        "      concurrency: 2",
        "      unit:",
        "        exec:",
        '          command: ["biome", "check"]',
        "---",
        "",
        "## discover",
        "",
        "List the files.",
        "",
        "## lint",
        "",
        "Lint one file.",
        "",
      ].join("\n"),
      "lint",
    );
    expect(orchestration.exec?.command).toEqual(["biome", "check"]);
    expect(orchestration.fanOut).toEqual({ over: "steps.discover.output.files", concurrency: 2, reducer: "collect" });
    // Same claim, one layer down: the per-item unit is an exec unit, so the
    // map step must not be described as running on the default engine either.
    expect(orchestration.engine).toBeUndefined();
  });

  test("the JSON `akm show --format json` emits contains the command and no default-engine claim", async () => {
    const response = await showWorkflow(MIXED_WORKFLOW);
    const build = response.steps?.find((step) => step.id === "build");
    const json = JSON.stringify(build);
    expect(json).toContain('"--minify"');
    expect(json).not.toContain("default-engine");
    expect(json).not.toContain("default-model");
    // The argv is projected WHOLE — a clipped command would be the same class
    // of bug (show describing something other than what runs).
    expect(JSON.parse(json).orchestration.exec.command).toHaveLength(6);
  });

  test("shell metacharacters in an argument survive the projection as literal bytes", async () => {
    // `command` is argv, never a shell string, so these are ordinary argument
    // bytes. The projection must show them verbatim rather than re-quoting or
    // dropping them — what show prints is what gets spawned.
    const orchestration = await orchestrationOf(
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: pipeline",
        "    unit:",
        "      exec:",
        '        command: ["bash", "-lc", "a | b && c"]',
        "---",
        "",
        "## pipeline",
        "",
        "Run the pipeline.",
        "",
      ].join("\n"),
      "pipeline",
    );
    expect(orchestration.exec?.command).toEqual(["bash", "-lc", "a | b && c"]);
  });
});
