import { describe, expect, test } from "bun:test";
import { extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §5 — Configuration.
//
// The freeze rule:
//   * The JSON schema names `sources[]`, `registries[]`, `embedder`, `scorer`,
//     `agent` (Planned), `llm` + `llm.features` (Planned), and
//     `defaultWriteTarget`.
//   * Value forms: literal or `{ env: "VAR" }`.
//   * `writable: true` is rejected on `website` / `npm`.
//   * Per-provider option schemas validate at config-load time.

describe("v1 spec §5 — configuration", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "## 5. Configuration");

  test("§5 exists in the spec", () => {
    expect(section).not.toBe("");
  });

  test("§5.1 names every locked top-level config key", () => {
    expect(section).toContain('"sources"');
    expect(section).toContain('"registries"');
    expect(section).toContain('"embedder"');
    expect(section).toContain('"scorer"');
    expect(section).toContain('"agent"');
    expect(section).toContain('"llm"');
    expect(section).toContain('"features"');
    expect(section).toContain('"defaultWriteTarget"');
  });

  test("§5.2 declares the literal-or-env value form", () => {
    expect(section).toMatch(/literal/i);
    expect(section).toMatch(/\{\s*"env":\s*"VAR_NAME"\s*\}/);
    expect(section).toMatch(/Missing required env vars produce `ConfigError`/i);
  });

  test("§5.3 declares per-provider option JSON schemas validated at load", () => {
    expect(section).toMatch(/JSON Schema/);
    expect(section).toMatch(/Missing required fields fail at load/i);
  });

  test("§5.4 declares the `writable` defaults and rejection rule", () => {
    expect(section).toMatch(/`true`\s*for\s*`filesystem`/);
    expect(section).toMatch(/`false`\s*for everything else/);
    expect(section).toMatch(/rejected at config load.*for `website` and `npm`/s);
    expect(section).toContain("ConfigError");
  });

  test("§5 stops before §6 (helper boundary check)", () => {
    expect(section).not.toContain("## 6.");
    expect(section).not.toContain("## 7.");
  });
});
