import { describe, expect, test } from "bun:test";
import { buildProposePrompt, buildReflectPrompt, buildSchemaRepairPrompt } from "../../src/integrations/agent/prompts";

describe("explicit confidence elicitation", () => {
  test("buildReflectPrompt asks for a self-rated confidence score in [0, 1]", () => {
    const { prompt } = buildReflectPrompt({ ref: "lessons/demo", type: "lesson", name: "demo" });
    expect(prompt).toMatch(/self-rated quality confidence from 0 to 1/);
    // 0.9.0: the confidence gate is gone — prompts must NOT teach the model
    // that its score drives an automated accept path.
    expect(prompt).not.toMatch(/auto-accept/i);
  });

  test("buildReflectPrompt asks every output mode for the score", () => {
    for (const outputMode of ["json_schema", "framed_markdown"] as const) {
      const { prompt } = buildReflectPrompt({ ref: "lessons/demo", type: "lesson", name: "demo", outputMode });
      expect(prompt).toMatch(/confidence/i);
    }
  });

  // RESPONSE_CONTRACT_JSON, the contract of `proposal new`
  test("buildProposePrompt asks for a self-rated confidence score", () => {
    const prompt = buildProposePrompt({ type: "lesson", name: "demo", task: "test" });
    expect(prompt).toMatch(/confidence/i);
    expect(prompt).toMatch(/0\.\.1|0\s*[–-]\s*1|\[0,\s*1\]|0\.0-1\.0|0\.0–1\.0/);
    expect(prompt).not.toMatch(/auto-accept/i);
    expect(prompt).toMatch(/reviewer/i);
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
});
