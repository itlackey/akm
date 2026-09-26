// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { mergeProposalDrainNotices } from "../src/commands/proposal/proposal-cli";
import { formatProposalDrainPlain } from "../src/output/text/proposal-format";

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

function drainEnvelope(notices: ReturnType<typeof mergeProposalDrainNotices>): Record<string, unknown> {
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
    const notices = mergeProposalDrainNotices(undefined, [DISPATCH_NOTICE]);
    const envelope = drainEnvelope(notices);

    expect(notices).toEqual([DISPATCH_NOTICE]);
    expect(JSON.stringify(envelope)).toContain("untranslated-field");
    expect(formatProposalDrainPlain(envelope)).toContain("untranslated-field");
  });

  test("resolution and dispatch notices retain stable order and exact duplicates collapse", () => {
    const notices = mergeProposalDrainNotices(
      [RESOLUTION_NOTICE, DISPATCH_NOTICE],
      [DISPATCH_NOTICE, { ...DISPATCH_NOTICE, field: "tools" }],
    );

    expect(notices).toEqual([RESOLUTION_NOTICE, DISPATCH_NOTICE, { ...DISPATCH_NOTICE, field: "tools" }]);
    expect(Object.isFrozen(notices)).toBe(true);
    expect(mergeProposalDrainNotices([], [])).toBeUndefined();
  });
});
