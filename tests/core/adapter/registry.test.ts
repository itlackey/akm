// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-A gate — the format-family adapter registry
 * (`src/core/adapter/registry.ts`) + the built-in barrel
 * (`src/core/adapter/adapters/index.ts`).
 *
 * The registry is keyed by `adapter.id` ONLY (no per-`type` mapping — adapters
 * are format families, §0.2). Every test resets the module-level singleton
 * first so the files can run in one bun process without leaking.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { okfAdapter, registerBuiltinAdapters } from "../../../src/core/adapter/adapters";
import type { BundleAdapter } from "../../../src/core/adapter/bundle-adapter";
import {
  adapterForId,
  getAdapters,
  registerAdapter,
  resetAdapterRegistryForTests,
} from "../../../src/core/adapter/registry";

function stub(id: string): BundleAdapter {
  return {
    id,
    version: "0.0.0",
    extensions: [".md"],
    recognize: () => null,
    validate: async () => [],
  };
}

beforeEach(() => {
  resetAdapterRegistryForTests();
});

describe("adapter registry", () => {
  test("register / getAdapters / adapterForId", () => {
    const a = stub("alpha");
    registerAdapter(a);
    expect(getAdapters()).toEqual([a]);
    expect(adapterForId("alpha")).toBe(a);
  });

  test("adapterForId returns undefined for an unregistered id", () => {
    expect(adapterForId("nope")).toBeUndefined();
  });

  test("getAdapters preserves registration order across multiple adapters", () => {
    const a = stub("alpha");
    const b = stub("beta");
    registerAdapter(a);
    registerAdapter(b);
    expect(getAdapters().map((x) => x.id)).toEqual(["alpha", "beta"]);
  });

  test("re-registering the same id replaces in place (no duplicates)", () => {
    const first = stub("dup");
    const second = stub("dup");
    registerAdapter(first);
    registerAdapter(second);
    expect(getAdapters()).toHaveLength(1);
    expect(adapterForId("dup")).toBe(second);
  });

  test("getAdapters returns a snapshot — mutating it does not affect the registry", () => {
    registerAdapter(stub("alpha"));
    const snapshot = getAdapters();
    snapshot.push(stub("injected"));
    expect(getAdapters().map((x) => x.id)).toEqual(["alpha"]);
  });

  test("resetAdapterRegistryForTests clears everything", () => {
    registerAdapter(stub("alpha"));
    resetAdapterRegistryForTests();
    expect(getAdapters()).toEqual([]);
    expect(adapterForId("alpha")).toBeUndefined();
  });
});

describe("registerBuiltinAdapters", () => {
  test("registers the okf adapter onto the registry", () => {
    registerBuiltinAdapters();
    expect(adapterForId("okf")).toBe(okfAdapter);
    expect(getAdapters().map((x) => x.id)).toContain("okf");
  });

  test("is idempotent (re-registering okf does not duplicate)", () => {
    registerBuiltinAdapters();
    registerBuiltinAdapters();
    expect(getAdapters().filter((x) => x.id === "okf")).toHaveLength(1);
  });
});
