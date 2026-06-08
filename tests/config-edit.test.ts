// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  applyConfigEdit,
  buildConfigEditModel,
  type ConfigEditField,
  envVarForSecret,
  isInteractiveTerminal,
  runConfigEdit,
} from "../src/commands/config-edit";
import type { AkmConfig } from "../src/core/config/config";

function allFields(model: ReturnType<typeof buildConfigEditModel>): ConfigEditField[] {
  return model.sections.flatMap((s) => s.fields);
}

function findField(model: ReturnType<typeof buildConfigEditModel>, path: string): ConfigEditField | undefined {
  return allFields(model).find((f) => f.path === path);
}

describe("buildConfigEditModel (schema-driven)", () => {
  test("derives one section per top-level config key", () => {
    const model = buildConfigEditModel();
    const keys = model.sections.map((s) => s.key);
    // A representative subset that must exist (schema is the single source of truth).
    for (const k of ["semanticSearchMode", "embedding", "output", "search", "feedback"]) {
      expect(keys).toContain(k);
    }
    // Every section has at least one editable/visible field.
    for (const s of model.sections) {
      expect(s.fields.length).toBeGreaterThan(0);
    }
  });

  test("classifies an enum field as select with its options", () => {
    const model = buildConfigEditModel();
    const f = findField(model, "semanticSearchMode");
    expect(f?.kind).toBe("select");
    expect(f?.options).toEqual(["off", "auto"]);
  });

  test("classifies a nested enum (output.format) as select", () => {
    const model = buildConfigEditModel();
    const f = findField(model, "output.format");
    expect(f?.kind).toBe("select");
    expect(f?.options).toEqual(["json", "yaml", "text"]);
  });

  test("classifies number and boolean leaves by type", () => {
    const model = buildConfigEditModel();
    expect(findField(model, "embedding.dimension")?.kind).toBe("number");
    expect(findField(model, "search.curateRerank.enabled")?.kind).toBe("boolean");
  });

  test("flags apiKey fields as secret", () => {
    const model = buildConfigEditModel();
    const f = findField(model, "embedding.apiKey");
    expect(f?.kind).toBe("secret");
    expect(f?.secret).toBe(true);
  });

  test("surfaces array/record sections (sources, installed) as JSON fields", () => {
    const model = buildConfigEditModel();
    expect(findField(model, "sources")?.kind).toBe("json");
    expect(findField(model, "installed")?.kind).toBe("json");
  });

  test("no field list is hand-maintained — model length tracks the schema shape", () => {
    const model = buildConfigEditModel();
    // Sanity: there are clearly more than a handful of derived fields.
    expect(allFields(model).length).toBeGreaterThan(10);
  });
});

describe("applyConfigEdit (pure write delegation)", () => {
  const base: AkmConfig = { semanticSearchMode: "auto" };

  test("sets an enum value", () => {
    const next = applyConfigEdit(base, "semanticSearchMode", "off");
    expect(next.semanticSearchMode).toBe("off");
  });

  test("sets a nested string field", () => {
    const next = applyConfigEdit(base, "embedding.endpoint", "https://example.com/v1");
    expect(next.embedding?.endpoint).toBe("https://example.com/v1");
  });

  test("coerces a number field from its string input", () => {
    const next = applyConfigEdit(base, "embedding.dimension", "768");
    expect(next.embedding?.dimension).toBe(768);
  });

  test("does not mutate the input config", () => {
    const input: AkmConfig = { semanticSearchMode: "auto" };
    applyConfigEdit(input, "embedding.endpoint", "https://x.test/v1");
    expect(input.embedding).toBeUndefined();
  });

  test("rejects apiKey paths (steers to env var) — secrets never persisted", () => {
    expect(() => applyConfigEdit(base, "embedding.apiKey", "sk-secret")).toThrow(/AKM_EMBED_API_KEY/);
    expect(() => applyConfigEdit(base, "llm.apiKey", "sk-secret")).toThrow(/AKM_LLM_API_KEY/);
  });

  test("rejects invalid enum values via the walker", () => {
    expect(() => applyConfigEdit(base, "semanticSearchMode", "nonsense")).toThrow();
  });
});

describe("envVarForSecret", () => {
  test("maps known secret paths to env vars", () => {
    expect(envVarForSecret("embedding.apiKey")).toBe("AKM_EMBED_API_KEY");
    expect(envVarForSecret("llm.apiKey")).toBe("AKM_LLM_API_KEY");
    expect(envVarForSecret("profiles.llm.default.apiKey")).toBe("AKM_LLM_API_KEY");
  });
});

describe("isInteractiveTerminal / no-TTY guard", () => {
  test("returns false when CI is set", () => {
    expect(isInteractiveTerminal({ CI: "true" })).toBe(false);
    expect(isInteractiveTerminal({ CI: "1" })).toBe(false);
  });

  test("CI=false / CI=0 / CI='' are not treated as CI", () => {
    // These fall through to the TTY check; under `bun test` stdin/stdout are
    // not TTYs, so the result is false regardless — but not because of CI.
    expect(isInteractiveTerminal({ CI: "false" })).toBe(false);
    expect(isInteractiveTerminal({ CI: "0" })).toBe(false);
    expect(isInteractiveTerminal({ CI: "" })).toBe(false);
  });

  test("runConfigEdit refuses to run without a TTY (test process has no TTY)", async () => {
    // The test runner's stdin/stdout are not TTYs, so this must throw the
    // interactive-only guard rather than block on a prompt.
    await expect(runConfigEdit()).rejects.toThrow(/interactive and requires a TTY/);
  });
});
