// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConsolidationFidelityManifest } from "../scripts/akm-eval/src/consolidation-fidelity";
import {
  CONSOLIDATION_FIDELITY_MODEL,
  createConsolidationFidelityClient,
  renderConsolidationFidelityPrompt,
  runConsolidationFidelityMeasurement,
  writeConsolidationFidelityArtifacts,
} from "../scripts/akm-eval/src/consolidation-fidelity-run";

const manifest = loadConsolidationFidelityManifest();

function fixtureAt(index: number) {
  const fixture = manifest.cases[index];
  if (!fixture) throw new Error(`missing fixture at index ${index}`);
  return fixture;
}

describe("consolidation fidelity measurement runner", () => {
  test("renders a blind generation prompt from sources only", () => {
    const fixture = fixtureAt(0);
    const source = fixture.sources[0];
    if (!source) throw new Error("fixture must contain a source");
    const prompt = renderConsolidationFidelityPrompt(fixture);

    expect(prompt).toContain(source.body);
    expect(prompt).toContain(source.ref);
    expect(prompt).not.toContain(fixture.id);
    expect(prompt).not.toContain(fixture.calibrationCandidate.body);
    expect(prompt).not.toContain("requiredClaims");
    expect(prompt).not.toContain("forbiddenClaims");
  });

  test("uses the fixed qwen request contract", async () => {
    let requestedUrl = "";
    let requestedBody: Record<string, unknown> | undefined;
    const client = createConsolidationFidelityClient({
      endpoint: "http://don.test:1234",
      fetchFn: (async (input, init) => {
        requestedUrl = String(input);
        requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            model: CONSOLIDATION_FIDELITY_MODEL,
            choices: [{ finish_reason: "stop", message: { content: '{"body":"x","directProvenance":[]}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });

    const completion = await client("fixture prompt", fixtureAt(0));

    expect(requestedUrl).toBe("http://don.test:1234/v1/chat/completions");
    expect(requestedBody).toMatchObject({
      model: "qwen/qwen3.5-9b",
      temperature: 0,
      enable_thinking: false,
      response_format: { type: "json_schema" },
    });
    expect(completion).toMatchObject({
      observedModel: CONSOLIDATION_FIDELITY_MODEL,
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  test("aggregates deterministic semantic, provenance, and negation scores", async () => {
    const measurement = await runConsolidationFidelityMeasurement({
      endpoint: "http://don.test:1234",
      manifest,
      manifestPath: "/does/not/exist.json",
      complete: async (_prompt, fixture) => ({
        rawContent: JSON.stringify(fixture.calibrationCandidate),
        observedModel: CONSOLIDATION_FIDELITY_MODEL,
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        durationMs: 1,
      }),
    });

    expect(measurement.status).toBe("conclusive");
    expect(measurement.metrics).toMatchObject({
      caseCount: 9,
      validModelEvidenceCaseCount: 9,
      candidateParseRate: 1,
      oraclePassRate: 4 / 9,
      semanticScore: 9 / 18,
      requiredClaimRetention: 8 / 15,
      forbiddenClaimAvoidance: 1 / 3,
      provenanceScore: 1,
      directProvenanceRetention: 1,
      negationScore: 0,
      usageReportedCaseCount: 9,
      promptTokens: 9,
      completionTokens: 18,
      totalTokens: 27,
    });
  });

  test("marks model identity drift inconclusive and writes auditable artifacts", async () => {
    const fixture = fixtureAt(0);
    const oneCaseManifest = { ...manifest, cases: [fixture] };
    const measurement = await runConsolidationFidelityMeasurement({
      endpoint: "http://don.test:1234/v1",
      manifest: oneCaseManifest,
      manifestPath: "/does/not/exist.json",
      complete: async (_prompt, fixture) => ({
        rawContent: JSON.stringify(fixture.calibrationCandidate),
        observedModel: "another/model",
        usage: {},
        durationMs: 1,
      }),
    });

    expect(measurement.status).toBe("inconclusive");
    expect(measurement.statusReasons[0]).toContain("does not match qwen/qwen3.5-9b");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-consolidation-fidelity-"));
    const out = path.join(root, "run");
    try {
      writeConsolidationFidelityArtifacts(out, measurement);
      const summary = JSON.parse(fs.readFileSync(path.join(out, "eval-result.json"), "utf8")) as Record<
        string,
        unknown
      >;
      const caseLines = fs.readFileSync(path.join(out, "case-results.jsonl"), "utf8").trim().split("\n");
      expect(summary.status).toBe("inconclusive");
      expect(summary).not.toHaveProperty("caseResults");
      expect(caseLines).toHaveLength(1);
      const caseLine = caseLines[0];
      if (!caseLine) throw new Error("missing case result line");
      expect(JSON.parse(caseLine)).toMatchObject({
        fixtureId: fixture.id,
        validModelEvidence: false,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
