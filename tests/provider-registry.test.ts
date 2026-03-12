import { describe, expect, test } from "bun:test";
import { registerProvider, resolveProviderFactory } from "../src/provider-registry";

describe("provider-registry", () => {
  test("resolveProviderFactory returns null for unknown type", () => {
    expect(resolveProviderFactory("nonexistent-provider-xyz")).toBeNull();
  });

  test("registerProvider + resolveProviderFactory round-trips", () => {
    const factory = () => ({
      type: "test-provider",
      search: async () => ({ hits: [] }),
    });
    registerProvider("test-roundtrip", factory);
    expect(resolveProviderFactory("test-roundtrip")).toBe(factory);
  });

  test("static-index is registered after import", async () => {
    // Importing triggers self-registration
    await import("../src/providers/static-index");
    expect(resolveProviderFactory("static-index")).not.toBeNull();
  });

  test("skills-sh is registered after import", async () => {
    await import("../src/providers/skills-sh");
    expect(resolveProviderFactory("skills-sh")).not.toBeNull();
  });
});
