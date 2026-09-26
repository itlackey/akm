import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
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
  test("ImproveProcessConfig schema includes the qualityGate sub-object and no longer declares contradictionDetection", () => {
    const schema = readSchema();
    const defs = schema.$defs as Record<string, unknown>;
    const ipc = defs.ImproveProcessConfig as { properties?: Record<string, unknown> };
    const keys = Object.keys(ipc.properties ?? {});
    expect(keys).toContain("qualityGate");
    expect(keys).not.toContain("contradictionDetection");
  });

  test("triage judgment JSON schema accepts boolean shorthand and passes unknown object keys through", () => {
    const schema = readSchema();
    const defs = schema.$defs as Record<string, unknown>;
    const ipc = defs.ImproveProcessConfig as { properties?: Record<string, unknown> };
    const judgment = ipc.properties?.judgment as {
      anyOf?: Array<{ type?: string; properties?: Record<string, unknown>; additionalProperties?: boolean }>;
    };
    const booleanArm = judgment.anyOf?.find((arm) => arm.type === "boolean");
    const objectArm = judgment.anyOf?.find((arm) => arm.type === "object");
    const llmOverrides = objectArm?.properties?.llm as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    const extraParams = llmOverrides.properties?.extraParams as { additionalProperties?: unknown };

    expect(booleanArm).toBeDefined();
    expect(Object.keys(objectArm?.properties ?? {}).sort()).toEqual(["enabled", "engine", "llm", "model", "timeoutMs"]);
    expect(objectArm?.additionalProperties).toBe(true);
    expect(Object.keys(llmOverrides.properties ?? {}).sort()).toEqual([
      "contextLength",
      "enableThinking",
      "extraParams",
      "maxTokens",
      "reasoningEffort",
      "supportsJsonSchema",
      "temperature",
    ]);
    expect(llmOverrides.additionalProperties).toBe(true);
    expect(extraParams.additionalProperties).toEqual({});
  });

  test("generated schema tolerates unknown judgment LLM keys and accepts arbitrary extraParams", () => {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(readSchema());
    const withLlm = (llm: Record<string, unknown>) => ({
      configVersion: "0.9.0",
      improve: {
        strategies: {
          nightly: { processes: { triage: { enabled: true, judgment: { llm } } } },
        },
      },
    });

    // An unknown key is never a schema error; the loader names it once at runtime.
    for (const llm of [{ tempertaure: 0.2 }, { futureTopLevelKnob: true }]) {
      expect(validate(withLlm(llm))).toBe(true);
    }

    expect(
      validate(
        withLlm({
          temperature: 0.2,
          extraParams: { providerFeature: { nested: [1, true, "kept"] }, arbitrary_number: 7 },
        }),
      ),
    ).toBe(true);
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
    expect(Object.keys(index.properties ?? {})).not.toContain("stalenessDetection");
    expect(Object.keys(index.properties ?? {})).not.toContain("indexBodyOpening");
    const search = props.search as { properties?: Record<string, unknown> };
    expect(Object.keys(search.properties ?? {})).toContain("graphBoost");
  });

  test("0.9.0 bundles/defaultBundle config-shape keys are present (spec §10.1 / D-R5)", () => {
    const schema = readSchema();
    const props = schema.properties as Record<string, Record<string, unknown>>;
    // `bundles` is an object keyed by bundle slug; each entry carries the
    // source descriptors path/git/website/npm.
    const bundles = props.bundles as { type?: string; additionalProperties?: { properties?: Record<string, unknown> } };
    expect(bundles.type).toBe("object");
    const entryProps = Object.keys(bundles.additionalProperties?.properties ?? {});
    for (const key of ["path", "git", "website", "npm", "writable", "registryId", "components"]) {
      expect(entryProps).toContain(key);
    }
    expect(props.defaultBundle).toEqual({ type: "string", minLength: 1 });
    expect(props.writable).toBeUndefined();
    // `bindings` (Tier B) is never part of the accepted config surface.
    expect(props.bindings).toBeUndefined();
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
    const engineNames = properties.engines!.propertyNames as { maxLength?: number; pattern?: string };
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

    expect(confidenceMode.enum).toEqual(["blend"]);
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
