// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reflect refuses a revision with a deterministic defect before any judge call
 * (`findReflectDefect`, wording from `processes.reflect.defectFilter`).
 * `akmReflect` opens state.db for the ledger and events, hence integration.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AkmReflectOptions, akmReflect } from "../../../../src/commands/improve/reflect";
import { findReflectDefect } from "../../../../src/commands/improve/reflect-noise";
import { listProposals } from "../../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../../src/core/config/config";
import { readEvents } from "../../../../src/core/events";
import { openStateDatabase } from "../../../../src/core/state-db";
import type { SpawnedSubprocess, SpawnFn } from "../../../../src/core/subprocess";
import { listImproveLedgerRows } from "../../../../src/storage/repositories/improve-ledger-repository";
import { quietQualityGateConfig, reflectReply } from "../../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const FRONTMATTER = [
  "---",
  "description: How the nightly export job runs",
  "type: knowledge",
  "sources:",
  "  - memories/export-job-notes",
  "---",
].join("\n");

const BODY = [
  "# Nightly export",
  "",
  "The export job runs at 02:00 and writes one file per tenant.",
  "",
  "1. Check the queue depth.",
  "2. Start the worker.",
].join("\n");

const asset = (body: string, frontmatter = FRONTMATTER) => `${frontmatter}\n\n${body}\n`;
const SOURCE = asset(BODY);
/** The source with `text` added at the end of the body. */
const withAdded = (text: string) => asset(`${BODY}\n\n${text}`);

describe("findReflectDefect", () => {
  /** [defectFilter list, the rule it feeds, a minimal bad edit]. */
  const BAD_EDITS = [
    ["placeholders", "placeholder_added", "Retention window: to be confirmed."],
    ["metaCommentary", "meta_commentary_added", "The feedback says the schedule is wrong."],
    ["frontmatterKeys", "frontmatter_copied_into_body", "updated: 2026-10-01"],
    ["frontmatterKeys", "frontmatter_copied_into_body", "Background: memories/export-job-notes."],
  ] as const;

  test.each(BAD_EDITS)("%s: the default list fires %s on a minimal bad edit (%s)", (_list, rule, added) => {
    expect(findReflectDefect(SOURCE, withAdded(added))).toBe(rule);
  });

  test.each([
    [
      "a reworded sentence",
      asset(BODY.replace("runs at 02:00 and writes one file per tenant.", "writes a file for every tenant at 02:00.")),
    ],
    [
      "a description repair",
      asset(BODY, FRONTMATTER.replace("How the nightly export job runs", "Runbook: the nightly export's schedule")),
    ],
    [
      "when_to_use added",
      asset(BODY, FRONTMATTER.replace("type: knowledge", "type: knowledge\nwhen_to_use: When an export is late")),
    ],
    ["TODO, FIXME and TBD markers", withAdded("TODO: link the runbook. FIXME: the retry count. Owner TBD.")],
    [
      "frontmatter-like lines inside a code fence",
      withAdded("Frontmatter looks like this:\n\n```yaml\ndescription: An example\ntype: knowledge\n```"),
    ],
  ])("%s does not fire", (_name, candidate) => {
    expect(findReflectDefect(SOURCE, candidate)).toBeUndefined();
  });

  test("wording the source already has and keeps does not count, one more does", () => {
    const kept = withAdded("Runbook link to be confirmed.\nThe feedback says nothing new yet.\ntype: knowledge");
    const reworded = kept.replace("Check the queue depth.", "Check the queue depth first.");

    expect(findReflectDefect(kept, reworded)).toBeUndefined();
    expect(findReflectDefect(kept, `${kept}Owner to be confirmed.\n`)).toBe("placeholder_added");
  });

  test("a configured list replaces the default; phrases are plain whole words in any case", () => {
    const placeholders = { placeholders: ["draft me", "a.b"] };

    expect(findReflectDefect(SOURCE, withAdded("To be confirmed."), placeholders)).toBeUndefined();
    expect(findReflectDefect(SOURCE, withAdded("Draft\n  ME later."), placeholders)).toBe("placeholder_added");
    expect(findReflectDefect(SOURCE, withAdded("The a.b setting."), placeholders)).toBe("placeholder_added");
    expect(findReflectDefect(SOURCE, withAdded("The axb setting."), placeholders)).toBeUndefined();
    expect(findReflectDefect(SOURCE, withAdded("Redraft meaning."), placeholders)).toBeUndefined();

    const keys = { frontmatterKeys: ["status"] };
    expect(findReflectDefect(SOURCE, withAdded("status: draft"), keys)).toBe("frontmatter_copied_into_body");
    expect(findReflectDefect(SOURCE, withAdded("updated: 2026-10-01"), keys)).toBeUndefined();
  });

  test.each(BAD_EDITS)("an empty %s list turns %s off (%s)", (list, _rule, added) => {
    expect(findReflectDefect(SOURCE, withAdded(added), { [list]: [] })).toBeUndefined();
  });
});

// ── akmReflect: refused before the judge ─────────────────────────────────────

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

const REF = "knowledge/nightly-export";

function fakeSpawn(stdout: string): SpawnFn {
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    });
  return () =>
    ({
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: stream(),
      stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      stdin: null,
      kill: () => undefined,
    }) as SpawnedSubprocess;
}

/** A judge engine with the quality gate on, or (`gate: false`) the gate off. */
function config(gate: boolean): AkmConfig {
  if (!gate) return quietQualityGateConfig();
  return {
    ...quietQualityGateConfig(),
    engines: {
      "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
      judge: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "judge-model" },
    },
    defaults: { engine: "fake-agent", llmEngine: "judge", improveStrategy: "default" },
    improve: { strategies: { default: { processes: { reflect: { qualityGate: { enabled: true } } } } } },
  } as AkmConfig;
}

/** Reflect `SOURCE` to a revision with `body`; `judgeCalls.count` is how often the judge was asked. */
async function reflect(body: string, gate: boolean, defectFilter?: AkmReflectOptions["defectFilter"]) {
  const judgeCalls = { count: 0 };
  const result = await akmReflect({
    ref: REF,
    stashDir: storage.stashDir,
    config: config(gate),
    assetContent: SOURCE,
    ...(defectFilter ? { defectFilter } : {}),
    runAgentOptions: { spawn: fakeSpawn(reflectReply(body)) },
    chat: async () => {
      judgeCalls.count += 1;
      return JSON.stringify({ scores: { need: 5, preservation: 5, quality: 5 }, reason: "fine" });
    },
  });
  return { result, judgeCalls };
}

describe("akm reflect — a deterministic defect", () => {
  const defective = `${BODY}\n\nRetention window: to be confirmed.`;

  test.each([
    ["on", true],
    ["off", false],
  ])("with the quality gate %s: refused as a quality rejection, the judge never asked", async (_state, gate) => {
    const { result, judgeCalls } = await reflect(defective, gate);

    if (result.ok) throw new Error("expected the defective revision to be refused");
    expect(result.reason).toBe("quality_rejected");
    expect(result.error).toContain("placeholder_added");
    expect(judgeCalls.count).toBe(0);
    expect(listProposals(storage.stashDir)).toEqual([]);
    const db = openStateDatabase();
    try {
      expect(listImproveLedgerRows(db, storage.stashDir, ["reflect"])).toMatchObject([
        { ref: REF, outcome: "quality_rejected", detail: "placeholder_added" },
      ]);
    } finally {
      db.close();
    }
    expect(readEvents({ type: "reflect_completed" }).events.at(-1)?.metadata).toMatchObject({
      qualityRejected: true,
      reflectDefect: "placeholder_added",
    });
  });

  test("with the rule's list emptied in the config, the same revision reaches the judge and is queued", async () => {
    const { result, judgeCalls } = await reflect(defective, true, { placeholders: [] });

    if (!result.ok) throw new Error(`expected a proposal, got: ${result.error}`);
    expect(judgeCalls.count).toBe(1);
    expect(listProposals(storage.stashDir)).toHaveLength(1);
  });
});
