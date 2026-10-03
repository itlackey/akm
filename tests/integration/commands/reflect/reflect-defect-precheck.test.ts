// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Reflect refuses a revision with a deterministic defect before any judge call.
 *
 * `findReflectDefect` (unit): three rules (a placeholder added, talk about the
 * edit itself, frontmatter copied into the body) each fire on a minimal bad
 * edit, stay quiet on benign ones, and count only what the revision adds.
 *
 * `akmReflect` (integration: it opens state.db for the ledger and events): a
 * hit is a `quality_rejected` refusal with the rule recorded, with the quality
 * gate on or off, and the judge is never called.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmReflect } from "../../../../src/commands/improve/reflect";
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

describe("findReflectDefect — each rule fires on a minimal bad edit", () => {
  test.each([
    "TODO: confirm the retention window.",
    "TBD",
    "FIXME: link the runbook.",
    "Please confirm the retention window with ops.",
    "The retention window is to be confirmed.",
    "# Title",
  ])("placeholder_added: %s", (added) => {
    expect(findReflectDefect(SOURCE, withAdded(added))).toBe("placeholder_added");
  });

  test.each([
    "The feedback says the schedule is wrong.",
    "This revision moves the start time.",
    "The source asset gave no retry policy.",
    "The original version of this note was vague.",
    "The quality gate rejected the earlier draft.",
  ])("meta_commentary_added: %s", (added) => {
    expect(findReflectDefect(SOURCE, withAdded(added))).toBe("meta_commentary_added");
  });

  test.each([
    "sources: memories/export-job-notes",
    "updated: 2026-10-01",
    "type: knowledge",
  ])("frontmatter_copied_into_body: the key line %s", (added) => {
    expect(findReflectDefect(SOURCE, withAdded(added))).toBe("frontmatter_copied_into_body");
  });

  test("frontmatter_copied_into_body: a provenance value of the frontmatter newly in the body", () => {
    expect(findReflectDefect(SOURCE, withAdded("Background: memories/export-job-notes."))).toBe(
      "frontmatter_copied_into_body",
    );
  });

  test("the first rule that hits is the one returned", () => {
    expect(findReflectDefect(SOURCE, withAdded("TODO: confirm.\nThe feedback says the schedule is wrong."))).toBe(
      "placeholder_added",
    );
  });
});

describe("findReflectDefect — benign edits are left to the judge", () => {
  test("rewording a sentence", () => {
    const reworded = BODY.replace(
      "The export job runs at 02:00 and writes one file per tenant.",
      "Each night at 02:00 the export job writes a file for every tenant.",
    );
    expect(findReflectDefect(SOURCE, asset(reworded))).toBeUndefined();
  });

  test("a description repair", () => {
    const repaired = FRONTMATTER.replace(
      "How the nightly export job runs",
      "Runbook for the nightly export job: its schedule, the per-tenant files and the worker start",
    );
    expect(findReflectDefect(SOURCE, asset(BODY, repaired))).toBeUndefined();
  });

  test("adding when_to_use", () => {
    const withWhenToUse = FRONTMATTER.replace(
      "type: knowledge",
      "type: knowledge\nwhen_to_use: When the nightly export is late or a tenant file is missing",
    );
    expect(findReflectDefect(SOURCE, asset(BODY, withWhenToUse))).toBeUndefined();
  });

  test("a heading that merely starts with the word Title", () => {
    expect(findReflectDefect(SOURCE, withAdded("# Title page layout"))).toBeUndefined();
  });

  test("frontmatter-like lines inside a fenced code block", () => {
    const example = "Frontmatter looks like this:\n\n```yaml\ndescription: An example\ntype: knowledge\n```";
    expect(findReflectDefect(SOURCE, withAdded(example))).toBeUndefined();
  });
});

describe("findReflectDefect — only what the revision adds counts", () => {
  const kept = withAdded("TODO: link the runbook.\nThe feedback says nothing new yet.\ntype: knowledge");

  test("a placeholder, meta commentary and a key line the source already has, kept through a rewording", () => {
    const reworded = kept.replace("Check the queue depth.", "Check the queue depth first.");
    expect(findReflectDefect(kept, reworded)).toBeUndefined();
  });

  test("a second placeholder on top of the source's is a defect", () => {
    expect(findReflectDefect(kept, `${kept}TODO: add the owner.\n`)).toBe("placeholder_added");
  });

  test("removing a placeholder is not a defect", () => {
    expect(findReflectDefect(kept, kept.replace("TODO: link the runbook.\n", ""))).toBeUndefined();
  });

  test("a provenance value the source body already mentions, kept through a rewording", () => {
    const mentioned = withAdded("Background: memories/export-job-notes.");
    const reworded = mentioned.replace("Check the queue depth.", "Check the queue depth first.");
    expect(findReflectDefect(mentioned, reworded)).toBeUndefined();
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

/** Reflect `source` to a revision with `body`; `judgeCalls.count` is how often the judge was asked. */
async function reflect(body: string, gate: boolean, source = SOURCE) {
  const judgeCalls = { count: 0 };
  const result = await akmReflect({
    ref: REF,
    stashDir: storage.stashDir,
    config: config(gate),
    assetContent: source,
    runAgentOptions: { spawn: fakeSpawn(reflectReply(body)) },
    chat: async () => {
      judgeCalls.count += 1;
      return JSON.stringify({ scores: { need: 5, preservation: 5, quality: 5 }, reason: "fine" });
    },
  });
  return { result, judgeCalls };
}

function reflectLedgerRows() {
  const db = openStateDatabase();
  try {
    return listImproveLedgerRows(db, storage.stashDir, ["reflect"]);
  } finally {
    db.close();
  }
}

describe("akm reflect — a deterministic defect is refused before the judge", () => {
  const defective = `${BODY}\n\nTODO: confirm the retention window.`;

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
    expect(reflectLedgerRows()).toMatchObject([{ ref: REF, outcome: "quality_rejected", detail: "placeholder_added" }]);
    expect(readEvents({ type: "reflect_completed" }).events.at(-1)?.metadata).toMatchObject({
      qualityRejected: true,
      reflectDefect: "placeholder_added",
    });
  });

  test("a revision the size guard flagged is refused too, not deferred to review", async () => {
    const longSource = asset(
      `${BODY}\n\n${"Each tenant file is checked against its manifest before upload.\n\n".repeat(10)}`,
    );

    const { result, judgeCalls } = await reflect(defective, true, longSource);

    if (result.ok) throw new Error("expected the defective revision to be refused");
    expect(result.reason).toBe("quality_rejected");
    expect(judgeCalls.count).toBe(0);
    expect(listProposals(storage.stashDir)).toEqual([]);
  });

  test("a revision without a defect still reaches the judge and is queued", async () => {
    const { result, judgeCalls } = await reflect(
      BODY.replace("Check the queue depth.", "Check the queue depth first."),
      true,
    );

    if (!result.ok) throw new Error(`expected a proposal, got: ${result.error}`);
    expect(judgeCalls.count).toBe(1);
    expect(listProposals(storage.stashDir)).toHaveLength(1);
  });
});
