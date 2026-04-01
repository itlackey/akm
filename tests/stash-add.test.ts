import { describe, expect, test } from "bun:test";
import { shouldAddAsWebsiteUrl } from "../src/stash-add";

describe("shouldAddAsWebsiteUrl", () => {
  test("treats docs-style URLs as website sources", () => {
    expect(shouldAddAsWebsiteUrl("https://docs.example.com/guide")).toBe(true);
  });

  test("keeps known git hosts on the registry install path", () => {
    expect(shouldAddAsWebsiteUrl("https://gitlab.com/acme/project")).toBe(false);
    expect(shouldAddAsWebsiteUrl("https://example.com/acme/project.git")).toBe(false);
  });
});
