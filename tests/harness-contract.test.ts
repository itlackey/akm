// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The contract every harness in `HARNESS_REGISTRY` must satisfy (#1095).
 * Adding a harness (one folder under `src/integrations/harnesses/` plus one
 * registry line) is complete when this file passes without edits.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { checkHarnessDocsDrift } from "../scripts/gen-config-schema";
import { validateConfigShape } from "../src/core/config/config-schema";
import { getCommandBuilder } from "../src/integrations/agent/builders";
import { getBuiltinAgentProfile } from "../src/integrations/agent/profiles";
import { type AkmHarness, HARNESS_REGISTRY, VALID_HARNESS_IDS } from "../src/integrations/harnesses";

const HARNESS_DIR = path.resolve(import.meta.dir, "..", "src", "integrations", "harnesses");

describe.each(
  (HARNESS_REGISTRY as readonly AkmHarness[]).map((h) => [h.id, h] as const),
)("harness contract: %s", (id, h) => {
  test("is a self-contained folder named after its id", () => {
    expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(fs.existsSync(path.join(HARNESS_DIR, id, "index.ts"))).toBe(true);
    expect(h.displayName.length).toBeGreaterThan(0);
  });

  test("dispatch: a spawned CLI has a builder and a profile; the SDK path has a lowerer", () => {
    expect(h.capabilities.agentDispatch).toBe(true);
    const lower = h.agentBuilder?.lower ?? h.executionLowerer?.lower;
    expect(typeof lower).toBe("function");
    if (h.agentBuilder) {
      expect(h.agentBuilder.platform).toBe(id);
      expect(getCommandBuilder(id)).toBe(h.agentBuilder);
      expect(h.profile?.bin).toBeTruthy();
      expect(getBuiltinAgentProfile(id)?.bin).toBe(h.profile?.bin ?? "");
      expect(getBuiltinAgentProfile(id)?.envPassthrough).toContain("PATH");
    } else {
      expect(h.profile).toBeUndefined();
      expect(getBuiltinAgentProfile(id)).toBeUndefined();
    }
  });

  test("the config schema accepts it as an agent engine platform", () => {
    expect(VALID_HARNESS_IDS as readonly string[]).toContain(id);
    expect(validateConfigShape({ configVersion: "0.9.0", engines: { e: { kind: "agent", platform: id } } }).ok).toBe(
      true,
    );
  });

  test("session logs: a provider is declared exactly when the capability is, and names this harness", () => {
    if (h.capabilities.sessionLogs) expect(h.sessionLogProvider?.().name).toBe(id as string);
    else expect(h.sessionLogProvider).toBeUndefined();
    if (h.setupDetectionDir) expect(h.capabilities.sessionLogs).toBe(true);
  });

  test("config import: an importer is declared exactly when the capability is", () => {
    expect(h.configImporter !== undefined).toBe(h.capabilities.configImport);
  });

  test("model-work and native-agent flags need a dispatch path that can honor them", () => {
    if (h.capabilities.modelWork || h.capabilities.nativeAgent) {
      expect(h.capabilities.agentDispatch).toBe(true);
    }
  });
});

describe("harness registry", () => {
  test("ids are unique and every harness folder is registered", () => {
    const ids = HARNESS_REGISTRY.map((h) => h.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    const folders = fs
      .readdirSync(HARNESS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(folders).toEqual([...ids].sort());
  });

  test("the generated docs table in configuration.md matches the registry", () => {
    expect(checkHarnessDocsDrift().upToDate).toBe(true);
  });
});
