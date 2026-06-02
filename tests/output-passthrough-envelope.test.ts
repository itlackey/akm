// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression suite for #484 — schemaVersion + shape discriminator on
// passthrough envelopes (clone, workflow-*, vault-*, etc.). Third-party
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
    const result = { query: "q", summary: "Selected 1", items: [{ source: "stash", ref: "skill:foo" }] };
    const shaped = shapeForCommand("curate", result, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("curate");
    expect(shaped.schemaVersion).toBe(1);
    expect(Array.isArray(shaped.items)).toBe(true);
  });

  it("adds schemaVersion + shape to clone (passthrough)", () => {
    const shaped = shapeForCommand("clone", { ref: "skill:foo", cloned: true }, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("clone");
    expect(shaped.schemaVersion).toBe(1);
  });

  it("adds schemaVersion + shape to workflow-next", () => {
    const result = { run: { id: "abc", status: "active" }, currentStep: { id: "1" } };
    const shaped = shapeForCommand("workflow-next", result, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("workflow-next");
    expect(shaped.schemaVersion).toBe(1);
  });

  it("adds schemaVersion + shape to vault-list", () => {
    const result = { vaults: [{ name: "v1", path: "/should/be/stripped" }] };
    const shaped = shapeForCommand("vault-list", result, "normal") as Record<string, unknown>;
    expect(shaped.shape).toBe("vault-list");
    expect(shaped.schemaVersion).toBe(1);
    // The existing vault-list shaper strips `path` — verify that contract
    // still holds with the new envelope stamp.
    const vaults = shaped.vaults as Array<Record<string, unknown>>;
    expect(vaults[0]).not.toHaveProperty("path");
    expect(vaults[0].name).toBe("v1");
  });

  it("adds schemaVersion + shape to vault-create / vault-set (passthrough)", () => {
    const created = shapeForCommand("vault-create", { ref: "vault:x", created: true }, "normal") as Record<
      string,
      unknown
    >;
    expect(created.shape).toBe("vault-create");
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
