// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { mergeNotices } from "../src/execution/notices";
import { shapeForCommand } from "../src/output/shapes";
import { shapeProposalProducerOutput } from "../src/output/shapes/helpers";
import { formatProposalDrainPlain, formatProposalProducerPlain } from "../src/output/text/proposal-format";
import { formatWorkflowRunPlain } from "../src/output/text/workflow-format";

const NOTICE = {
  code: "conversation-prompt-composed",
  severity: "warning" as const,
  adapter: "codex",
  field: "conversation",
  message: "conversation was composed safely",
  details: { strategy: "system-prefix" },
};

const RUN_RESULT = {
  run: { id: "run-1", status: "completed" },
  executed: [
    {
      stepId: "review",
      ok: true,
      unitCount: 1,
      failedUnits: 0,
      summary: "reviewed",
      notices: [NOTICE],
    },
  ],
  stepsProcessed: 1,
  done: true as const,
  notices: [NOTICE],
};

describe("workflow lowering notices are live output only", () => {
  test("workflow-run JSON passthrough preserves the typed top-level and per-step notices", () => {
    const shaped = shapeForCommand("workflow-run", RUN_RESULT, "normal") as Record<string, unknown>;
    expect(shaped.notices).toEqual([NOTICE]);
    expect((shaped.executed as Array<Record<string, unknown>>)[0]?.notices).toEqual([NOTICE]);
    expect(shaped.shape).toBe("workflow-run");
    expect(shaped.schemaVersion).toBe(1);
  });

  test("workflow run text renders each deduped top-level notice once", () => {
    const text = formatWorkflowRunPlain(RUN_RESULT);
    expect(text).toContain(
      "! lowering[warning] conversation-prompt-composed (codex; conversation): conversation was composed safely",
    );
    expect(text?.match(/conversation-prompt-composed/g)).toHaveLength(1);
  });
});

const SAFE_NOTICE = {
  code: "untranslated-field",
  severity: "warning",
  adapter: "fixture",
  field: "outputSchema",
  message: "The fixture lowerer will attempt dispatch without native schema translation.",
};

describe("proposal lowering notices reach structured and text output", () => {
  test("proposal-new shaping retains notices at ordinary detail", () => {
    const shaped = shapeProposalProducerOutput(
      {
        schemaVersion: 2,
        ok: false,
        reason: "spawn_failed",
        error: "provider rejected the optimistic request",
        type: "skill",
        name: "notice",
        engine: "fixture",
        exitCode: null,
        notices: [SAFE_NOTICE],
      },
      "normal",
    );

    expect(shaped.notices).toEqual([SAFE_NOTICE]);
  });

  test("proposal producer and drain text include stable notice identity", () => {
    const producer = formatProposalProducerPlain("proposal new", {
      ok: false,
      reason: "spawn_failed",
      error: "provider rejected the optimistic request",
      notices: [SAFE_NOTICE],
    });
    const drain = formatProposalDrainPlain({
      policy: "personal-stash",
      applyMode: "queue",
      promoted: [],
      rejected: [],
      deferred: [],
      skippedByCap: [],
      staged: [],
      notices: [SAFE_NOTICE],
    });

    for (const rendered of [producer, drain]) {
      expect(rendered).toContain("untranslated-field");
      expect(rendered).toContain("outputSchema");
      expect(rendered).not.toContain("provider-body-sentinel");
    }
  });
});

const RESOLUTION_NOTICE = {
  code: "engine-fallback",
  severity: "info" as const,
  adapter: "akm",
  message: "The configured fallback engine was selected.",
};

const DISPATCH_NOTICE = {
  code: "untranslated-field",
  severity: "warning" as const,
  adapter: "fixture",
  field: "outputSchema",
  message: "The fixture lowerer will attempt dispatch without native schema translation.",
};

function drainEnvelope(notices: ReturnType<typeof mergeNotices>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ok: true,
    applyMode: "queue",
    dryRun: true,
    strategy: "default",
    promoted: [],
    rejected: [],
    deferred: [],
    skippedByCap: [],
    staged: [],
    ...(notices ? { notices } : {}),
  };
}

describe("proposal drain lowering notice aggregation", () => {
  test("the CLI envelope cannot overwrite merged resolution notices with drain-only notices", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "../src/commands/proposal/proposal-cli.ts"), "utf8");
    const outputStart = source.indexOf('output("proposal-drain", {');
    const outputEnd = source.indexOf("\n    });", outputStart);
    const outputBlock = source.slice(outputStart, outputEnd);

    expect(outputStart).toBeGreaterThanOrEqual(0);
    expect(outputEnd).toBeGreaterThan(outputStart);
    expect(outputBlock).toContain("...(notices ? { notices } : {})");
    expect(outputBlock).not.toContain("result.notices");
  });

  test("a dispatch-only notice survives structured and text output", () => {
    const notices = mergeNotices(undefined, [DISPATCH_NOTICE]);
    const envelope = drainEnvelope(notices);

    expect(notices).toEqual([DISPATCH_NOTICE]);
    expect(JSON.stringify(envelope)).toContain("untranslated-field");
    expect(formatProposalDrainPlain(envelope)).toContain("untranslated-field");
  });

  test("resolution and dispatch notices retain stable order and exact duplicates collapse", () => {
    const notices = mergeNotices(
      [RESOLUTION_NOTICE, DISPATCH_NOTICE],
      [DISPATCH_NOTICE, { ...DISPATCH_NOTICE, field: "inference.vendorKnob" }],
    );

    expect(notices).toEqual([
      RESOLUTION_NOTICE,
      DISPATCH_NOTICE,
      { ...DISPATCH_NOTICE, field: "inference.vendorKnob" },
    ]);
    expect(Object.isFrozen(notices)).toBe(true);
    expect(mergeNotices([], [])).toBeUndefined();
  });
});
