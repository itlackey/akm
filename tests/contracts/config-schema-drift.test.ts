import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const schemaPath = path.join(repoRoot, "schemas", "akm-config.json");

function readSchema(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
}

describe("config schema drift pins", () => {
  test("llm.features includes all locked runtime keys", () => {
    const schema = readSchema();
    const defs = schema.$defs as Record<string, unknown>;
    const llm = defs.LlmConnectionConfig as { allOf?: Array<Record<string, unknown>> };
    const llmProps = (llm.allOf?.[1]?.properties ?? {}) as Record<string, unknown>;
    const features = llmProps.features as { properties?: Record<string, unknown> };
    const keys = Object.keys(features.properties ?? {});

    expect(keys).toEqual([
      "curate_rerank",
      "feedback_distillation",
      "memory_inference",
      "graph_extraction",
      "memory_consolidation",
      "lesson_quality_gate",
      "metadata_enhance",
    ]);
  });

  test("search.graphBoost confidence knobs match runtime", () => {
    const schema = readSchema();
    const props = schema.properties as Record<string, unknown>;
    const search = props.search as { properties?: Record<string, unknown> };
    const graphBoost = search.properties?.graphBoost as { properties?: Record<string, unknown> };
    const confidenceMode = graphBoost.properties?.confidenceMode as { enum?: string[]; default?: string };
    const confidenceWeight = graphBoost.properties?.confidenceWeight as {
      minimum?: number;
      maximum?: number;
      default?: number;
    };

    expect(confidenceMode.enum).toEqual(["off", "blend", "multiply"]);
    expect(confidenceMode.default).toBe("blend");
    expect(confidenceWeight.minimum).toBe(0);
    expect(confidenceWeight.maximum).toBe(1);
    expect(confidenceWeight.default).toBe(0.2);
  });

  test("registry provider docs in schema no longer advertise openviking", () => {
    const schema = readSchema();
    const defs = schema.$defs as Record<string, unknown>;
    const registry = defs.RegistryConfigEntry as { properties?: Record<string, unknown> };
    const provider = registry.properties?.provider as { description?: string; examples?: string[] };

    expect(provider.description ?? "").not.toMatch(/openviking/i);
    expect(provider.examples ?? []).not.toContain("openviking");
  });
});
