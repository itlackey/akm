// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { schedulerBindingNativeId } from "../src/tasks/scheduler-binding";
import {
  assertSchedulerSourceSnapshot,
  finalizeSchedulerSyncPlan,
  prepareSchedulerSyncSourceSet,
  type SchedulerSyncPlanInput,
} from "../src/tasks/scheduler-sync";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;

function sourceInput(overrides: Partial<SchedulerSyncPlanInput> = {}): SchedulerSyncPlanInput {
  return {
    sourceRoot: storage.stashDir,
    adapterId: "akm",
    bundleName: "stash",
    backend: "cron",
    installed: [],
    nativeArtifacts: [],
    ...overrides,
  };
}

function writeTask(id: string, source: string | Uint8Array): string {
  const file = path.join(storage.stashDir, "tasks", `${id}.yml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}

/** `workflows/release.yml` (real, scheduled) plus `workflows/release.md -> ../sources/release.md`. */
function writeReleaseWorkflowWithSymlinkedSibling(): void {
  fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(storage.stashDir, "sources"), { recursive: true });
  fs.writeFileSync(
    path.join(storage.stashDir, "workflows", "release.yml"),
    "name: release\non:\n  schedule:\n    - cron: '0 8 * * 1'\njobs:\n  main:\n    runs-on: [self-hosted]\n    steps:\n      - id: release\n        run: echo release\n",
  );
  fs.writeFileSync(path.join(storage.stashDir, "sources", "release.md"), "# release\n");
  fs.symlinkSync(
    path.join(storage.stashDir, "sources", "release.md"),
    path.join(storage.stashDir, "workflows", "release.md"),
  );
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  fs.mkdirSync(path.join(storage.stashDir, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(storage.stashDir, "scripts"), { recursive: true });
  for (const name of ["first.sh", "original.sh", "raced.sh"]) {
    fs.writeFileSync(path.join(storage.stashDir, "scripts", name), "#!/bin/sh\nexit 0\n");
  }
});

afterEach(() => storage.cleanup());

describe("guarded scheduler source byte snapshots", () => {
  test("rejects an original-to-raced-to-original ABA and never compiles the transient task bytes", async () => {
    writeTask("a", 'version: 4\nuses: scripts/first.sh\nschedule: "0 1 * * *"\n');
    const original = 'version: 4\nuses: scripts/original.sh\nschedule: "0 2 * * *"\n';
    const raced = 'version: 4\nuses: scripts/raced.sh\nschedule: "59 23 * * *"\n';
    const beta = writeTask("b", original);

    await expect(
      prepareSchedulerSyncSourceSet(
        sourceInput({
          async resolveAsset({ name }) {
            if (name === "first.sh") fs.writeFileSync(beta, raced);
            if (name === "raced.sh" || name === "original.sh") fs.writeFileSync(beta, original);
            return path.join(storage.stashDir, "scripts", name);
          },
        }),
      ),
    ).rejects.toThrow(/source|read set|changed|ABA|identity/i);
  });

  test("rejects invalid UTF-8 task bytes before parsing or scheduler mutation", async () => {
    writeTask("invalid", Uint8Array.from([0x76, 0x65, 0x72, 0x73, 0x69, 0x6f, 0x6e, 0x3a, 0x20, 0xff]));

    await expect(prepareSchedulerSyncSourceSet(sourceInput())).rejects.toThrow(/invalid UTF-8/i);
  });

  test("rejects a symbolic authored source at the no-follow guarded read boundary", async () => {
    const owner = path.join(storage.root, "owner.yml");
    fs.writeFileSync(owner, "version: 4\nrun: echo owner\n");
    fs.symlinkSync(owner, path.join(storage.stashDir, "tasks", "linked.yml"));

    await expect(prepareSchedulerSyncSourceSet(sourceInput())).rejects.toThrow(/symbolic|outside|identity/i);
  });

  test("final source CAS rejects an inode replacement even when replacement bytes are identical", async () => {
    const file = writeTask("alpha", "version: 4\nrun: echo alpha\n");
    const prepared = await prepareSchedulerSyncSourceSet(sourceInput());
    const replacement = path.join(storage.stashDir, "tasks", ".alpha-replacement.yml");
    fs.writeFileSync(replacement, fs.readFileSync(file));
    fs.renameSync(replacement, file);

    expect(() => assertSchedulerSourceSnapshot(prepared.sourceSnapshot)).toThrow(/changed|identity|read set/i);
  });

  test("final source CAS rejects an authored-directory ancestor swap through a symlink", async () => {
    const source = "version: 4\nrun: echo alpha\n";
    writeTask("alpha", source);
    const prepared = await prepareSchedulerSyncSourceSet(sourceInput());
    const taskRoot = path.join(storage.stashDir, "tasks");
    const priorRoot = path.join(storage.stashDir, "tasks-prior");
    const outsideRoot = path.join(storage.root, "outside-tasks");
    fs.mkdirSync(outsideRoot);
    fs.writeFileSync(path.join(outsideRoot, "alpha.yml"), source);
    fs.renameSync(taskRoot, priorRoot);
    fs.symlinkSync(outsideRoot, taskRoot, "dir");

    expect(() => assertSchedulerSourceSnapshot(prepared.sourceSnapshot)).toThrow(/outside|symbolic|changed|identity/i);
  });

  test("an unscoped sync plan succeeds through a root-level in-bundle symlink when the bundle has no tasks", async () => {
    fs.writeFileSync(path.join(storage.stashDir, "AGENTS.md"), "agents\n");
    fs.symlinkSync(path.join(storage.stashDir, "AGENTS.md"), path.join(storage.stashDir, "CLAUDE.md"));

    const prepared = await prepareSchedulerSyncSourceSet(sourceInput());

    expect(prepared.desired).toEqual([]);
    expect(prepared.failures).toEqual([]);
  });

  test("tasks still sync when the bundle root also holds an in-bundle symlink", async () => {
    writeTask("alpha", 'version: 4\nrun: echo alpha\nschedule: "0 1 * * *"\n');
    fs.writeFileSync(path.join(storage.stashDir, "AGENTS.md"), "agents\n");
    fs.symlinkSync(path.join(storage.stashDir, "AGENTS.md"), path.join(storage.stashDir, "CLAUDE.md"));

    const prepared = await prepareSchedulerSyncSourceSet(sourceInput());

    expect(prepared.desired.map((binding) => binding.id)).toHaveLength(1);
  });

  test("refuses when the bundle root's tasks entry is itself an in-bundle symlink", async () => {
    fs.rmSync(path.join(storage.stashDir, "tasks"), { recursive: true, force: true });
    const realTasks = path.join(storage.stashDir, "real-tasks");
    fs.mkdirSync(realTasks);
    fs.writeFileSync(path.join(realTasks, "alpha.yml"), 'version: 4\nrun: echo alpha\nschedule: "0 1 * * *"\n');
    fs.symlinkSync(realTasks, path.join(storage.stashDir, "tasks"), "dir");

    await expect(prepareSchedulerSyncSourceSet(sourceInput())).rejects.toThrow(/symbolic|symlink|identity|no.follow/i);
  });

  test("a granted in-bundle symlinked task source is reported as a per-source failure, not scheduled", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "sources"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "sources", "nightly.yml"),
      'version: 4\nrun: echo nightly\nschedule: "0 1 * * *"\n',
    );
    fs.symlinkSync(
      path.join(storage.stashDir, "sources", "nightly.yml"),
      path.join(storage.stashDir, "tasks", "nightly.yml"),
    );

    const prepared = await prepareSchedulerSyncSourceSet(sourceInput());

    expect(prepared.desired).toEqual([]);
    expect(prepared.failures).toHaveLength(1);
    expect(prepared.failures[0]?.ref).toBe("stash//tasks/nightly");
    expect(prepared.failures[0]?.reason).toMatch(/symbolic/);
  });

  test("the same symlinked task source layout produces no failure when it is not granted", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "sources"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "sources", "nightly.yml"),
      'version: 4\nrun: echo nightly\nschedule: "0 1 * * *"\n',
    );
    fs.symlinkSync(
      path.join(storage.stashDir, "sources", "nightly.yml"),
      path.join(storage.stashDir, "tasks", "nightly.yml"),
    );

    const prepared = await prepareSchedulerSyncSourceSet(sourceInput({ enabledRefs: new Set() }));

    expect(prepared.desired).toEqual([]);
    expect(prepared.failures).toEqual([]);
  });

  test("a granted in-bundle symlinked workflow source is reported as a per-source failure, not scheduled", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "workflows"), { recursive: true });
    fs.mkdirSync(path.join(storage.stashDir, "sources"), { recursive: true });
    fs.writeFileSync(path.join(storage.stashDir, "sources", "nightly.md"), "# nightly\n");
    fs.symlinkSync(
      path.join(storage.stashDir, "sources", "nightly.md"),
      path.join(storage.stashDir, "workflows", "nightly.md"),
    );

    const prepared = await prepareSchedulerSyncSourceSet(sourceInput());

    expect(prepared.desired).toEqual([]);
    expect(prepared.failures).toHaveLength(1);
    expect(prepared.failures[0]?.ref).toBe("stash//workflows/nightly");
    expect(prepared.failures[0]?.reason).toMatch(/symbolic/);
  });

  test("a real scheduled workflow with a symlinked sibling of the same name is reported once and not scheduled", async () => {
    writeReleaseWorkflowWithSymlinkedSibling();

    const prepared = await prepareSchedulerSyncSourceSet(sourceInput());

    expect(prepared.desired).toEqual([]);
    expect(prepared.failures).toHaveLength(1);
    expect(prepared.failures[0]?.ref).toBe("stash//workflows/release");
    expect(prepared.failures[0]?.reason).toMatch(/symbolic/);
  });

  test("the same workflow sibling layout contributes nothing when it is not granted", async () => {
    writeReleaseWorkflowWithSymlinkedSibling();

    const prepared = await prepareSchedulerSyncSourceSet(sourceInput({ enabledRefs: new Set() }));

    expect(prepared.desired).toEqual([]);
    expect(prepared.failures).toEqual([]);
  });

  test("coherent inspection rejects two exact artifacts for one normalized native key", async () => {
    writeTask("alpha", 'version: 4\nrun: echo alpha\nschedule: "0 1 * * *"\n');
    const prepared = await prepareSchedulerSyncSourceSet(sourceInput());
    const desired = prepared.desired[0]!;
    const nativeId = schedulerBindingNativeId(desired);
    const artifact = {
      nativeId,
      bindingId: desired.id,
      invocation: desired.invocation,
      fingerprint: "same-fingerprint",
    } as const;
    const installed = {
      id: desired.id,
      nativeId,
      binding: ["/test/akm"],
      contextPath: "/test/context.json",
      signature: artifact.fingerprint,
      target: "stash",
      invocation: desired.invocation,
    } as const;

    expect(() =>
      finalizeSchedulerSyncPlan(
        sourceInput({
          installed: [installed],
          nativeArtifacts: [artifact, { ...artifact }],
          inspection: { installed: [installed], artifacts: [artifact, { ...artifact }] },
          expectedSignature: () => artifact.fingerprint,
        }),
        prepared,
      ),
    ).toThrow(/cardinality|duplicate|exactly one|collision/i);
  });
});
