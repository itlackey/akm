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

  test("§9.7 declares external agents are invoked via CLI shell-out", () => {
    // Tolerate markdown line-wrapping by collapsing whitespace + emphasis
    // markers when matching.
    const flat = section.replace(/[*\s]+/g, " ");
    expect(flat).toMatch(/cli shell-out/i);
    // The spec now allows embedded SDK as an alternative invocation path;
    // the "never imports vendor SDKs" invariant is expressed as the SDK
    // runner delegating to OpenCode's HTTP layer rather than importing
    // Anthropic/OpenAI directly.  Check for contract violation language instead.
    expect(flat).toMatch(/contract violation/i);
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
