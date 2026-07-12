import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ENGINE_NAME_PATTERN_SOURCE } from "../../src/core/config/engine-semantics";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const schemaPath = path.join(repoRoot, "schemas", "akm-config.json");

function readSchema(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
}

describe("config schema drift pins", () => {
  test("requires the exact 0.9.0 configVersion const", () => {
    const root = readSchema();
    const properties = root.properties as Record<string, Record<string, unknown>>;
    expect(properties.configVersion).toEqual({ type: "string", const: "0.9.0" });
    expect(root.required).toContain("configVersion");
  });
  test("ImproveProcessConfig schema includes qualityGate + contradictionDetection sub-objects", () => {
    const schema = readSchema();
    const defs = schema.$defs as Record<string, unknown>;
    const ipc = defs.ImproveProcessConfig as { properties?: Record<string, unknown> };
    const keys = Object.keys(ipc.properties ?? {});
    expect(keys).toContain("qualityGate");
    expect(keys).toContain("contradictionDetection");
  });

  test("ImproveProfileConfig.processes includes distill + validation entries (0.8.0 unified feedbackDistillation into distill)", () => {
    const schema = readSchema();
    const defs = schema.$defs as Record<string, unknown>;
    const ipfc = defs.ImproveProfileConfig as { properties?: { processes?: { properties?: Record<string, unknown> } } };
    const processes = ipfc.properties?.processes?.properties ?? {};
    expect(Object.keys(processes)).toContain("distill");
    expect(Object.keys(processes)).toContain("validation");
    expect(Object.keys(processes)).not.toContain("feedbackDistillation");
  });

  test("top-level index and search expose the new feature sections", () => {
    const schema = readSchema();
    const props = schema.properties as Record<string, unknown>;
    const index = props.index as { properties?: Record<string, unknown> };
    expect(Object.keys(index.properties ?? {})).toContain("metadataEnhance");
    expect(Object.keys(index.properties ?? {})).toContain("stalenessDetection");
    const search = props.search as { properties?: Record<string, unknown> };
    expect(Object.keys(search.properties ?? {})).toContain("graphBoost");
  });

  test("legacy llm/agent/features top-level entries are gone from the schema", () => {
    const schema = readSchema();
    const props = schema.properties as Record<string, unknown>;
    expect(props.llm).toBeUndefined();
    expect(props.agent).toBeUndefined();
    expect(props.features).toBeUndefined();
  });

  test("engine and improve-strategy property names match runtime grammar and reserved prefixes", () => {
    const schema = readSchema();
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const engineNames = properties.engines.propertyNames as { maxLength?: number; pattern?: string };
    const improve = properties.improve as { properties?: Record<string, Record<string, unknown>> };
    const strategyNames = improve.properties?.strategies?.propertyNames as { maxLength?: number; pattern?: string };
    expect(engineNames).toEqual({ maxLength: 63, pattern: ENGINE_NAME_PATTERN_SOURCE });
    expect(strategyNames).toEqual(engineNames);

    const pattern = new RegExp(engineNames.pattern ?? "");
    for (const name of ["default", "fast-2", "a"]) expect(pattern.test(name)).toBe(true);
    for (const name of ["Fast", "two--dashes", "akm-internal", "-leading"]) expect(pattern.test(name)).toBe(false);
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

  test("schemas/akm-config.json matches the generator output", async () => {
    // Drift detector: re-run the generator in-process and compare against the
    // committed file. Catches manual edits to schemas/akm-config.json that
    // weren't replicated back into the Zod source (or vice versa).
    const { checkSchemaDrift } = await import("../../scripts/gen-config-schema");
    const { upToDate, generated, existing } = checkSchemaDrift();
    if (!upToDate) {
      throw new Error(
        `schemas/akm-config.json is stale (generator output differs from committed file).\n` +
          `Run \`bun scripts/gen-config-schema.ts\` to regenerate.\n` +
          `existing length=${existing.length}, generated length=${generated.length}`,
      );
    }
  });
});
