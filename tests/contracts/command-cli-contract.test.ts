// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { main } from "../../src/cli";
import { commandCommand } from "../../src/commands/command/command-cli";
import { configCommand } from "../../src/commands/config-cli";
import { modelsCommand } from "../../src/commands/models-cli";
import { indexCommand } from "../../src/commands/sources/stash-cli";
import { taskCommand } from "../../src/commands/tasks/tasks-cli";
import { workflowCommand } from "../../src/commands/workflow-cli";

type DynamicCommand = {
  args?: Record<string, { type?: string; required?: boolean }>;
  subCommands?: Record<string, DynamicCommand>;
};

describe("canonical command CLI surface", () => {
  test("registers command run <ref> with one exact argument string", () => {
    const top = main.subCommands as unknown as Record<string, DynamicCommand>;
    expect(top.command).toBe(commandCommand as unknown as DynamicCommand);

    const run = (commandCommand as unknown as DynamicCommand).subCommands?.run;
    expect(run?.args?.ref).toMatchObject({ type: "positional", required: true });
    expect(run?.args?.arguments).toMatchObject({ type: "string" });
    expect(run?.args?.["dry-run"]).toMatchObject({ type: "boolean", default: false });
  });
});

// P2b Lane B (spec docs/plans/specs/p2b-input-bindings.md §1.2 binding, §7
// F-B3): the contract must be extended in the SAME commit that registers a
// new verb. `akm task explain` (B-N4) is read-only introspection — a `ref`
// positional plus the global `format` flag (GLOBAL_OUTPUT_ARGS,
// src/cli/shared.ts), like every defineJsonCommand leaf.
// #955: the contract must be extended in the SAME commit that registers a
// new flag. `akm index --reembed` forces a full purge + re-embed, bypassing
// the embedding-fingerprint-rename canary.
describe("canonical index CLI surface", () => {
  test("registers index --reembed as a boolean flag defaulting to false", () => {
    const top = main.subCommands as unknown as Record<string, DynamicCommand>;
    expect(top.index).toBe(indexCommand as unknown as DynamicCommand);
    expect((indexCommand as unknown as DynamicCommand).args?.reembed).toMatchObject({
      type: "boolean",
      default: false,
    });
  });

  // #956: the contract must be extended in the SAME commit that registers a
  // new flag. `akm index --skip-if-locked` mirrors `akm improve
  // --skip-if-locked` — a scheduled/opportunistic run steps aside (exit 0)
  // instead of contending with a rebuild already in progress.
  test("registers index --skip-if-locked as a boolean flag defaulting to false", () => {
    const top = main.subCommands as unknown as Record<string, DynamicCommand>;
    expect(top.index).toBe(indexCommand as unknown as DynamicCommand);
    expect((indexCommand as unknown as DynamicCommand).args?.["skip-if-locked"]).toMatchObject({
      type: "boolean",
      default: false,
    });
  });
});

describe("canonical task CLI surface", () => {
  test("registers task explain <ref> with a format flag", () => {
    const top = main.subCommands as unknown as Record<string, DynamicCommand>;
    expect(top.task).toBe(taskCommand as unknown as DynamicCommand);

    const explain = (taskCommand as unknown as DynamicCommand).subCommands?.explain;
    expect(explain?.args?.ref).toMatchObject({ type: "positional", required: true });
    expect(explain?.args?.format).toMatchObject({ type: "string" });
  });

  // #951: `task list` is a pure delegating alias for `akm search --type task`
  // (0.9.0 removed it as redundant LOGIC — a zero-logic alias re-adds the
  // spelling operators reach for without reintroducing a second
  // implementation). It shares `search`'s own positional/limit/from args.
  test("registers task list with search's query/limit/from args", () => {
    const list = (taskCommand as unknown as DynamicCommand).subCommands?.list;
    expect(list?.args?.query).toMatchObject({ type: "positional", required: false });
    expect(list?.args?.limit).toMatchObject({ type: "string" });
    expect(list?.args?.from).toMatchObject({ type: "string" });
  });
});

// P3b Lane B (spec docs/plans/specs/p3b-child-executor.md §1.2 binding, §6
// F-B4): extended in the SAME commit that registers the verb, mirroring this
// file's own "canonical task CLI surface" describe above. `akm workflow plan
// <ref>` is read-only compile+freeze introspection (§4.6) — a `ref`
// positional plus the global `format` flag (GLOBAL_OUTPUT_ARGS,
// src/cli/shared.ts), like every defineJsonCommand leaf. `--json` is
// deliberately NOT a flag anywhere in this CLI (B-N9); every doc example
// spells `--format json`.
describe("canonical workflow CLI surface", () => {
  test("registers workflow plan <ref> with a format flag", () => {
    const top = main.subCommands as unknown as Record<string, DynamicCommand>;
    expect(top.workflow).toBe(workflowCommand as unknown as DynamicCommand);

    const plan = (workflowCommand as unknown as DynamicCommand).subCommands?.plan;
    expect(plan?.args?.ref).toMatchObject({ type: "positional", required: true });
    expect(plan?.args?.format).toMatchObject({ type: "string" });
  });

  // #948: extends improve's --skip-if-locked skip-gracefully semantics to
  // `workflow run` (RUN_LEASE_HELD / STATE_DB_CONTENDED). The contract must
  // be extended in the same commit that registers a new flag.
  test("registers workflow run --skip-if-locked as a boolean flag defaulting to false", () => {
    const top = main.subCommands as unknown as Record<string, DynamicCommand>;
    expect(top.workflow).toBe(workflowCommand as unknown as DynamicCommand);

    const run = (workflowCommand as unknown as DynamicCommand).subCommands?.run;
    expect(run?.args?.target).toMatchObject({ type: "positional", required: true });
    expect(run?.args?.["skip-if-locked"]).toMatchObject({ type: "boolean", default: false });
  });

  // #942: `--all-scopes` on `list` and `status` (the ref fallthrough path) —
  // the contract must be extended in the same commit that registers a flag.
  test("registers workflow list/status --all-scopes as a boolean flag defaulting to false", () => {
    const top = main.subCommands as unknown as Record<string, DynamicCommand>;
    expect(top.workflow).toBe(workflowCommand as unknown as DynamicCommand);

    const list = (workflowCommand as unknown as DynamicCommand).subCommands?.list;
    expect(list?.args?.["all-scopes"]).toMatchObject({ type: "boolean", default: false });

    const status = (workflowCommand as unknown as DynamicCommand).subCommands?.status;
    expect(status?.args?.target).toMatchObject({ type: "positional", required: true });
    expect(status?.args?.["all-scopes"]).toMatchObject({ type: "boolean", default: false });
  });
});

// #945: `akm config diff <ref>` (new verb) and `akm config get --show-source`
// (new flag on an existing Stable verb) — contract extended in the same
// commit that registers them, per this file's own header comment.
describe("canonical config CLI surface", () => {
  test("registers config diff <ref> and config get --show-source", () => {
    const top = main.subCommands as unknown as Record<string, DynamicCommand>;
    expect(top.config).toBe(configCommand as unknown as DynamicCommand);

    const diff = (configCommand as unknown as DynamicCommand).subCommands?.diff;
    expect(diff?.args?.ref).toMatchObject({ type: "positional", required: true });

    const get = (configCommand as unknown as DynamicCommand).subCommands?.get;
    expect(get?.args?.key).toMatchObject({ type: "positional", required: true });
    expect(get?.args?.["show-source"]).toMatchObject({ type: "boolean", default: false });
  });
});

// #946: `akm models list` (new verb) — contract extended in the same commit
// that registers it, per this file's own header comment. Read-only, no
// arguments beyond the global `format`/`detail`/`shape` flags every
// defineJsonCommand leaf already carries.
describe("canonical models CLI surface", () => {
  test("registers models list alongside copy-defaults", () => {
    const top = main.subCommands as unknown as Record<string, DynamicCommand>;
    expect(top.models).toBe(modelsCommand as unknown as DynamicCommand);

    const list = (modelsCommand as unknown as DynamicCommand).subCommands?.list;
    expect(list?.args?.format).toMatchObject({ type: "string" });
    expect((modelsCommand as unknown as DynamicCommand).subCommands?.["copy-defaults"]).toBeDefined();
  });
});
