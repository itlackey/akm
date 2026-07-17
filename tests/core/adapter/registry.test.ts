// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-2.1/2.2 — `src/core/adapter/registry.ts` (D2-2): register/get/lookup
 * API, plus `adapters/index.ts#registerBuiltinAdapters` wiring the adapters
 * minted so far (WI-2.1: skill/wiki/script; WI-2.2: workflow/task) through
 * it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  BUILTIN_ADAPTERS,
  registerBuiltinAdapters,
  scriptAdapter,
  skillAdapter,
  wikiAdapter,
} from "../../../src/core/adapter/adapters";
import {
  adapterForFile,
  adapterForId,
  adapterForType,
  getAdapters,
  registerAdapter,
  resetAdapterRegistryForTests,
  typesForAdapter,
} from "../../../src/core/adapter/registry";
import type { BundleComponent } from "../../../src/core/adapter/types";
import { buildFileContext } from "../../../src/indexer/walk/file-context";

afterEach(() => {
  resetAdapterRegistryForTests();
});

describe("registry — registerAdapter / getAdapters", () => {
  test("registerAdapter(a) defaults types to [a.id]; getAdapters() returns registration order", () => {
    registerAdapter(skillAdapter);
    registerAdapter(wikiAdapter);
    registerAdapter(scriptAdapter);

    expect(getAdapters().map((a) => a.id)).toEqual(["skill", "wiki", "script"]);
    expect(typesForAdapter("skill")).toEqual(["skill"]);
    expect(typesForAdapter("wiki")).toEqual(["wiki"]);
    expect(typesForAdapter("script")).toEqual(["script"]);
  });

  test("re-registering the same adapter id replaces the entry in place (no duplicate in getAdapters())", () => {
    registerAdapter(skillAdapter);
    registerAdapter(skillAdapter);
    registerAdapter(wikiAdapter);
    expect(getAdapters().map((a) => a.id)).toEqual(["skill", "wiki"]);
  });

  test("a multi-type registration (forward-compatible with WI-2.2..2.4's grouped adapters) populates adapterForType for every listed type", () => {
    registerAdapter(skillAdapter, ["skill"]);
    // Simulates a future dotenv-shaped adapter registering 2 types under one id.
    const fakeDotenv = { ...skillAdapter, id: "dotenv" };
    registerAdapter(fakeDotenv, ["env", "secret"]);

    expect(adapterForType("env")?.id).toBe("dotenv");
    expect(adapterForType("secret")?.id).toBe("dotenv");
    expect(typesForAdapter("dotenv")).toEqual(["env", "secret"]);
  });
});

describe("registry — adapterForId / adapterForType", () => {
  test("adapterForId resolves the registered adapter by its own id", () => {
    registerAdapter(skillAdapter);
    expect(adapterForId("skill")).toBe(skillAdapter);
    expect(adapterForId("nonexistent")).toBeUndefined();
  });

  test("adapterForType resolves by owned asset type, not adapter id", () => {
    registerAdapter(skillAdapter);
    registerAdapter(wikiAdapter);
    registerAdapter(scriptAdapter);
    expect(adapterForType("skill")).toBe(skillAdapter);
    expect(adapterForType("wiki")).toBe(wikiAdapter);
    expect(adapterForType("script")).toBe(scriptAdapter);
    expect(adapterForType("agent")).toBeUndefined(); // not owned by any WI-2.1 adapter
  });
});

describe("registry — adapterForFile (convenience lookup)", () => {
  const STASH_ROOT = path.resolve(__dirname, "../../fixtures/stashes/all-types");

  test("finds the registered adapter whose recognize() claims a given file", () => {
    registerAdapter(skillAdapter);
    registerAdapter(wikiAdapter);
    registerAdapter(scriptAdapter);

    const skillsRoot = path.join(STASH_ROOT, "skills");
    const component: BundleComponent = { id: "skills", adapter: "skill", root: skillsRoot, writable: true };
    const file = buildFileContext(skillsRoot, path.join(skillsRoot, "all-types-skill/SKILL.md"));
    expect(adapterForFile(component, file)?.id).toBe("skill");
  });

  test("returns undefined when no registered adapter claims the file", () => {
    registerAdapter(skillAdapter);
    const scriptsRoot = path.join(STASH_ROOT, "scripts");
    const component: BundleComponent = { id: "scripts", adapter: "skill", root: scriptsRoot, writable: true };
    const file = buildFileContext(scriptsRoot, path.join(scriptsRoot, "all-types-script.sh"));
    expect(adapterForFile(component, file)).toBeUndefined();
  });
});

describe("registry — resetAdapterRegistryForTests", () => {
  test("clears every registered adapter", () => {
    registerAdapter(skillAdapter);
    expect(getAdapters().length).toBe(1);
    resetAdapterRegistryForTests();
    expect(getAdapters()).toEqual([]);
    expect(adapterForId("skill")).toBeUndefined();
    expect(adapterForType("skill")).toBeUndefined();
  });
});

describe("adapters/index.ts — registerBuiltinAdapters wires the 5 WI-2.1/2.2 adapters", () => {
  test("BUILTIN_ADAPTERS lists exactly skill, wiki, script, workflow, task", () => {
    expect(BUILTIN_ADAPTERS.map((a) => a.id)).toEqual(["skill", "wiki", "script", "workflow", "task"]);
  });

  test("registerBuiltinAdapters() registers all 5, each keyed by its own id as its owned type", () => {
    registerBuiltinAdapters();
    expect(
      getAdapters()
        .map((a) => a.id)
        .sort(),
    ).toEqual(["script", "skill", "task", "wiki", "workflow"]);
    expect(adapterForType("skill")?.id).toBe("skill");
    expect(adapterForType("wiki")?.id).toBe("wiki");
    expect(adapterForType("script")?.id).toBe("script");
    expect(adapterForType("workflow")?.id).toBe("workflow");
    expect(adapterForType("task")?.id).toBe("task");
  });
});
