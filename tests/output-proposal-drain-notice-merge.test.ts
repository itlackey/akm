// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { mergeNotices } from "../src/execution/notices";
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
