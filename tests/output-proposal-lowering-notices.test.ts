// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { shapeProposalProducerOutput } from "../src/output/shapes/helpers";
import { formatProposalDrainPlain, formatProposalProducerPlain } from "../src/output/text/proposal-format";

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
