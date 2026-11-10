// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What each engine name of the retired `engines` form became. The conversion renames the engine `defaults` named
 * to `default` and moves the old `default` aside, so the migrator, which rewrites the assets' `engine:` keys,
 * remembers the old names in the data directory after it has rewritten the config, until it has rewritten them all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { normalizeConfigFile, retiredEngineTargets } from "../../scripts/akm-migrate/config/normalize";
import { forgetEngineTargets } from "../../scripts/akm-migrate/config/retired-engines";
import { resetConfigCache } from "../../src/core/config/config";
import { getConfigPath, getDataDir } from "../../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";

const A = "http://a.example.test/v1";
const B = "http://b.example.test/v1";

const llm = (endpoint: string, model: string) => ({ kind: "llm", endpoint, model });

const EXPECTED = {
  default: { connection: "legacy-default" },
  lab: { connection: "default" },
  claude: { harness: "default" },
  gemini: { harness: "gemini" },
};

beforeEach(() => {
  _resetWarnOnceForTests();
  _setWarnSinkForTests(() => {});
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  // Old engine `default` is A, `lab` is B, and `lab` is the default LLM engine: the conversion makes B the new
  // `default` and A `legacy-default`. A harness engine and a runtime engine ride along.
  fs.writeFileSync(
    getConfigPath(),
    JSON.stringify({
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
  forgetEngineTargets();
  resetConfigCache();
});

describe("the names of the engines form", () => {
  test("have a map from every engine to what it became, while the file is in that form", () => {
    expect(retiredEngineTargets()).toEqual(EXPECTED);
  });

  test("are remembered after the migrator has rewritten the file", () => {
    expect(normalizeConfigFile(getConfigPath(), { apply: true }).applied).toBe(true);
    resetConfigCache();
    expect(JSON.parse(fs.readFileSync(getConfigPath(), "utf8")).engines).toBeUndefined();
    expect(retiredEngineTargets()).toEqual(EXPECTED);
  });

  test("are gone once the migrator has forgotten them", () => {
    normalizeConfigFile(getConfigPath(), { apply: true });
    resetConfigCache();
    forgetEngineTargets();
    expect(retiredEngineTargets()).toEqual({});
  });

  test("ignore an entry of the remembered file that is not a connection or harness name", () => {
    normalizeConfigFile(getConfigPath(), { apply: true });
    resetConfigCache();
    fs.writeFileSync(
      path.join(getDataDir(), "migrate", "engine-targets.json"),
      JSON.stringify({ default: "legacy-default", lab: { connection: "" }, gemini: { harness: "gemini" } }),
    );
    expect(retiredEngineTargets()).toEqual({ gemini: { harness: "gemini" } });
  });
});
