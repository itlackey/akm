// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-A gate (re-pinned for the registry-wiring WI) — the format-family adapter
 * registry (`src/core/adapter/registry.ts`) + the built-in barrel
 * (`src/core/adapter/adapters/index.ts`).
 *
 * The registry is now a STATIC, FROZEN map (normative §12.6): `getAdapters()` /
 * `adapterForId()` are populated at MODULE LOAD from the frozen
 * `BUILTIN_ADAPTERS` list — NO registration call is required, so production
 * cannot leave the registry empty. The registry is keyed by `adapter.id` ONLY
 * (adapters are format families, §0.2 — no per-`type` mapping). These tests
 * DELIBERATELY perform no setup: they prove the registry is live at import.
 */

import { describe, expect, test } from "bun:test";
import { BUILTIN_ADAPTERS, okfAdapter, registerBuiltinAdapters } from "../../../src/core/adapter/adapters";
import { adapterForId, getAdapters, resetAdapterRegistryForTests } from "../../../src/core/adapter/registry";

/** The frozen §1.2 probe order (array order == probe precedence). */
const PROBE_ORDER = [
  "website-snapshot",
  "agent-skills",
  "claude",
  "opencode",
  "dotenv",
  "akm-workflow",
  "akm-task",
  "llm-wiki",
  "okf",
  "akm",
  "generic-files",
];

describe("adapter registry — static frozen map (normative §12.6)", () => {
  test("getAdapters() is populated at module load — no registration call required", () => {
    // No resetAdapterRegistryForTests()/registerBuiltinAdapters() ran in this
    // file; the registry is live purely from importing it. This is the exact
    // production guarantee that was previously broken (empty registry ⇒ every
    // source fell back to `akm`).
    expect(getAdapters().length).toBe(11);
    expect(getAdapters().map((a) => a.id)).toEqual(PROBE_ORDER);
  });

  test("BUILTIN_ADAPTERS is the frozen §1.2 probe order and matches getAdapters()", () => {
    expect(Object.isFrozen(BUILTIN_ADAPTERS)).toBe(true);
    expect(BUILTIN_ADAPTERS.map((a) => a.id)).toEqual(PROBE_ORDER);
    expect(getAdapters().map((a) => a.id)).toEqual(BUILTIN_ADAPTERS.map((a) => a.id));
  });

  test("adapterForId resolves each built-in id; the okf handle is the registered instance", () => {
    for (const id of PROBE_ORDER) {
      expect(adapterForId(id)?.id).toBe(id);
    }
    expect(adapterForId("okf")).toBe(okfAdapter);
  });

  test("adapterForId returns undefined for an unknown id (spec §4 — caller skips + warns)", () => {
    expect(adapterForId("nope")).toBeUndefined();
  });

  test("getAdapters returns a fresh snapshot — mutating it does not affect the registry", () => {
    const snapshot = getAdapters();
    snapshot.length = 0;
    snapshot.push(okfAdapter);
    expect(getAdapters().length).toBe(11);
    expect(getAdapters().map((a) => a.id)).toEqual(PROBE_ORDER);
  });
});

describe("deprecated test shims are no-ops compatible with the static map", () => {
  test("resetAdapterRegistryForTests() does NOT empty the registry (static, always populated)", () => {
    resetAdapterRegistryForTests();
    expect(getAdapters().length).toBe(11);
    expect(adapterForId("okf")).toBe(okfAdapter);
  });

  test("registerBuiltinAdapters() is an idempotent no-op — never duplicates", () => {
    registerBuiltinAdapters();
    registerBuiltinAdapters();
    expect(getAdapters().length).toBe(11);
    expect(getAdapters().filter((a) => a.id === "okf")).toHaveLength(1);
  });
});
