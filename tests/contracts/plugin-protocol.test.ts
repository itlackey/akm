// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pins the plugin-facing JSON contract: the key sets of the `akm search`,
 * `akm curate` (including its `--shape agent` projection, which is what both
 * akm-plugins call sites — `claude/hooks/akm-hook.ts` and `opencode/index.ts`
 * — actually request), `akm show`, `akm info` and `akm proposal extract`
 * result envelopes, against `PLUGIN_PROTOCOL_VERSION` (`src/version.ts`, D1).
 *
 * Each command's shaped output is computed the same way `output()` computes
 * it — through `shapeForCommand`, the same dispatcher the CLI uses — fed
 * with a fully-populated sample result so every optional envelope key is
 * present. `akm show`'s sample and `akm proposal extract`'s sample (plus its
 * nested per-session result) are typed `satisfies Required<...>` against the
 * real result interfaces (`ShowResponse`, `AkmExtractResult`,
 * `ExtractedSessionResult`), so adding a field to any of those types is a
 * `tsc` error here until the sample is updated. Every key-set comparison
 * below runs through `assertKeySet`, which compares against a literal key
 * list (never a set derived from the sample itself — that would be
 * tautological) and fails with an instruction to bump
 * `PLUGIN_PROTOCOL_VERSION`.
 *
 * No real database, network, or process — every command result here is a
 * synthetic literal fed straight into the pure shape functions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assembleInfo } from "../../src/commands/sources/info";
import type { AkmExtractResult, ExtractedSessionResult } from "../../src/core/improve-types";
import { shapeForCommand } from "../../src/output/shapes";
import type { ShowResponse } from "../../src/sources/types";
import { PLUGIN_PROTOCOL_VERSION } from "../../src/version";
import { type Cleanup, sandboxStashDir } from "../_helpers/sandbox";

// Bump this alongside PLUGIN_PROTOCOL_VERSION whenever a pinned key set
// below changes. The two must always match (checked per-block below) —
// that coupling is what forces a bump instead of a silent snapshot update.
const PINNED_PROTOCOL_VERSION = 1;

/**
 * The one comparison helper every key-set assertion in this file routes
 * through. `expected` is always a literal array typed out by hand against
 * the shape module / result interface — never derived from the sample under
 * test, which would make the assertion tautological (a field added to and
 * removed from the sample in the same edit would never be caught).
 */
function assertKeySet(actual: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = [...expected].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `plugin-facing key set changed (${label}): update the pinned snapshot AND bump ` +
        `PLUGIN_PROTOCOL_VERSION in src/version.ts\n` +
        `  expected: ${expectedKeys.join(", ")}\n` +
        `  actual:   ${actualKeys.join(", ")}`,
    );
  }
}

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

// Fully populated so the `--shape agent` projection (below) has every field
// it picks to project, including `editHint` — which only survives shaping
// when `editable` is `false` (`shapeCurateItem` in
// `src/output/shapes/curate.ts` deletes `editHint` otherwise).
const SAMPLE_CURATE_ITEM_AGENT = {
  source: "local",
  type: "skill",
  name: "deploy",
  ref: "skills/deploy",
  path: "/stash/skills/deploy.md",
  editable: false,
  editHint: "This asset is a registry mirror; edit the upstream repo instead.",
  id: "1",
  description: "Deploy the app",
  supportRefs: ["knowledge/deploy-notes"],
  followUp: "akm show skills/deploy",
  reason: "matches the query",
  score: 0.9,
};

// `akm curate`'s envelope shape (schemaVersion/shape/query/summary/items/
// searchMode/warnings/tip, plus the `results` alias) does not vary with
// `--shape`; only the per-item projection does. Shared by both curate blocks
// below.
const CURATE_ENVELOPE_KEYS = [
  "schemaVersion",
  "shape",
  "query",
  "summary",
  "items",
  "searchMode",
  "warnings",
  "tip",
  "results",
];

// Every optional `ShowResponse` field populated (`satisfies Required<...>`
// forces this file to add a field here — and to the literal key list below —
// the moment `ShowResponse` gains one, or this stops compiling).
const SAMPLE_SHOW_RESULT = {
  schemaVersion: 1,
  type: "skill",
  name: "deploy",
  path: "/stash/skills/deploy",
  ref: "skills/deploy#frag-1",
  activeRun: { runId: "run-1", stepId: "step-1", workflowRef: "workflows/deploy" },
  content: "# Deploy",
  template: "{{content}}",
  prompt: "Deploy the app",
  description: "Deploy the app",
  tags: ["ops"],
  toolPolicy: { allow: ["Bash"] },
  modelHint: "sonnet",
  agent: "deploy-agent",
  run: "bun run deploy",
  setup: "bun install",
  cwd: ".",
  origin: "stash",
  action: "akm show skills/deploy",
  parameters: ["env"],
  workflowTitle: "Deploy workflow",
  workflowParameters: [{ name: "env", description: "Target environment" }],
  steps: [{ id: "build", title: "Build", instructions: "bun run build" }],
  editable: true,
  editHint: "Not applicable — editable is true.",
  keys: ["k1"],
  related: {
    total: 1,
    hits: [
      {
        ref: "skills/rollback",
        path: "/stash/skills/rollback.md",
        type: "skill",
        sharedEntities: ["deploy"],
        relationCount: 2,
      },
    ],
  },
  contextMode: "lead",
  contextMaxChars: 4000,
  contextTruncated: false,
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
} satisfies Required<ShowResponse>;

// `shapeShowOutput` (`src/output/shapes/helpers.ts`) at `detail: "brief"`,
// `shape: "human"` returns its `base` projection verbatim — which is every
// `ShowResponse` field EXCEPT `schemaVersion` and `editHint` (both are only
// added on the `detail: "full"` branch). Written out by hand against that
// pickFields list, not derived from `SAMPLE_SHOW_RESULT`.
const SHOW_BRIEF_KEYS = [
  "type",
  "name",
  "ref",
  "origin",
  "action",
  "description",
  "tags",
  "content",
  "template",
  "prompt",
  "toolPolicy",
  "modelHint",
  "agent",
  "parameters",
  "workflowTitle",
  "workflowParameters",
  "steps",
  "run",
  "setup",
  "cwd",
  "activeRun",
  "keys",
  "related",
  "selectedRef",
  "parentRef",
  "fragmentOrdinal",
  "fragmentCount",
  "startLine",
  "endLine",
  "previousRef",
  "nextRef",
  "fragmentChars",
  "fragmentEstimatedTokens",
  "parentChars",
  "parentEstimatedTokens",
  "contextMode",
  "contextMaxChars",
  "contextTruncated",
  "path",
  "editable",
];

// Every optional `ExtractedSessionResult` field populated (`satisfies
// Required<...>`, same reasoning as `SAMPLE_SHOW_RESULT` above).
const SAMPLE_SESSION_RESULT = {
  sessionId: "s1",
  harness: "claude",
  candidateCount: 2,
  proposalIds: ["proposal-1"],
  rationaleIfEmpty: "no candidates survived triage",
  preFilter: { inputCount: 5, outputCount: 3, truncatedCount: 1 },
  warnings: ["one candidate skipped"],
  skipped: true,
  skipReason: "too_short",
  sessionAssetRef: "sessions/s1",
  sessionLogPath: "/logs/s1.jsonl",
  contentHash: "abc123",
  notices: [],
  engine: "default",
} satisfies Required<ExtractedSessionResult>;

// Literal, hand-written against `ExtractedSessionResult` — never
// `Object.keys(SAMPLE_SESSION_RESULT)`.
const EXTRACT_SESSION_KEYS = [
  "sessionId",
  "harness",
  "candidateCount",
  "proposalIds",
  "rationaleIfEmpty",
  "preFilter",
  "warnings",
  "skipped",
  "skipReason",
  "sessionAssetRef",
  "sessionLogPath",
  "contentHash",
  "notices",
  "engine",
];

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
  sessions: [SAMPLE_SESSION_RESULT],
  warnings: ["one session skipped"],
  durationMs: 1500,
  notices: [],
  skipReasons: { too_short: 1 },
  engine: "default",
  engineKind: "llm",
} satisfies Required<AkmExtractResult>;

// Literal, hand-written against `AkmExtractResult` — never
// `Object.keys(SAMPLE_EXTRACT_RESULT)`. `extract`'s shape handler is the
// identity passthrough (`makeStampHandler` in
// `src/output/shapes/passthrough.ts`), which only stamps `ok`/`shape`/
// `schemaVersion` when absent from the input — all three are already present
// here, so the shaped output's keys are exactly the input's keys.
const EXTRACT_RESULT_KEYS = [
  "schemaVersion",
  "ok",
  "shape",
  "dryRun",
  "type",
  "sessionsProcessed",
  "sessionsSkipped",
  "candidatesCreated",
  "proposals",
  "sessions",
  "warnings",
  "durationMs",
  "notices",
  "skipReasons",
  "engine",
  "engineKind",
];

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

    assertKeySet(shaped, ["hits", "registryHits", "results", "searchMode", "tip", "warnings"], "search envelope");
    const hit = (shaped.hits as Record<string, unknown>[])[0] ?? {};
    assertKeySet(
      hit,
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
      ],
      "search hit",
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

    assertKeySet(shaped, CURATE_ENVELOPE_KEYS, "curate envelope");
    const item = (shaped.items as Record<string, unknown>[])[0] ?? {};
    assertKeySet(
      item,
      ["source", "type", "name", "ref", "id", "supportRefs", "followUp", "reason"],
      "curate item (human, brief)",
    );
  });

  // both akm-plugins call sites (`claude/hooks/akm-hook.ts`
  // L1560, `opencode/index.ts` L593) run `akm curate ... --shape agent` and
  // read `type`/`score` off each item. The block above only pins the
  // `human`/`brief` projection, which never exercises `AGENT_FIELDS` in
  // `src/output/shapes/curate.ts` — dropping `score` from that list would
  // pass it. This block pins what the plugins actually parse.
  test("`akm curate --shape agent` item keys are pinned (used by both plugins)", () => {
    const result = {
      schemaVersion: 1,
      query: "deploy",
      summary: "1 result",
      items: [SAMPLE_CURATE_ITEM_AGENT],
      searchMode: "fts",
      warnings: ["semantic search pending"],
      tip: "run `akm show <ref>`",
    };
    const shaped = shapeForCommand("curate", result, "normal", "agent") as Record<string, unknown>;

    assertKeySet(shaped, CURATE_ENVELOPE_KEYS, "curate agent envelope");
    const item = (shaped.items as Record<string, unknown>[])[0] ?? {};
    assertKeySet(
      item,
      [
        "source",
        "type",
        "name",
        "ref",
        "path",
        "editable",
        "editHint",
        "id",
        "description",
        "supportRefs",
        "followUp",
        "reason",
        "score",
      ],
      "curate item (agent)",
    );
  });

  test("`akm show` envelope keys are pinned", () => {
    const shaped = shapeForCommand("show", SAMPLE_SHOW_RESULT, "brief", "human") as Record<string, unknown>;

    assertKeySet(shaped, SHOW_BRIEF_KEYS, "show envelope (human, brief)");
  });

  test("`akm info` envelope keys are pinned, including the `compat` manifest", () => {
    const info = assembleInfo({ dbPath: "/nonexistent/does-not-exist.db" });
    const shaped = shapeForCommand("info", info, "brief", "human") as Record<string, unknown>;

    assertKeySet(
      shaped,
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
      ],
      "info envelope",
    );
    assertKeySet(
      info.compat as unknown as Record<string, unknown>,
      [
        "indexGeneration",
        "stateLedgerHead",
        "taskSourceVersion",
        "configVersion",
        "workflowIrVersion",
        "pluginProtocol",
      ],
      "info.compat",
    );
    expect(info.compat.pluginProtocol).toBe(PLUGIN_PROTOCOL_VERSION);
  });

  test("`akm proposal extract` envelope keys are pinned", () => {
    const shaped = shapeForCommand("extract", SAMPLE_EXTRACT_RESULT, "brief", "human") as Record<string, unknown>;

    assertKeySet(shaped, EXTRACT_RESULT_KEYS, "extract envelope");
    const session = (shaped.sessions as Record<string, unknown>[])[0] ?? {};
    assertKeySet(session, EXTRACT_SESSION_KEYS, "extract session result");
  });
});
