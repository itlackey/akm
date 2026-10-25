// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * While the config file is still in the retired `engines` form, an `engine:`
 * selector (a flag, a key in an asset or a task source) means the engine it
 * always named, even though the conversion renames the engine `defaults` named to
 * `default` and moves the old `default` aside. `akm migrate apply` rewrites the
 * file; the references it could not rewrite then say what they say.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadUserConfig, normalizeConfigFile, resetConfigCache, retiredEngineTargets } from "../src/core/config/config";
import { getConfigPath } from "../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { resolveTarget } from "../src/integrations/agent/resolution";

const A = "http://a.example.test/v1";
const B = "http://b.example.test/v1";

const llm = (endpoint: string, model: string) => ({ kind: "llm", endpoint, model });

beforeEach(() => {
  _resetWarnOnceForTests();
  _setWarnSinkForTests(() => {});
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  // Old engine `default` is A, `lab` is B, and `lab` is the default LLM engine: the conversion makes B the new
  // `default` and A `legacy-default`. A harness engine and a runtime engine ride along.
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify({
      configVersion: "0.9.0",
      engines: {
        default: llm(A, "model-a"),
        lab: llm(B, "model-b"),
        claude: { kind: "agent", platform: "claude" },
        gemini: { kind: "agent", platform: "gemini" },
      },
      defaults: { llmEngine: "lab", engine: "claude" },
    }),
  );
  resetConfigCache();
});

afterEach(() => {
  _setWarnSinkForTests(undefined);
  resetConfigCache();
});

const endpointOf = (engine: string, modelWork = true) => {
  const runner = resolveTarget({ config: loadUserConfig(), modelWork, layers: [{ engine }] });
  return runner.kind === "connection" ? runner.endpoint : `harness:${runner.name}`;
};

describe("an engine: selector before the file is migrated", () => {
  test("still names the engine it always named, whatever the conversion called it", () => {
    expect(Object.keys(loadUserConfig().connections ?? {}).sort()).toEqual(["default", "legacy-default"]);
    expect(endpointOf("default")).toBe(A);
    expect(endpointOf("lab")).toBe(B);
  });

  test("keeps a harness engine a harness, under the name it has now", () => {
    expect(endpointOf("claude", false)).toBe("harness:default");
    expect(endpointOf("gemini", false)).toBe("harness:gemini");
  });

  test("has a map from every converted engine to what it became", () => {
    expect(retiredEngineTargets()).toEqual({
      default: { connection: "legacy-default" },
      lab: { connection: "default" },
      claude: { harness: "default" },
      gemini: { harness: "gemini" },
    });
  });
});

describe("an engine: selector after the file is migrated", () => {
  test("is read against the file as it now is: the map is gone, with the engines it described", () => {
    expect(normalizeConfigFile(getConfigPath(), { apply: true }).applied).toBe(true);
    resetConfigCache();
    expect(retiredEngineTargets()).toEqual({});
    // Nothing remembers that `default` once meant A: the migrator rewrote the references it could.
    expect(endpointOf("default")).toBe(B);
  });
});
