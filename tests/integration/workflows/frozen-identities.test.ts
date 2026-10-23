// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Classification: opens a real database and spawns real processes (the exec
 * units run `process.execPath`).
 *
 * Freeze records identities, never locations. The plan stores the refs the
 * engine dereferences; the bundle root, the env files, the secrets and the
 * `${ref}` paths are all found again at dispatch. These tests drive the real
 * dispatcher (no `workDir`, no injected dispatcher) over real bundles, so a
 * location that leaked into the plan, or a cwd applied twice, fails here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resetConfigCache } from "../../../src/core/config/config";
import { openStateDatabase } from "../../../src/core/state-db";
import { resolveStorageLocations } from "../../../src/storage/locations";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { runWorkflowSteps } from "../../../src/workflows/exec/run-workflow";
import { startWorkflowRun } from "../../../src/workflows/runtime/runs";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  writeSandboxConfig,
  writeWorkflowTestConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

const BUN = process.execPath;

function write(root: string, relative: string, bytes: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}

function bundle(name: string): string {
  const root = path.join(storage.root, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function configureBundles(paths: Record<string, string>): void {
  writeSandboxConfig({
    bundles: Object.fromEntries(Object.entries(paths).map(([name, root]) => [name, { path: root }])),
  });
  resetConfigCache();
}

/** An exec unit's frontmatter: `unit.exec.command` and any extra `exec`/`unit` lines. */
function execStep(id: string, command: string[], opts: { cwd?: string; env?: string[] } = {}): string[] {
  return [
    `  - id: ${id}`,
    "    unit:",
    ...(opts.env ? [`      env: ${JSON.stringify(opts.env)}`] : []),
    "      exec:",
    `        command: ${JSON.stringify(command)}`,
    ...(opts.cwd !== undefined ? [`        cwd: ${JSON.stringify(opts.cwd)}`] : []),
  ];
}

function workflowSource(steps: string[][]): string {
  const ids = steps.map((lines) => /- id: (\S+)/.exec(lines[0] ?? "")?.[1] ?? "");
  return [
    "---",
    "type: workflow",
    "steps:",
    ...steps.flat(),
    "---",
    "",
    ...ids.flatMap((id) => [`## ${id}`, "", `Run ${id}.`, ""]),
  ].join("\n");
}

/** A child that records where it ran: `<name>.txt` in its own cwd holds `process.cwd()`. */
function recordCwd(name: string): string[] {
  return [BUN, "-e", `require("node:fs").writeFileSync(${JSON.stringify(`${name}.txt`)}, process.cwd())`];
}

async function drive(ref: string, options: { maxSteps?: number } = {}) {
  const started = await startWorkflowRun(ref, {});
  const result = await runWorkflowSteps({ target: started.run.id, ...options });
  return { runId: started.run.id, result };
}

function realpath(file: string): string {
  return fs.realpathSync(file);
}

describe("a frozen plan carries no location", () => {
  test("irVersion 7: no cwdIdentity, no frozen workspace, and an env ref that is a bundle-qualified ref only", async () => {
    const team = bundle("team");
    write(team, "env/prod.env", "REGION=east\nTOKEN=${secrets/t}\n");
    write(
      team,
      "workflows/frozen.md",
      workflowSource([execStep("run", [BUN, "-e", "0"], { env: ["env/prod"] }), ["  - id: ask"]]),
    );
    configureBundles({ team });

    const started = await startWorkflowRun("team//workflows/frozen", {});
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const plan = JSON.parse(row?.plan_json ?? "{}");

    expect(plan.irVersion).toBe(7);
    expect(row?.plan_ir_version).toBe(7);
    const [run, ask] = plan.steps;
    expect(run.root.environment).toEqual([{ kind: "env-ref", ref: "team//env/prod", precedence: 0 }]);
    expect(run.root.frozenTarget.cwdIdentity).toBeUndefined();
    expect(ask.root.frozenTarget.kind).toBe("command");
    expect(ask.root.frozenTarget.cwdIdentity).toBeUndefined();
    expect(ask.root.frozenTarget.request.runtime.workspace).toBeUndefined();
    expect(row?.plan_json).not.toMatch(/cwdIdentity|requestedRoot|realCwd|workspace|secretNames/);
  });
});

describe("one cwd rule", () => {
  test("exec.cwd is applied once: `cwd: sub` runs in <bundle>/sub", async () => {
    write(storage.stashDir, "sub/keep", "");
    write(storage.stashDir, "workflows/sub.md", workflowSource([execStep("work", recordCwd("where"), { cwd: "sub" })]));

    const { result } = await drive("workflows/sub");

    expect(result.executed[0]?.summary).not.toMatch(/does not exist/);
    expect(result.done).toBe(true);
    const where = path.join(storage.stashDir, "sub", "where.txt");
    expect(realpath(fs.readFileSync(where, "utf8"))).toBe(realpath(path.join(storage.stashDir, "sub")));
  });

  test("an exec unit with no cwd runs in the owner root of the run's workflow", async () => {
    const team = bundle("team");
    write(team, "workflows/root.md", workflowSource([execStep("work", recordCwd("where"))]));
    configureBundles({ team });

    const { result } = await drive("team//workflows/root");

    expect(result.done).toBe(true);
    expect(realpath(fs.readFileSync(path.join(team, "where.txt"), "utf8"))).toBe(realpath(team));
  });

  test("exec.cwd may be absolute", async () => {
    const elsewhere = bundle("elsewhere");
    write(
      storage.stashDir,
      "workflows/abs.md",
      workflowSource([execStep("work", recordCwd("where"), { cwd: elsewhere })]),
    );

    const { result } = await drive("workflows/abs");

    expect(result.done).toBe(true);
    expect(realpath(fs.readFileSync(path.join(elsewhere, "where.txt"), "utf8"))).toBe(realpath(elsewhere));
  });

  test("a bundle update between two steps: the next step runs from the new revision and the run completes", async () => {
    const rev1 = bundle("team-rev1");
    const rev2 = bundle("team-rev2");
    const source = workflowSource([execStep("first", recordCwd("first")), execStep("second", recordCwd("second"))]);
    write(rev1, "workflows/moving.md", source);
    write(rev2, "workflows/moving.md", source);
    configureBundles({ team: rev1 });

    const started = await startWorkflowRun("team//workflows/moving", {});
    const first = await runWorkflowSteps({ target: started.run.id, maxSteps: 1 });
    expect(first.executed[0]?.ok).toBe(true);

    // `bundle update` moves the bundle to a new revision directory and removes the old one.
    fs.rmSync(rev1, { recursive: true, force: true });
    configureBundles({ team: rev2 });

    const second = await runWorkflowSteps({ target: started.run.id });
    expect(second.done).toBe(true);
    expect(realpath(fs.readFileSync(path.join(rev2, "second.txt"), "utf8"))).toBe(realpath(rev2));
  });

  test("a bundle update to a revision without the workflow: the run completes from its frozen plan in the new root", async () => {
    const rev1 = bundle("team-rev1");
    const rev2 = bundle("team-rev2");
    write(
      rev1,
      "workflows/moving.md",
      workflowSource([execStep("first", recordCwd("first")), execStep("second", recordCwd("second"))]),
    );
    write(rev2, "workflows/other.md", workflowSource([execStep("only", recordCwd("only"))]));
    configureBundles({ team: rev1 });

    const started = await startWorkflowRun("team//workflows/moving", {});
    const first = await runWorkflowSteps({ target: started.run.id, maxSteps: 1 });
    expect(first.executed[0]?.ok).toBe(true);

    // The new revision renamed the workflow away: the file the run was frozen from no longer exists.
    fs.rmSync(rev1, { recursive: true, force: true });
    configureBundles({ team: rev2 });

    const second = await runWorkflowSteps({ target: started.run.id });
    expect(second.executed[0]?.summary ?? "").not.toMatch(/does not resolve to a bundle/);
    expect(second.done).toBe(true);
    expect(realpath(fs.readFileSync(path.join(rev2, "second.txt"), "utf8"))).toBe(realpath(rev2));
  });

  test("a workflow whose bundle is gone fails the step naming the ref, never running in akm's cwd", async () => {
    const team = bundle("team");
    write(team, "workflows/gone.md", workflowSource([execStep("work", recordCwd("where"))]));
    configureBundles({ team });
    const started = await startWorkflowRun("team//workflows/gone", {});
    configureBundles({});

    const result = await runWorkflowSteps({ target: started.run.id });

    expect(result.done).toBeUndefined();
    expect(result.executed[0]?.ok).toBe(false);
    expect(result.executed[0]?.summary).toContain("team//workflows/gone");
    expect(fs.existsSync(path.join(process.cwd(), "where.txt"))).toBe(false);
  });
});

describe("the gate judge's working directory", () => {
  const gated = [
    "---",
    "type: workflow",
    "steps:",
    "  - id: one",
    "---",
    "",
    "## one",
    "",
    "Do it.",
    "",
    "### gate",
    "",
    "- it is done",
    "",
  ].join("\n");
  const passed = '{"complete": true, "missing": []}';

  test("the judge request carries the owner root of the run's workflow as its cwd", async () => {
    const team = bundle("team");
    write(team, "workflows/gated.md", gated);
    configureBundles({ team });
    const started = await startWorkflowRun("team//workflows/gated", {});

    const gateCwds: Array<string | undefined> = [];
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (request) => {
        if (request.nodeId === "one.gate") gateCwds.push(request.cwd);
        return { ok: true, text: request.nodeId === "one.gate" ? passed : "done" };
      },
    });

    expect(result.done).toBe(true);
    expect(gateCwds).toHaveLength(1);
    expect(realpath(gateCwds[0] ?? "")).toBe(realpath(team));
  });

  test("a workflow whose bundle is gone blocks the step naming the ref; the judge never runs in akm's cwd", async () => {
    const team = bundle("team");
    write(team, "workflows/gated-gone.md", gated);
    configureBundles({ team });
    const started = await startWorkflowRun("team//workflows/gated-gone", {});
    configureBundles({});

    const dispatched: Array<string | undefined> = [];
    const result = await runWorkflowSteps({
      target: started.run.id,
      dispatcher: async (request) => {
        dispatched.push(request.nodeId);
        return { ok: true, text: request.nodeId === "one.gate" ? passed : "done" };
      },
    });

    expect(result.done).toBeUndefined();
    expect(result.executed[0]?.ok).toBe(false);
    expect(result.executed[0]?.summary).toContain("team//workflows/gated-gone");
    expect(dispatched).not.toContain("one.gate");
  });
});

describe("${ref} in an exec unit", () => {
  test("a script in bundle B and an env value from bundle C that names a secret in bundle D complete a run in bundle A", async () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map(bundle) as [string, string, string, string];
    write(
      b,
      "scripts/check.ts",
      [
        'import fs from "node:fs";',
        'fs.writeFileSync("seen.txt", `${process.env.TOKEN === "tok-d" ? "token-ok" : "token-bad"}:${process.env.REGION}`);',
        "",
      ].join("\n"),
    );
    write(c, "env/ci.env", "REGION=east\nTOKEN=${d//secrets/t}\n");
    write(d, "secrets/t", "tok-d\n");
    write(
      a,
      "workflows/multi.md",
      workflowSource([execStep("run", [BUN, "${b//scripts/check.ts}"], { env: ["c//env/ci"] })]),
    );
    configureBundles({ a, b, c, d });

    const { result } = await drive("a//workflows/multi");

    expect(result.done).toBe(true);
    expect(fs.readFileSync(path.join(a, "seen.txt"), "utf8")).toBe("token-ok:east");
  });

  test("a ${secrets/...} token in argv joins the redaction set: the value reaches the child but never the journal", async () => {
    const a = bundle("a");
    const secret = "sk-argv-secret-8f3a1c";
    write(a, "secrets/t", `${secret}\n`);
    write(
      a,
      "workflows/leak.md",
      workflowSource([
        execStep("run", [
          BUN,
          "-e",
          "const v = process.argv[process.argv.length - 1]; process.stdout.write(`out:${v}`); process.stderr.write(`err:${v}`)",
          "${a//secrets/t}",
        ]),
      ]),
    );
    configureBundles({ a });

    const { runId, result } = await drive("a//workflows/leak");

    expect(result.done).toBe(true);
    const units = await withWorkflowRunsRepo((repo) => repo.getUnitsForStep(runId, "run"));
    expect(units.length).toBeGreaterThan(0);
    const journaled = JSON.stringify(units);
    expect(journaled).toContain("out:");
    expect(journaled).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("a token in exec.cwd resolves to the asset's path", async () => {
    const [a, b] = ["a", "b"].map(bundle) as [string, string];
    write(b, "scripts/lab/run.sh", "#!/bin/sh\n");
    write(
      a,
      "workflows/cwd.md",
      workflowSource([execStep("run", recordCwd("where"), { cwd: "${b//scripts/lab/run.sh}/.." })]),
    );
    configureBundles({ a, b });

    const { result } = await drive("a//workflows/cwd");

    expect(result.done).toBe(true);
    expect(realpath(fs.readFileSync(path.join(b, "scripts", "lab", "where.txt"), "utf8"))).toBe(
      realpath(path.join(b, "scripts", "lab")),
    );
  });

  test("a ref no bundle owns fails the unit before anything is spawned, naming the ref", async () => {
    const a = bundle("a");
    write(
      a,
      "workflows/missing.md",
      workflowSource([
        execStep("run", [BUN, "-e", 'require("node:fs").writeFileSync("ran.txt", "x")', "${a//scripts/absent.sh}"]),
      ]),
    );
    configureBundles({ a });

    const { result } = await drive("a//workflows/missing");

    expect(result.done).toBeUndefined();
    expect(result.executed[0]?.ok).toBe(false);
    expect(result.executed[0]?.summary).toContain("a//scripts/absent.sh");
    expect(fs.existsSync(path.join(a, "ran.txt"))).toBe(false);
  });
});

describe("an irVersion 6 run", () => {
  test("dispatches by ref: the frozen cwd and env locations it carries are ignored", async () => {
    const team = bundle("team");
    write(team, "env/prod.env", "REGION=east\n");
    write(
      team,
      "workflows/old.md",
      workflowSource([
        execStep(
          "run",
          [BUN, "-e", 'require("node:fs").writeFileSync("old.txt", `${process.cwd()}|${process.env.REGION}`)'],
          { env: ["env/prod"] },
        ),
      ]),
    );
    configureBundles({ team });
    const started = await startWorkflowRun("team//workflows/old", {});

    // Rewrite the stored plan into what a 0.10 pre-release froze: locations beside the identities.
    const row = await withWorkflowRunsRepo((repo) => repo.getRunById(started.run.id));
    const plan = JSON.parse(row?.plan_json ?? "{}");
    const unit = plan.steps[0].root;
    unit.frozenTarget.cwdIdentity = {
      requestedRoot: "/gone/rev1",
      realRoot: "/gone/rev1",
      rootDevice: "7",
      rootInode: "100",
      requestedCwd: "/gone/rev1",
      realCwd: "/gone/rev1",
      cwdDevice: "7",
      cwdInode: "100",
    };
    unit.environment = [
      {
        kind: "env-ref",
        ref: "team//env/prod",
        owner: {
          bundle: "team",
          adapter: "dotenv",
          requestedRoot: "/gone/rev1",
          requestedPath: "/gone/rev1/env/prod.env",
          relativePath: "env/prod.env",
        },
        keys: ["REGION", "FROZEN_ONLY"],
        secretNames: [],
        precedence: 0,
      },
    ];
    plan.irVersion = 6;
    const db = openStateDatabase(resolveStorageLocations().stateDb);
    try {
      db.prepare("UPDATE workflow_runs SET plan_json = ?, plan_ir_version = 6 WHERE id = ?").run(
        JSON.stringify(plan),
        started.run.id,
      );
    } finally {
      db.close();
    }

    const result = await runWorkflowSteps({ target: started.run.id });

    expect(result.done).toBe(true);
    expect(fs.readFileSync(path.join(team, "old.txt"), "utf8")).toBe(`${realpath(team)}|east`);
  });
});
