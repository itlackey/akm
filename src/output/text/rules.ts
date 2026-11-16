// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type ProjectView, withProjectLine } from "../../core/projects";
import type { TextFormatterEntry } from "./registry";

interface RulesOutput {
  project?: ProjectView;
  rules: Array<{ ref: string; content: string }>;
}

/** The project line when one applies, then each rule under its ref. */
export function formatRulesText(result: RulesOutput): string {
  const body =
    result.rules.length === 0
      ? "No rules apply here."
      : result.rules.map((rule) => `## ${rule.ref}\n\n${rule.content}`).join("\n\n");
  return withProjectLine(body, result.project);
}

export const rulesFormatters: TextFormatterEntry[] = [
  { command: "rules", handler: (r) => formatRulesText(r as unknown as RulesOutput) },
];
