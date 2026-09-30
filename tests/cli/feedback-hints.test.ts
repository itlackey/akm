// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #999: the shipped agent hints told agents to record `--negative` "when it
 * fails", and agents read that as recording a failed `akm show`. The failure
 * text then reached distill and reflect as evidence about the asset's content
 * (lessons about the tool error, `TODO` placeholders in a memory). The hints
 * agents actually read now say a failed command is not feedback on the asset.
 *
 * Pure string assertions on the embedded hints and the flag help; nothing is
 * spawned or opened, so this belongs with the unit tests.
 */

import { describe, expect, test } from "bun:test";
import { feedbackCommand } from "../../src/commands/feedback-cli";
import { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL } from "../../src/output/cli-hints";

describe("shipped hints on recording feedback (#999)", () => {
  for (const [name, hints] of [
    ["brief", EMBEDDED_HINTS],
    ["full", EMBEDDED_HINTS_FULL],
  ] as const) {
    test(`${name} hints say a failing akm command is not feedback on the asset`, () => {
      // The hints are hard-wrapped prose; compare with line breaks folded.
      const prose = hints.replace(/\s+/g, " ");
      expect(prose).toContain("An akm command that fails says nothing about the asset; don't record it as feedback.");
    });

    test(`${name} hints no longer tell agents to give feedback when something "fails"`, () => {
      expect(hints).not.toContain("when it fails");
      expect(hints).not.toContain("helps or fails");
    });
  }

  test("the brief task loop ties --negative to the asset's content and names the akm show example", () => {
    expect(EMBEDDED_HINTS).toContain("when its content was wrong, stale or unhelpful");
    expect(EMBEDDED_HINTS).toContain("A failed akm command (e.g. `akm show` erroring) is not feedback on the asset");
  });

  test("`akm feedback --reason` help asks for the asset's content and rules out command errors", () => {
    const args = feedbackCommand.args as Record<string, { description?: string }>;

    expect(args.reason?.description).toContain("the asset's content");
    expect(args.reason?.description).toContain("Not for akm command errors");
  });
});
