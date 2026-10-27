// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1259: agents used to discover a document's sections by showing a fragment
 * that does not exist. What agents read now teaches the outline first:
 * `akm show <ref> --detail brief` for the `toc`, then `akm show <ref>#<slug>`.
 *
 * Pure string assertions on the embedded hints, the workflow unit preamble and
 * the `show` help; nothing is spawned or opened, so this belongs with the unit
 * tests.
 */

import { describe, expect, test } from "bun:test";
import unitPreamble from "../../src/assets/prompts/workflow-unit-preamble.md" with { type: "text" };
import { showCommand } from "../../src/commands/read/search-cli";
import { EMBEDDED_HINTS, EMBEDDED_HINTS_FULL } from "../../src/output/cli-hints";

const fold = (text: string) => text.replace(/\s+/g, " ");

describe("agent guidance on reading a large document (#1259)", () => {
  for (const [name, text] of [
    ["brief hints", EMBEDDED_HINTS],
    ["full hints", EMBEDDED_HINTS_FULL],
    ["workflow unit preamble", unitPreamble],
  ] as const) {
    test(`${name} send agents to the outline, then one section`, () => {
      const prose = fold(text);
      expect(prose).toContain("akm show <ref> --detail brief` returns its outline (`toc`, no body)");
      expect(prose).toContain("akm show <ref>#<slug>");
    });
  }

  test("the full hints no longer teach a deliberately unmatched fragment", () => {
    expect(EMBEDDED_HINTS_FULL).not.toContain("knowledge/guide#nope");
    expect(EMBEDDED_HINTS_FULL).toContain("akm show knowledge/guide --detail brief");
  });

  test("`akm show` help names the outline", () => {
    const args = showCommand.args as Record<string, { description?: string }>;
    expect(args.ref?.description).toContain("`--detail brief` returns the outline (`toc`, each heading's slug)");
    expect(args.ref?.description).not.toContain("unmatched");
  });
});
