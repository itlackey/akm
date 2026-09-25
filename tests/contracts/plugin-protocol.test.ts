// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pins the plugin-facing JSON contract: the key sets of the `akm search`,
 * `akm curate`, `akm show`, `akm info` and `akm proposal extract` result
 * envelopes, against `PLUGIN_PROTOCOL_VERSION` (`src/version.ts`, D1).
 *
 * Each command's shaped output is computed the same way `output()` computes
 * it — through `shapeForCommand`, the same dispatcher the CLI uses — fed
 * with a fully-populated sample result so every optional envelope key is
 * present. If a change to any shape module adds, removes or renames a
 * plugin-facing key, the live key set stops matching the pinned snapshot
 * below and this test fails. The fix is: update the pinned snapshot to
 * match, AND bump `PLUGIN_PROTOCOL_VERSION` in `src/version.ts` — the second
 * assertion in each block checks the pinned protocol number against that
 * export, so bumping only one of the two still fails.
 *
 * No real database, network, or process — every command result here is a
 * synthetic literal fed straight into the pure shape functions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assembleInfo } from "../../src/commands/sources/info";
import { shapeForCommand } from "../../src/output/shapes";
import { PLUGIN_PROTOCOL_VERSION } from "../../src/version";
import { type Cleanup, sandboxStashDir } from "../_helpers/sandbox";

// Bump this alongside PLUGIN_PROTOCOL_VERSION whenever a pinned key set
// below changes. The two must always match (checked per-block below) —
// that coupling is what forces a bump instead of a silent snapshot update.
const PINNED_PROTOCOL_VERSION = 1;

const SAMPLE_SEARCH_HIT = {
  type: "skill",
  name: "deploy",
  ref: "skills/deploy",
  action: "akm show skills/deploy",
  estimatedTokens: 120,
  keys: ["k1"],
  selectedRef: "skills/deploy#frag-1",
  parentRef: "skills/deploy",
  fragmentOrdinal: 1,
  fragmentCount: 3,
  parentEstimatedTokens: 400,
};

const SAMPLE_REGISTRY_HIT = {
  type: "registry",
  title: "Deploy Kit",
  installRef: "github:example/deploy-kit",
  score: 0.9,
};

const SAMPLE_CURATE_ITEM = {
  source: "local",
  type: "skill",
  name: "deploy",
  ref: "skills/deploy",
  id: "1",
  supportRefs: ["knowledge/deploy-notes"],
  followUp: "akm show skills/deploy",
  reason: "matches the query",
};

const SAMPLE_SHOW_RESULT = {
  type: "skill",
  name: "deploy",
  ref: "skills/deploy",
  origin: "stash",
  action: "akm show skills/deploy",
  description: "Deploy the app",
  tags: ["ops"],
  content: "# Deploy",
  template: "{{content}}",
  prompt: "Deploy the app",
  toolPolicy: { allow: ["Bash"] },
  modelHint: "sonnet",
  agent: "deploy-agent",
  parameters: { env: "string" },
  workflowTitle: "Deploy workflow",
  workflowParameters: { env: "string" },
  steps: [{ name: "build" }],
  run: "bun run deploy",
  setup: "bun install",
  cwd: ".",
  activeRun: { id: "run-1" },
  keys: ["k1"],
  related: ["skills/rollback"],
  selectedRef: "skills/deploy#frag-1",
  parentRef: "skills/deploy",
  fragmentOrdinal: 1,
  fragmentCount: 3,
  startLine: 1,
  endLine: 10,
  previousRef: "skills/deploy#frag-0",
  nextRef: "skills/deploy#frag-2",
  fragmentChars: 400,
  fragmentEstimatedTokens: 120,
  parentChars: 1200,
  parentEstimatedTokens: 400,
  contextMode: "fragment",
  contextMaxChars: 4000,
  contextTruncated: false,
  path: "/stash/skills/deploy",
  editable: true,
};

const SAMPLE_EXTRACT_RESULT = {
  schemaVersion: 1 as const,
  ok: true,
  shape: "extract-result" as const,
  dryRun: false,
  type: "claude",
  sessionsProcessed: 2,
  sessionsSkipped: 1,
  candidatesCreated: 3,
  proposals: ["proposal-1"],
  sessions: [{ sessionId: "s1" }],
  warnings: ["one session skipped"],
  durationMs: 1500,
  notices: [],
  skipReasons: { already_seen: 1 },
  engine: "default",
  engineKind: "http",
};

describe("plugin protocol contract (D1)", () => {
  // `assembleInfo` (used by the `akm info` block below) resolves a real
  // bundle directory; sandbox it like every other test that calls it.
  let cleanup: Cleanup = () => {};
  beforeEach(() => {
    cleanup = sandboxStashDir().cleanup;
  });
  afterEach(() => {
    cleanup();
  });

  test("PLUGIN_PROTOCOL_VERSION matches the version pinned by this snapshot", () => {
    expect(PLUGIN_PROTOCOL_VERSION).toBe(PINNED_PROTOCOL_VERSION);
  });

  test("`akm search` envelope keys are pinned", () => {
    const result = {
      schemaVersion: 1,
      bundleDir: "/stash",
      source: "local",
      hits: [SAMPLE_SEARCH_HIT],
      registryHits: [SAMPLE_REGISTRY_HIT],
      tip: "run `akm show <ref>`",
      searchMode: "fts",
      warnings: ["semantic search pending"],
      timing: { totalMs: 5 },
    };
    const shaped = shapeForCommand("search", result, "brief", "human") as Record<string, unknown>;

    expect(Object.keys(shaped).sort()).toEqual(["hits", "registryHits", "results", "searchMode", "tip", "warnings"]);
    const hit = (shaped.hits as Record<string, unknown>[])[0] ?? {};
    expect(Object.keys(hit).sort()).toEqual(
      [
        "type",
        "name",
        "ref",
        "action",
        "estimatedTokens",
        "keys",
        "selectedRef",
        "parentRef",
        "fragmentOrdinal",
        "fragmentCount",
        "parentEstimatedTokens",
      ].sort(),
    );
  });

  test("`akm curate` envelope keys are pinned", () => {
    const result = {
      schemaVersion: 1,
      query: "deploy",
      summary: "1 result",
      items: [SAMPLE_CURATE_ITEM],
      searchMode: "fts",
      warnings: ["semantic search pending"],
      tip: "run `akm show <ref>`",
    };
    const shaped = shapeForCommand("curate", result, "brief", "human") as Record<string, unknown>;

    expect(Object.keys(shaped).sort()).toEqual(
      ["schemaVersion", "shape", "query", "summary", "items", "searchMode", "warnings", "tip", "results"].sort(),
    );
    const item = (shaped.items as Record<string, unknown>[])[0] ?? {};
    expect(Object.keys(item).sort()).toEqual(
      ["source", "type", "name", "ref", "id", "supportRefs", "followUp", "reason"].sort(),
    );
  });

  test("`akm show` envelope keys are pinned", () => {
    const shaped = shapeForCommand("show", SAMPLE_SHOW_RESULT, "brief", "human") as Record<string, unknown>;

    expect(Object.keys(shaped).sort()).toEqual(Object.keys(SAMPLE_SHOW_RESULT).sort());
  });

  test("`akm info` envelope keys are pinned, including the `compat` manifest", () => {
    const info = assembleInfo({ dbPath: "/nonexistent/does-not-exist.db" });
    const shaped = shapeForCommand("info", info, "brief", "human") as Record<string, unknown>;

    expect(Object.keys(shaped).sort()).toEqual(
      [
        "ok",
        "schemaVersion",
        "version",
        "bundleDir",
        "defaultBundle",
        "dataDir",
        "configDir",
        "cacheDir",
        "stateDir",
        "assetTypes",
        "searchModes",
        "semanticSearch",
        "registries",
        "sourceProviders",
        "indexStats",
        "compat",
        "shape",
      ].sort(),
    );
    expect(Object.keys(info.compat).sort()).toEqual(
      [
        "indexGeneration",
        "stateLedgerHead",
        "taskSourceVersion",
        "configVersion",
        "workflowIrVersion",
        "pluginProtocol",
      ].sort(),
    );
    expect(info.compat.pluginProtocol).toBe(PLUGIN_PROTOCOL_VERSION);
  });

  test("`akm proposal extract` envelope keys are pinned", () => {
    const shaped = shapeForCommand("extract", SAMPLE_EXTRACT_RESULT, "brief", "human") as Record<string, unknown>;

    expect(Object.keys(shaped).sort()).toEqual(Object.keys(SAMPLE_EXTRACT_RESULT).sort());
  });
});
