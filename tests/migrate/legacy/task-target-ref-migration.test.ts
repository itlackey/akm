// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../../../src/core/config/config";
import { getLockfilePath } from "../../../src/core/paths";
import {
  applyTaskTargetRefMigration,
  planTaskTargetRefMigration,
} from "../../../src/migrate/legacy/task-target-ref-migration";
import { makeSandboxDir, sandboxXdgDataHome } from "../../_helpers/sandbox";

function configFor(
  bundles: Record<string, { path?: string; git?: string; npm?: string; registryId?: string; writable?: boolean }>,
  defaultBundle = "stash",
): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles,
    defaultBundle,
  } as AkmConfig;
}

function writeBundle(root: string, workflow: string, tasks: Record<string, string>): void {
  fs.mkdirSync(path.join(root, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, "workflows", `${workflow}.md`), `# ${workflow}\n`);
  for (const [name, yaml] of Object.entries(tasks)) fs.writeFileSync(path.join(root, "tasks", `${name}.yml`), yaml);
}

test("plans and atomically rewrites only legacy v1 workflow targets while preserving surrounding YAML", () => {
  const sandbox = makeSandboxDir("akm-task-target-migration-unit");
  try {
    const legacy = [
      "# published 0.8 task",
      'schedule: "@daily"',
      "workflow: 'workflow:ship' # preserve this comment",
      'params: \'{"channel":"stable"}\'',
      "enabled: true",
      "",
    ].join("\n");
    const current = ["version: 2", 'schedule: "@daily"', "workflow: workflows/current", "enabled: true", ""].join("\n");
    const manualV2Legacy = [
      "version: 2",
      'schedule: "@daily"',
      "workflow: workflow:operator-owned",
      "enabled: true",
      "",
    ].join("\n");
    writeBundle(sandbox.dir, "ship", {
      legacy,
      current,
      "manual-v2-legacy": manualV2Legacy,
    });

    const plan = planTaskTargetRefMigration(configFor({ stash: { path: sandbox.dir } }));
    expect(plan.rewrites).toHaveLength(1);
    expect(plan.rewrites[0]).toMatchObject({ from: "workflow:ship", to: "workflows/ship" });

    expect(applyTaskTargetRefMigration(plan)).toBe(1);
    expect(fs.readFileSync(path.join(sandbox.dir, "tasks", "legacy.yml"), "utf8")).toBe(
      legacy.replace("'workflow:ship'", "'workflows/ship'"),
    );
    expect(fs.readFileSync(path.join(sandbox.dir, "tasks", "current.yml"), "utf8")).toBe(current);
    expect(fs.readFileSync(path.join(sandbox.dir, "tasks", "manual-v2-legacy.yml"), "utf8")).toBe(manualV2Legacy);
    expect(planTaskTargetRefMigration(configFor({ stash: { path: sandbox.dir } })).rewrites).toEqual([]);
  } finally {
    sandbox.cleanup();
  }
});

test("resolves an origin-qualified legacy target to the configured bundle id", () => {
  const sandbox = makeSandboxDir("akm-task-target-origin-unit");
  try {
    const stash = path.join(sandbox.dir, "stash");
    const team = path.join(sandbox.dir, "team");
    writeBundle(stash, "unused", {
      cross: 'schedule: "@daily"\nworkflow: github:org/team//workflow:ship\nenabled: true\n',
    });
    writeBundle(team, "ship", {});
    const plan = planTaskTargetRefMigration(
      configFor({
        stash: { path: stash, writable: true },
        team: { path: team, registryId: "github:org/team" },
      }),
    );
    expect(plan.rewrites).toHaveLength(1);
    expect(plan.rewrites[0]).toMatchObject({
      from: "github:org/team//workflow:ship",
      to: "team//workflows/ship",
    });
  } finally {
    sandbox.cleanup();
  }
});

test("fails closed for ambiguous origins but rewrites a stale missing workflow target", () => {
  const sandbox = makeSandboxDir("akm-task-target-fail-closed-unit");
  try {
    const stash = path.join(sandbox.dir, "stash");
    const first = path.join(sandbox.dir, "first");
    const second = path.join(sandbox.dir, "second");
    writeBundle(stash, "unused", {
      ambiguous: 'schedule: "@daily"\nworkflow: shared//workflow:ship\nenabled: true\n',
    });
    writeBundle(first, "ship", {});
    writeBundle(second, "ship", {});

    expect(() =>
      planTaskTargetRefMigration(
        configFor({
          stash: { path: stash, writable: true },
          first: { path: first, registryId: "shared" },
          second: { path: second, registryId: "shared" },
        }),
      ),
    ).toThrow(/ambiguous.*shared.*first.*second.*rerun `akm migrate apply`/i);

    fs.writeFileSync(
      path.join(stash, "tasks", "ambiguous.yml"),
      'schedule: "@daily"\nworkflow: workflow:missing\nenabled: true\n',
    );
    const planMissing = planTaskTargetRefMigration(
      configFor({
        stash: { path: stash, writable: true },
        first: { path: first },
        second: { path: second },
      }),
    );
    expect(planMissing.rewrites).toHaveLength(1);
    expect(planMissing.rewrites[0]).toMatchObject({ from: "workflow:missing", to: "workflows/missing" });
  } finally {
    sandbox.cleanup();
  }
});

test("rewrites plain origin-qualified targets containing @ or #", () => {
  const sandbox = makeSandboxDir("akm-task-target-origin-scalars-unit");
  try {
    const stash = path.join(sandbox.dir, "stash");
    const pkg = path.join(sandbox.dir, "pkg");
    const team = path.join(sandbox.dir, "team");
    writeBundle(stash, "unused", {
      npm: "workflow: npm:@scope/pkg//workflow:ship\n",
      github: "workflow: github:owner/repo#v1//workflow:ship\n",
    });
    writeBundle(pkg, "ship", {});
    writeBundle(team, "ship", {});

    const plan = planTaskTargetRefMigration(
      configFor({
        stash: { path: stash, writable: true },
        pkg: { path: pkg, registryId: "npm:@scope/pkg" },
        team: { path: team, registryId: "github:owner/repo#v1" },
      }),
    );
    expect(plan.rewrites.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "github:owner/repo#v1//workflow:ship", to: "team//workflows/ship" },
      { from: "npm:@scope/pkg//workflow:ship", to: "pkg//workflows/ship" },
    ]);
  } finally {
    sandbox.cleanup();
  }
});

test("resolves targets from a lock-materialized read-only bundle without rewriting that bundle", () => {
  const sandbox = makeSandboxDir("akm-task-target-materialized-unit");
  const dataHome = sandboxXdgDataHome();
  try {
    const stash = path.join(sandbox.dir, "stash");
    const materialized = path.join(sandbox.dir, "materialized-team");
    writeBundle(stash, "unused", {
      cross: 'schedule: "@daily"\nworkflow: github:org/team//workflow:ship\nenabled: true\n',
    });
    const readOnlyTask = 'schedule: "@daily"\nworkflow: workflow:ship\nenabled: true\n';
    writeBundle(materialized, "ship", { "read-only": readOnlyTask });
    fs.mkdirSync(path.dirname(getLockfilePath()), { recursive: true });
    fs.writeFileSync(
      getLockfilePath(),
      `${JSON.stringify([
        {
          id: "team",
          source: "git",
          ref: "github:org/team",
          localRoot: materialized,
        },
      ])}\n`,
    );

    const plan = planTaskTargetRefMigration(
      configFor({
        stash: { path: stash, writable: true },
        team: { git: "https://github.com/org/team.git", registryId: "github:org/team" },
      }),
    );
    expect(plan.rewrites).toHaveLength(1);
    expect(plan.rewrites[0]).toMatchObject({ to: "team//workflows/ship" });
    expect(applyTaskTargetRefMigration(plan)).toBe(1);
    expect(fs.readFileSync(path.join(materialized, "tasks", "read-only.yml"), "utf8")).toBe(readOnlyTask);
  } finally {
    dataHome.cleanup();
    sandbox.cleanup();
  }
});

test("rejects symlinked task roots and task files", () => {
  const sandbox = makeSandboxDir("akm-task-target-symlink-unit");
  try {
    const root = path.join(sandbox.dir, "bundle");
    writeBundle(root, "ship", {});
    const realTasks = path.join(sandbox.dir, "real-tasks");
    fs.mkdirSync(realTasks);
    fs.writeFileSync(path.join(realTasks, "ship.yml"), "workflow: workflow:ship\n");
    fs.rmSync(path.join(root, "tasks"), { recursive: true });
    fs.symlinkSync(realTasks, path.join(root, "tasks"), "dir");

    expect(() => planTaskTargetRefMigration(configFor({ stash: { path: root, writable: true } }))).toThrow(
      /tasks.*symbolic link|symbolic.*tasks/i,
    );

    fs.rmSync(path.join(root, "tasks"));
    fs.mkdirSync(path.join(root, "tasks"));
    const victim = path.join(sandbox.dir, "victim.yml");
    fs.writeFileSync(victim, "workflow: workflow:ship\n");
    fs.symlinkSync(victim, path.join(root, "tasks", "ship.yml"));
    expect(() => planTaskTargetRefMigration(configFor({ stash: { path: root, writable: true } }))).toThrow(
      /task migration does not follow symbolic links/i,
    );

    fs.rmSync(path.join(root, "tasks", "ship.yml"));
    fs.writeFileSync(path.join(root, "tasks", "ship.yml"), "workflow: workflow:ship\n");
    fs.rmSync(path.join(root, "workflows", "ship.md"));
    const outsideWorkflow = path.join(sandbox.dir, "outside-workflow.md");
    fs.writeFileSync(outsideWorkflow, "# Outside\n");
    fs.symlinkSync(outsideWorkflow, path.join(root, "workflows", "ship.md"));
    expect(() => planTaskTargetRefMigration(configFor({ stash: { path: root, writable: true } }))).toThrow(
      /resolves outside bundle/i,
    );
  } finally {
    sandbox.cleanup();
  }
});

test("rejects invalid UTF-8 task bytes before planning a rewrite", () => {
  const sandbox = makeSandboxDir("akm-task-target-utf8-unit");
  try {
    writeBundle(sandbox.dir, "ship", {});
    fs.writeFileSync(
      path.join(sandbox.dir, "tasks", "invalid.yml"),
      Buffer.concat([Buffer.from("workflow: workflow:ship\n# "), Buffer.from([0xff])]),
    );
    expect(() => planTaskTargetRefMigration(configFor({ stash: { path: sandbox.dir, writable: true } }))).toThrow(
      /invalid UTF-8/i,
    );
  } finally {
    sandbox.cleanup();
  }
});

test("loops partial writes and propagates file-sync failures without replacing the task", () => {
  const sandbox = makeSandboxDir("akm-task-target-durable-write-unit");
  try {
    const before = "workflow: workflow:ship\n";
    writeBundle(sandbox.dir, "ship", { ship: before });
    const taskPath = path.join(sandbox.dir, "tasks", "ship.yml");
    const plan = planTaskTargetRefMigration(configFor({ stash: { path: sandbox.dir, writable: true } }));

    const originalWrite = fs.writeSync;
    let shortened = false;
    spyOn(fs, "writeSync").mockImplementation(((fd: number, buffer: Uint8Array, offset: number, length: number) => {
      const actualLength = shortened ? length : Math.max(1, Math.floor(length / 2));
      shortened = true;
      return originalWrite(fd, buffer, offset, actualLength);
    }) as typeof fs.writeSync);
    expect(applyTaskTargetRefMigration(plan)).toBe(1);
    expect(shortened).toBe(true);
    expect(fs.readFileSync(taskPath, "utf8")).toBe("workflow: workflows/ship\n");

    fs.writeFileSync(taskPath, before);
    const retryPlan = planTaskTargetRefMigration(configFor({ stash: { path: sandbox.dir, writable: true } }));
    spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (!fs.fstatSync(fd).isDirectory()) throw new Error("injected file fsync failure");
    });
    expect(() => applyTaskTargetRefMigration(retryPlan)).toThrow("injected file fsync failure");
    expect(fs.readFileSync(taskPath, "utf8")).toBe(before);
  } finally {
    sandbox.cleanup();
  }
});

test("retries a failed parent-directory sync after the replacement is already present", () => {
  const sandbox = makeSandboxDir("akm-task-target-directory-sync-unit");
  try {
    writeBundle(sandbox.dir, "ship", { ship: "workflow: workflow:ship\n" });
    const taskPath = path.join(sandbox.dir, "tasks", "ship.yml");
    const plan = planTaskTargetRefMigration(configFor({ stash: { path: sandbox.dir, writable: true } }));
    const originalFsync = fs.fsyncSync;
    let directorySyncAttempts = 0;
    spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) {
        directorySyncAttempts += 1;
        if (directorySyncAttempts === 1) throw new Error("injected parent fsync failure");
      }
      return originalFsync(fd);
    });

    expect(() => applyTaskTargetRefMigration(plan)).toThrow("injected parent fsync failure");
    expect(fs.readFileSync(taskPath, "utf8")).toBe("workflow: workflows/ship\n");
    expect(applyTaskTargetRefMigration(plan)).toBe(0);
    expect(directorySyncAttempts).toBe(2);
  } finally {
    sandbox.cleanup();
  }
});

test.skipIf(process.platform === "win32")("preserves the task YAML mode independently of the process umask", () => {
  const sandbox = makeSandboxDir("akm-task-target-mode-unit");
  const previousUmask = process.umask();
  try {
    writeBundle(sandbox.dir, "ship", { ship: "workflow: workflow:ship\n" });
    const taskPath = path.join(sandbox.dir, "tasks", "ship.yml");
    fs.chmodSync(taskPath, 0o664);
    const plan = planTaskTargetRefMigration(configFor({ stash: { path: sandbox.dir, writable: true } }));

    process.umask(0o077);
    expect(applyTaskTargetRefMigration(plan)).toBe(1);
    expect(fs.statSync(taskPath).mode & 0o777).toBe(0o664);
  } finally {
    process.umask(previousUmask);
    sandbox.cleanup();
  }
});
