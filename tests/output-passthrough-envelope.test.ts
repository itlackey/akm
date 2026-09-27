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

  it("adds schemaVersion + shape to env-list", () => {
    const result = { envs: [{ name: "v1", path: "/should/be/stripped" }] };
    const shaped = shapeForCommand("env-list", result, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("env-list");
    expect(shaped.schemaVersion).toBe(1);
    // The env-list shaper strips `path` — verify that contract still holds
    // with the envelope stamp.
    const envs = shaped.envs as Array<Record<string, unknown>>;
    expect(envs[0]).not.toHaveProperty("path");
    expect(envs[0]!.name).toBe("v1");
  });

  it("adds schemaVersion + shape to env-create (passthrough)", () => {
    const created = shapeForCommand("env-create", { ref: "env/x", created: true }, "normal") as Record<string, unknown>;
    expect(created.shape).toBe("env-create");
    expect(created.schemaVersion).toBe(1);
  });

  it("respects existing schemaVersion / shape fields (idempotent)", () => {
    const result = { schemaVersion: 7, shape: "custom-shape", ok: true, payload: 42 };
    const shaped = shapeForCommand("clone", result, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("custom-shape");
    expect(shaped.schemaVersion).toBe(7);
    expect(shaped.ok).toBe(true);
  });

  // #918: `ok` is absent on most passthrough results (config set/unset,
  // clone, ...) because the caller only reaches `output()` on success — the
  // failure path throws before this handler ever runs. Stamp `ok: true` so a
  // caller branching on `.ok` sees the same field it sees on the
  // `{ok:false,...}` envelope thrown on failure.
  it("stamps ok:true when the result has no ok field", () => {
    const shaped = shapeForCommand("clone", { ref: "skills/foo", cloned: true }, "normal") as Record<string, unknown>;
    expect(shaped.ok).toBe(true);
  });

  // A command that computes its own `ok` (e.g. `task-run`, which derives it
  // from the task's exit code) must keep that value — including `false` —
  // rather than have the generic stamp silently overwrite it with `true`.
  it("preserves an existing ok:false rather than overwriting it with true", () => {
    const shaped = shapeForCommand("task-run", { ok: false, exitCode: 1 }, "normal") as Record<string, unknown>;
    expect(shaped.ok).toBe(false);
  });

  it("preserves an existing ok:true untouched", () => {
    const shaped = shapeForCommand("task-run", { ok: true, exitCode: 0 }, "normal") as Record<string, unknown>;
    expect(shaped.ok).toBe(true);
  });

  // #918: `ok` heads the printed envelope instead of trailing a (possibly
  // large) dump, so `head -3` of a success envelope shows it.
  it("orders a stamped ok first", () => {
    const shaped = shapeForCommand("clone", { ref: "skills/foo", cloned: true }, "normal") as Record<string, unknown>;
    expect(Object.keys(shaped)[0]).toBe("ok");
  });

  it("does not stamp non-object passthrough results", () => {
    // Some passthrough commands might return arrays or primitives — leave them
    // alone so callers that return naked arrays still work.
    const arr = shapeForCommand("clone", [1, 2, 3], "normal");
    expect(arr).toEqual([1, 2, 3]);
    const nullish = shapeForCommand("clone", null, "normal");
    expect(nullish).toBeNull();
  });

  // Stable-keys regression net for the `workflow run` envelope that scripts
  // pin: the stamp is purely additive (adds shape + schemaVersion + ok), and
  // the full top-level key set is frozen so a rename/drop is caught here.
  it("workflow-run: preserves run + executed top-level keys; adds shape + schemaVersion + ok", () => {
    // The run envelope itself carries no top-level `ok` flag — its shape is
    // `{ run, executed }` (plus optional `done`/`gateRejection`); only the
    // per-step entries under `executed` carry their own `ok`. #918: since the
    // top level has none, the generic stamp now adds `ok: true` here too.
    const runResult = {
      run: { id: "r1", status: "active" },
      executed: [{ stepId: "s1", ok: true, unitCount: 1, failedUnits: 0, summary: "done" }],
    };
    const shaped = shapeForCommand("workflow-run", runResult, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("workflow-run");
    expect(shaped.schemaVersion).toBe(1);
    expect(shaped.ok).toBe(true);
    expect(Object.keys(shaped).sort()).toEqual(["executed", "ok", "run", "schemaVersion", "shape"].sort());
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
