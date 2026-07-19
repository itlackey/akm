import { describe, expect, test } from "bun:test";
import {
  buildProposePrompt,
  buildReflectPrompt,
  buildSchemaRepairPrompt,
  extractDraftConfidence,
} from "../../../src/integrations/agent/prompts";

describe("RESPONSE_CONTRACT_JSON — explicit confidence elicitation", () => {
  test("buildReflectPrompt asks for a self-rated confidence score in [0, 1]", () => {
    const { prompt } = buildReflectPrompt({ ref: "lessons/demo", type: "lesson", name: "demo" });
    expect(prompt).toMatch(/confidence/i);
    expect(prompt).toMatch(/0\.\.1|0\s*[–-]\s*1|\[0,\s*1\]|0\.0-1\.0|0\.0–1\.0/);
    // 0.9.0: the confidence gate is gone — prompts must NOT teach the model
    // that its score drives an automated accept path.
    expect(prompt).not.toMatch(/auto-accept/i);
    expect(prompt).toMatch(/reviewer/i);
  });

  test("buildProposePrompt asks for a self-rated confidence score", () => {
    const prompt = buildProposePrompt({ type: "lesson", name: "demo", task: "test" });
    expect(prompt).toMatch(/confidence/i);
  });

  test("buildSchemaRepairPrompt asks for a self-rated confidence score", () => {
    const prompt = buildSchemaRepairPrompt({
      ref: "lessons/demo",
      type: "lesson",
      name: "demo",
      reason: "missing description",
      assetContent: "body",
    });
    expect(prompt).toMatch(/confidence/i);
  });

  test("file-write contract asks the agent to emit `DRAFT_WRITTEN confidence=<n>`", () => {
    const { prompt } = buildReflectPrompt({
      ref: "lessons/demo",
      type: "lesson",
      name: "demo",
      draftFilePath: "/tmp/x.md",
    });
    expect(prompt).toMatch(/DRAFT_WRITTEN\s+confidence=/);
  });
});

describe("extractDraftConfidence", () => {
  test("returns undefined for empty/missing input", () => {
    expect(extractDraftConfidence(undefined)).toBeUndefined();
    expect(extractDraftConfidence("")).toBeUndefined();
  });

  test("returns undefined when DRAFT_WRITTEN appears without confidence", () => {
    expect(extractDraftConfidence("DRAFT_WRITTEN")).toBeUndefined();
    expect(extractDraftConfidence("agent log\nDRAFT_WRITTEN\nbye")).toBeUndefined();
  });

  test("parses `DRAFT_WRITTEN confidence=0.85`", () => {
    expect(extractDraftConfidence("DRAFT_WRITTEN confidence=0.85")).toBe(0.85);
  });

  test("parses surrounded by log lines", () => {
    const stdout = "info: writing draft...\nDRAFT_WRITTEN confidence=0.92\ndone.\n";
    expect(extractDraftConfidence(stdout)).toBe(0.92);
  });

  test("accepts integer confidences (0 and 1)", () => {
    expect(extractDraftConfidence("DRAFT_WRITTEN confidence=1")).toBe(1);
    expect(extractDraftConfidence("DRAFT_WRITTEN confidence=0")).toBe(0);
  });

  test("rejects out-of-range values", () => {
    expect(extractDraftConfidence("DRAFT_WRITTEN confidence=1.5")).toBeUndefined();
    expect(extractDraftConfidence("DRAFT_WRITTEN confidence=-0.1")).toBeUndefined();
  });

  test("rejects non-numeric values", () => {
    expect(extractDraftConfidence("DRAFT_WRITTEN confidence=high")).toBeUndefined();
  });

  test("returns first match when multiple sentinels appear", () => {
    const stdout = "DRAFT_WRITTEN confidence=0.4\nDRAFT_WRITTEN confidence=0.9";
    expect(extractDraftConfidence(stdout)).toBe(0.4);
  });
});
