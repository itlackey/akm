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
import { BUILTIN_ADAPTERS, okfAdapter } from "../../../src/core/adapter/adapters";
import {
  adapterForId,
  adapterIds,
  getAdapters,
  requireAdapter,
  requireConfiguredAdapters,
} from "../../../src/core/adapter/registry";
import { ConfigError } from "../../../src/core/errors";

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
  "akm",
  "okf",
  "generic-files",
  "code-project",
  "secret-tool",
  "azure-key-vault",
];

describe("adapter registry — static frozen map (normative §12.6)", () => {
  test("getAdapters() is populated at module load — no registration call required", () => {
    // The registry is live purely from importing it. This is the exact
    // production guarantee that was previously broken (empty registry ⇒ every
    // source fell back to `akm`).
    expect(getAdapters().length).toBe(14);
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
    expect(getAdapters().length).toBe(14);
    expect(getAdapters().map((a) => a.id)).toEqual(PROBE_ORDER);
  });
});

describe("adapter registry — the one list of adapter ids", () => {
  test("adapterIds lists every built-in id in probe order", () => {
    expect(adapterIds()).toEqual(PROBE_ORDER);
  });

  test("requireAdapter returns the adapter, or a ConfigError naming the bundle, the id and the valid ids", () => {
    expect(requireAdapter("docs", "okf")).toBe(okfAdapter);
    let thrown: unknown;
    try {
      requireAdapter("docs", "agent_skills");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).code).toBe("INVALID_CONFIG_FILE");
    expect((thrown as ConfigError).message).toBe(
      `Bundle "docs" names adapter "agent_skills", which akm does not have. Expected one of: ${PROBE_ORDER.join(", ")}.`,
    );
  });

  test("requireConfiguredAdapters refuses a configured bundle with an unknown adapter, and passes known or absent ones", () => {
    const bundles = (adapter?: string) => ({
      configVersion: "0.9.0" as const,
      semanticSearchMode: "auto" as const,
      bundles: { docs: { path: "/tmp/docs", ...(adapter ? { adapter } : {}) } },
    });
    expect(() => requireConfiguredAdapters(bundles("okf"))).not.toThrow();
    expect(() => requireConfiguredAdapters(bundles())).not.toThrow();
    expect(() => requireConfiguredAdapters(bundles("nope"))).toThrow(/Bundle "docs" names adapter "nope"/);
  });
});
