// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression suite for #484 — schemaVersion + shape discriminator on
// passthrough envelopes (clone, workflow-*, env-*, etc.). Third-party
// consumers parsing `akm --format=json` output rely on these fields to
// pin a schema version and dispatch on the response shape.
//
// NOTE: `curate` is no longer a passthrough — WS2 (0.8) gave it a dedicated
// shape that honors --detail/--shape. Its envelope still carries
// `schemaVersion`/`shape: "curate"`; the generic passthrough cases below use
// `clone` (still a passthrough) as the representative command.

import { describe, expect, it } from "bun:test";
import { shapeForCommand } from "../src/output/shapes";

describe("passthrough envelope stamping (#484)", () => {
  it("adds schemaVersion + shape to curate responses", () => {
    const result = { query: "q", summary: "Selected 1", items: [{ source: "stash", ref: "skills/foo" }] };
    const shaped = shapeForCommand("curate", result, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("curate");
    expect(shaped.schemaVersion).toBe(1);
    expect(Array.isArray(shaped.items)).toBe(true);
  });

  it("adds schemaVersion + shape to clone (passthrough)", () => {
    const shaped = shapeForCommand("clone", { ref: "skills/foo", cloned: true }, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("clone");
    expect(shaped.schemaVersion).toBe(1);
  });

  it("adds schemaVersion + shape to workflow-next", () => {
    const result = { run: { id: "abc", status: "active" }, currentStep: { id: "1" } };
    const shaped = shapeForCommand("workflow-next", result, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("workflow-next");
    expect(shaped.schemaVersion).toBe(1);
  });

  it("adds schemaVersion + shape to env-list", () => {
    const result = { envs: [{ name: "v1", path: "/should/be/stripped" }] };
    const shaped = shapeForCommand("env-list", result, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("env-list");
    expect(shaped.schemaVersion).toBe(1);
    // The env-list shaper strips `path` — verify that contract still holds
    // with the envelope stamp.
    const envs = shaped.envs as Array<Record<string, unknown>>;
    expect(envs[0]).not.toHaveProperty("path");
    expect(envs[0].name).toBe("v1");
  });

  it("adds schemaVersion + shape to env-create (passthrough)", () => {
    const created = shapeForCommand("env-create", { ref: "env/x", created: true }, "normal") as Record<string, unknown>;
    expect(created.shape).toBe("env-create");
    expect(created.schemaVersion).toBe(1);
  });

  it("respects existing schemaVersion / shape fields (idempotent)", () => {
    const result = { schemaVersion: 7, shape: "custom-shape", payload: 42 };
    const shaped = shapeForCommand("clone", result, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("custom-shape");
    expect(shaped.schemaVersion).toBe(7);
  });

  it("does not stamp non-object passthrough results", () => {
    // Some passthrough commands might return arrays or primitives — leave them
    // alone so callers that return naked arrays still work.
    const arr = shapeForCommand("clone", [1, 2, 3], "normal");
    expect(arr).toEqual([1, 2, 3]);
    const nullish = shapeForCommand("clone", null, "normal");
    expect(nullish).toBeNull();
  });

  // Stable-keys regression net for the four workflow driver-protocol envelopes
  // that scripts pin (`workflow brief`/`report`/`run`/`watch`): the stamp is
  // purely additive (adds shape + schemaVersion, preserves the `ok` flag), and
  // the full top-level key set is frozen so a rename/drop is caught here.
  it("workflow-brief: preserves ok + all top-level keys; adds shape + schemaVersion", () => {
    const brief = {
      ok: true,
      run: { id: "r1", status: "active" },
      spineToken: "r1#build#l1#2026-01-01T00:00:00Z:u0",
      active: true,
      workList: { isFanOut: false, reducer: null, itemCount: 0, units: [] },
      reportGuidance: { checkin: "c", failure: "f", note: "n" },
      staleUnits: [],
      warnings: [],
      message: "1 unit ready",
    };
    const shaped = shapeForCommand("workflow-brief", brief, "normal") as Record<string, unknown>;
    expect(shaped.ok).toBe(true);
    expect(shaped.shape).toBe("workflow-brief");
    expect(shaped.schemaVersion).toBe(1);
    expect(Object.keys(shaped).sort()).toEqual(
      [
        "active",
        "message",
        "ok",
        "reportGuidance",
        "run",
        "schemaVersion",
        "shape",
        "spineToken",
        "staleUnits",
        "warnings",
        "workList",
      ].sort(),
    );
  });

  it("workflow-report: preserves ok + all top-level keys; adds shape + schemaVersion", () => {
    const report = {
      ok: true,
      runId: "r1",
      stepId: "s1",
      unitId: "s1:solo",
      status: "completed",
      gateLoop: 1,
      recorded: "written",
      remainingUnits: 0,
      runStatus: "completed",
      message: "unit recorded",
    };
    const shaped = shapeForCommand("workflow-report", report, "normal") as Record<string, unknown>;
    expect(shaped.ok).toBe(true);
    expect(shaped.shape).toBe("workflow-report");
    expect(shaped.schemaVersion).toBe(1);
    expect(Object.keys(shaped).sort()).toEqual(
      [
        "gateLoop",
        "message",
        "ok",
        "recorded",
        "remainingUnits",
        "runId",
        "runStatus",
        "schemaVersion",
        "shape",
        "status",
        "stepId",
        "unitId",
      ].sort(),
    );
  });

  it("workflow-run: preserves run + executed top-level keys; adds shape + schemaVersion", () => {
    // The run envelope carries no `ok` flag — its shape is `{ run, executed }`
    // (plus optional `done`/`gateRejection`). Pin the required keys.
    const runResult = {
      run: { id: "r1", status: "active" },
      executed: [{ stepId: "s1", ok: true, unitCount: 1, failedUnits: 0, summary: "done" }],
    };
    const shaped = shapeForCommand("workflow-run", runResult, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("workflow-run");
    expect(shaped.schemaVersion).toBe(1);
    expect(Object.keys(shaped).sort()).toEqual(["executed", "run", "schemaVersion", "shape"].sort());
  });

  it("workflow-watch: preserves ok + all top-level keys; adds shape + schemaVersion", () => {
    const watch = {
      ok: true,
      runId: "r1",
      status: "completed",
      eventCount: 3,
      lastEventId: 42,
      streamed: false,
    };
    const shaped = shapeForCommand("workflow-watch", watch, "normal") as Record<string, unknown>;
    expect(shaped.ok).toBe(true);
    expect(shaped.shape).toBe("workflow-watch");
    expect(shaped.schemaVersion).toBe(1);
    expect(Object.keys(shaped).sort()).toEqual(
      ["eventCount", "lastEventId", "ok", "runId", "schemaVersion", "shape", "status", "streamed"].sort(),
    );
  });

  it("does NOT change shaped commands' brief-detail contract", () => {
    // search / show / proposal-* gate schemaVersion to full per existing
    // contract — stamping should NOT bleed into those at brief.
    const result = {
      hits: [],
      mode: "keyword" as const,
    };
    const shaped = shapeForCommand("search", result, "brief") as Record<string, unknown>;
    expect(shaped).not.toHaveProperty("schemaVersion");
  });
});
