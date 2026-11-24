// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Memory inference decides once, before any model call, whether the bundle its derived memories would be written to
 * takes writes. A default bundle configured `writable: false` skips the pass: no model call, its pending memories stay
 * pending, and one warning names the bundle. Otherwise every `akm index` would pay a model call per pending memory
 * for a write that is then refused.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { assembleAsset } from "../../src/core/asset/asset-serialize";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import { _setWarnSinkForTests } from "../../src/core/warn";
import { isPendingMemory, runMemoryInferencePass } from "../../src/indexer/passes/memory-inference";
import { _setChatCompletionForTests } from "../../src/llm/client";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";
import { overrideSeam, withSeam } from "../_helpers/seams";

let storage: IsolatedAkmStorage;
let requests: number;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  requests = 0;
  overrideSeam(_setChatCompletionForTests, async () => {
    requests += 1;
    return JSON.stringify({ noChange: true });
  });
});
afterEach(() => storage.cleanup());

function config(writable: boolean) {
  return {
    semanticSearchMode: "off" as const,
    bundles: { stash: { path: storage.stashDir, writable } },
    defaultBundle: "stash",
    connections: { memory: { endpoint: "http://127.0.0.1:1/v1/chat/completions", models: { fast: "scripted" } } },
    index: { connection: "memory" },
  };
}

function writePending(name: string): string {
  const file = path.join(storage.stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, assembleAsset({ description: `${name} note` }, `The operator noted ${name}.`));
  return file;
}

async function run(writable: boolean) {
  const warnings: string[] = [];
  const result = await withSeam(
    _setWarnSinkForTests,
    (_level, args) => warnings.push(args.join(" ")),
    () =>
      runMemoryInferencePass({
        config: config(writable),
        sources: [{ path: storage.stashDir, isDefault: true, writable }],
      }),
  );
  return { result, warnings };
}

test("a default bundle configured writable: false skips the pass: no model call, memories stay pending, one warning", async () => {
  const files = [writePending("tunnel"), writePending("deploy")];
  const before = files.map((file) => fs.readFileSync(file, "utf8"));

  const { result, warnings } = await run(false);

  expect(requests).toBe(0);
  expect(result).toMatchObject({ considered: 0, writtenFacts: 0, scopeSynced: 0, writtenPaths: [] });
  expect(files.map((file) => fs.readFileSync(file, "utf8"))).toEqual(before);
  for (const file of files)
    expect(isPendingMemory(parseFrontmatter(fs.readFileSync(file, "utf8")).data, file)).toBe(true);
  expect(warnings).toEqual([
    'memory inference: skipped — bundle "stash" is not writable, so its pending memories wait',
  ]);
});

test("a writable default bundle still infers", async () => {
  writePending("tunnel");
  const { result, warnings } = await run(true);
  expect(requests).toBe(1);
  expect(result.considered).toBe(1);
  expect(warnings.filter((line) => line.includes("not writable"))).toEqual([]);
});
