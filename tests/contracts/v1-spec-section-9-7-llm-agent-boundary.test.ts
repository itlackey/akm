import { describe, expect, test } from "bun:test";
import { extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §9.7 — LLM/agent boundary.
//
// Two locked invariants:
//   * In-tree LLM helpers are bounded, single-shot, stateless — no shells,
//     no long-running processes, no caches keyed on prior responses.
//   * External agents are invoked via CLI shell-out only. akm never imports
//     a vendor SDK.

describe("v1 spec §9.7 — LLM/agent boundary", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "### 9.7 LLM/agent boundary");

  test("§9.7 exists in the spec", () => {
    expect(section).not.toBe("");
  });

  test("§9.7 declares in-tree LLM is bounded, single-shot, stateless", () => {
    expect(section).toMatch(/bounded/i);
    expect(section).toMatch(/single-shot/i);
    expect(section).toMatch(/stateless/i);
  });

  test("§9.7 declares external agents are CLI shell-out only", () => {
    // Tolerate markdown line-wrapping by collapsing whitespace + emphasis
    // markers when matching.
    const flat = section.replace(/[*\s]+/g, " ");
    expect(flat).toMatch(/CLI shell-out only/i);
    expect(flat).toMatch(/never imports vendor SDKs/i);
  });

  test("§9.7 names a `llm.features.*` per-call-site gate", () => {
    expect(section).toMatch(/llm\.features\.\*/);
    expect(section).toMatch(/exactly one/i);
  });

  test("§9.7 says crossing the boundary is a contract violation", () => {
    const flat = section.replace(/\s+/g, " ");
    expect(flat).toMatch(/contract violation/i);
  });
});
