// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The three example configs the rework is specified by: each is the current form, loads unchanged and validates. */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveImprovePlan } from "../src/commands/improve/improve-strategies";
import { resolveQualityGateJudge } from "../src/commands/improve/stage";
import { stripJsonComments } from "../src/core/common";
import { loadConfig, resetConfigCache, unknownConfigKeyPaths } from "../src/core/config/config";
import { AkmConfigSchema } from "../src/core/config/config-schema";
import { getConfigPath } from "../src/core/paths";

type Dict = Record<string, unknown>;

describe("the example configs load unchanged and validate", () => {
  const examples = path.join(import.meta.dir, "fixtures", "config-examples");

  test.each(["1-basic", "2-harness", "3-power"])("%s.jsonc", (name) => {
    const raw = JSON.parse(stripJsonComments(fs.readFileSync(path.join(examples, `${name}.jsonc`), "utf8"))) as Dict;
    expect(AkmConfigSchema.safeParse({ semanticSearchMode: "off", ...raw }).success).toBe(true);
    // Every key is one akm reads or a request field.
    expect(unknownConfigKeyPaths({ ...raw })).toEqual([]);
  });

  test.each([
    ["1-basic", "off"],
    ["2-harness", "auto"],
    ["3-power", "auto"],
  ] as const)("%s.jsonc, loaded as written, reads semantic search as %s", (name, mode) => {
    // The examples carry no semanticSearchMode: an `embedding` block alone says semantic search is wanted.
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.copyFileSync(path.join(examples, `${name}.jsonc`), getConfigPath());
    resetConfigCache();
    expect(loadConfig().semanticSearchMode).toBe(mode);
    resetConfigCache();
  });

  test("3-power.jsonc, loaded from a file: triage judges on the anthropic connection's reasoning model, the quality gate on anthropic's balanced one", () => {
    const raw = JSON.parse(stripJsonComments(fs.readFileSync(path.join(examples, "3-power.jsonc"), "utf8"))) as Dict;
    const improve = raw.improve as Dict;
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(
      getConfigPath(),
      JSON.stringify({
        ...raw,
        improve: {
          ...improve,
          strategy: "nightly",
          strategies: {
            nightly: { processes: { triage: { enabled: true, judgment: true }, distill: { enabled: true } } },
          },
        },
      }),
    );
    resetConfigCache();
    const config = loadConfig();
    const plan = resolveImprovePlan("nightly", config);
    expect(plan.triageJudgment).toMatchObject({ kind: "connection", name: "anthropic", model: "claude-opus-4-7" });
    expect(plan.processes.distill.runner).toMatchObject({ kind: "connection", name: "default", model: "qwen3-32b" });
    // Nothing names a model for the gate's judge, so it asks for the shipped judge alias: `balanced`.
    expect(resolveQualityGateJudge(config, undefined, "reflect")).toMatchObject({
      kind: "connection",
      name: "anthropic",
      model: "claude-sonnet-4-5",
    });
    resetConfigCache();
  });
});
