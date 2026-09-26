import { describe, expect, test } from "bun:test";
import {
  registerRegistryProvider,
  resolveRegistryProviderFactory,
  unregisterRegistryProvider,
} from "../src/registry/factory";
import type { RegistryProviderFactory } from "../src/registry/providers/types";
import { resolveSourceProviderFactory } from "../src/sources/provider-factory";

describe("provider-registry", () => {
  test("resolveRegistryProviderFactory returns null for unknown type", () => {
    expect(resolveRegistryProviderFactory("nonexistent-provider-xyz")).toBeNull();
  });

  test("registerRegistryProvider + resolveRegistryProviderFactory round-trips", () => {
    const factory: RegistryProviderFactory = () => ({
      type: "test-provider",
      search: async () => ({ hits: [] }),
    });
    // The registry provider map (src/registry/factory.ts) is a
    // module-level singleton Map, so a leaked registration here would outlive
    // this test for the rest of the process. Use the real unregister seam
    // (ISOLATION-04) to restore "unregistered" exactly.
    expect(resolveRegistryProviderFactory("test-roundtrip")).toBeNull();
    registerRegistryProvider("test-roundtrip", factory);
    try {
      expect(resolveRegistryProviderFactory("test-roundtrip")).toBe(factory);
    } finally {
      unregisterRegistryProvider("test-roundtrip");
    }
  });

  test("static-index is registered after import", async () => {
    // Importing triggers self-registration
    await import("../src/registry/providers/static-index");
    expect(resolveRegistryProviderFactory("static-index")).not.toBeNull();
  });

  test("skills-sh is registered after import", async () => {
    await import("../src/registry/providers/skills-sh");
    expect(resolveRegistryProviderFactory("skills-sh")).not.toBeNull();
  });

  test("source provider factories resolve the four supported kinds and nothing else", () => {
    for (const kind of ["filesystem", "git", "npm", "website"]) {
      expect(resolveSourceProviderFactory(kind)).not.toBeNull();
    }
    expect(resolveSourceProviderFactory("github")).toBeNull();
  });
});
