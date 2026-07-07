// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//
// Coverage-hardening: config-walker (configGet/configSet/configUnset).
//
// NO test file imports config-walker directly — it is only exercised
// indirectly through the config-cli wrappers, and only for a handful of
// happy-path keys (output.*, embedding.*, llm.*). Several branchy coercion
// and schema-descent paths in the walker have zero behavioural coverage:
//   - catchall descent (index.<passName>.<field>)
//   - z.record descent (profiles.llm.<name>.<field>)
//   - boolean case-sensitivity ("True"/"1" must be REJECTED, only "true"/"false")
//   - number range validation via safeParse (min/max, not just finite)
//   - empty-segment path rejection ("a..b")
//   - unset pruning an emptied parent object
//   - configGet returning null (not throwing) when a parent is null
// These are exactly the "code runs but only the easy input is tested" gaps.
//

import { describe, expect, test } from "bun:test";
import { configGet, configSet, configUnset } from "../../src/core/config/config-walker";

describe("configSet — catchall descent (index.<passName>)", () => {
  test("descends through the IndexConfig catchall into a per-pass field", () => {
    const next = configSet({}, "index.graph.llm", "true");
    expect(next).toEqual({ index: { graph: { llm: true } } });
  });

  test("coerces + validates the per-pass leaf (boolean rejects non-boolean)", () => {
    expect(() => configSet({}, "index.graph.llm", "yes")).toThrow(/expected true or false/);
  });

  test("an unknown per-pass leaf key is rejected as an unknown config key", () => {
    // The per-pass object is passthrough at the schema level, but the walker
    // resolves the leaf schema and finds no matching field / catchall, so the
    // set is refused rather than silently persisting a typo'd leaf.
    expect(() => configSet({}, "index.graph.bogusLeaf", "1")).toThrow(/Unknown config key/);
  });
});

describe("configSet — z.record descent (profiles.llm.<name>)", () => {
  test("an arbitrary profile name descends into the record value schema", () => {
    const next = configSet({}, "profiles.llm.myprofile.model", "gpt-4o");
    expect(next).toEqual({ profiles: { llm: { myprofile: { model: "gpt-4o" } } } });
  });
});

describe("configSet — boolean coercion is strictly 'true' | 'false'", () => {
  test("'true' and 'false' coerce to real booleans", () => {
    expect(configSet({}, "improve.exploration.enabled", "true")).toEqual({
      improve: { exploration: { enabled: true } },
    });
    expect(configSet({}, "improve.exploration.enabled", "false")).toEqual({
      improve: { exploration: { enabled: false } },
    });
  });

  test("'True' (wrong case) is rejected — no silent truthiness coercion", () => {
    expect(() => configSet({}, "improve.exploration.enabled", "True")).toThrow(/expected true or false/);
  });

  test("'1' is rejected — numbers are not truthy booleans here", () => {
    expect(() => configSet({}, "improve.exploration.enabled", "1")).toThrow(/expected true or false/);
  });
});

describe("configSet — number coercion + range validation", () => {
  test("a valid in-range number is accepted", () => {
    expect(configSet({}, "improve.calibration.targetAcceptRate", "0.4")).toEqual({
      improve: { calibration: { targetAcceptRate: 0.4 } },
    });
  });

  test("a non-numeric string is rejected at coercion time", () => {
    expect(() => configSet({}, "improve.calibration.targetAcceptRate", "abc")).toThrow(/expected a number/);
  });

  test("an out-of-range number is rejected by safeParse (not just finiteness)", () => {
    // targetAcceptRate is .min(0).max(1); 5 coerces to a finite number but must
    // fail the leaf schema validation. This is the branch that catches a value
    // that is a valid number yet an invalid config value.
    expect(() => configSet({}, "improve.calibration.targetAcceptRate", "5")).toThrow(/Invalid value/);
  });
});

describe("configSet — workflow.maxConcurrency", () => {
  test("a positive integer is accepted and coerced from string", () => {
    expect(configSet({}, "workflow.maxConcurrency", "8")).toEqual({
      workflow: { maxConcurrency: 8 },
    });
  });

  test("zero is rejected (positive integer only)", () => {
    expect(() => configSet({}, "workflow.maxConcurrency", "0")).toThrow();
  });

  test("a negative value is rejected", () => {
    expect(() => configSet({}, "workflow.maxConcurrency", "-4")).toThrow();
  });

  test("a non-integer is rejected", () => {
    expect(() => configSet({}, "workflow.maxConcurrency", "2.5")).toThrow();
  });

  test("configGet reads back the set value", () => {
    const next = configSet({}, "workflow.maxConcurrency", "12");
    expect(configGet(next, "workflow.maxConcurrency")).toBe(12);
  });
});

describe("configSet — path parsing + unknown keys", () => {
  test("an empty segment between dots is rejected", () => {
    expect(() => configSet({}, "output..format", "text")).toThrow(/empty segment between dots/);
  });

  test("an entirely unknown top-level path is rejected", () => {
    expect(() => configSet({}, "totally.unknown.path", "x")).toThrow(/Unknown config key/);
  });

  test("set is immutable — the input object is not mutated", () => {
    const base = { output: { format: "yaml" as const } };
    const next = configSet(base, "output.detail", "full");
    expect(base).toEqual({ output: { format: "yaml" } });
    expect(next).toEqual({ output: { format: "yaml", detail: "full" } });
  });
});

describe("configSet — defaultWriteTarget cross-field validation", () => {
  test("rejects a target that names no configured source", () => {
    expect(() => configSet({ sources: [{ name: "a" }] }, "defaultWriteTarget", "b")).toThrow(/Unknown source name "b"/);
  });

  test("accepts a target that matches a configured source name", () => {
    const next = configSet({ sources: [{ name: "a" }] }, "defaultWriteTarget", "a");
    expect(next.defaultWriteTarget).toBe("a");
  });
});

describe("configGet — read behaviour", () => {
  test("returns the value at a known nested path", () => {
    const config = { output: { format: "yaml", detail: "normal" } };
    expect(configGet(config, "output.format")).toBe("yaml");
  });

  test("returns null (does not throw) when a parent is explicitly null", () => {
    expect(configGet({ output: null }, "output.format")).toBeNull();
  });

  test("returns null for an unset-but-valid leaf", () => {
    expect(configGet({ output: {} }, "output.format")).toBeNull();
  });

  test("throws for an unknown key path", () => {
    expect(() => configGet({}, "no.such.key")).toThrow(/Unknown config key/);
  });
});

describe("configUnset — removal + pruning", () => {
  test("removes a leaf and prunes the now-empty parent object", () => {
    expect(configUnset({ output: { format: "text" } }, "output.format")).toEqual({});
  });

  test("removes only the targeted leaf, leaving siblings intact", () => {
    expect(configUnset({ output: { format: "text", detail: "full" } }, "output.format")).toEqual({
      output: { detail: "full" },
    });
  });

  test("throws for an unknown key so typos do not silently no-op", () => {
    expect(() => configUnset({}, "no.such.key")).toThrow(/Unknown config key/);
  });
});
