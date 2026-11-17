// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The library graph `assets.graph` returns, and the colour families its asset types fold into. */

export interface GraphPayload {
  available: boolean;
  note: string;
  types: string[];
  /** Largest first, so the biggest bundles take the first colour slots. */
  bundles: string[];
  /** Distinct belief states present, e.g. "superseded"; `nodes.belief` indexes it (-1: none). */
  beliefs: string[];
  /** The window the use figures cover: reads by people and their agents since `since`, not scheduled tasks or Improve. */
  use: { since: string; source: "user" } | null;
  /** The same window for feedback counts; `null` when akm could not read them. */
  feedback: { since: string; source: "user" } | null;
  kinds: string[];
  nodes: {
    ref: string[];
    type: number[];
    bundle: number[];
    belief: number[];
    shows: number[];
  };
  links: { from: number[]; to: number[]; kind: number[] };
}

/**
 * Asset types fold into eight colour families: eight is the most a categorical palette separates. A type akm does not
 * list (a custom type) is Other.
 */
export const FAMILIES = [
  { label: "Knowledge", types: ["knowledge"] },
  { label: "Memories and facts", types: ["memory", "fact"] },
  { label: "Skills", types: ["skill"] },
  { label: "Lessons", types: ["lesson"] },
  { label: "Commands and scripts", types: ["command", "script"] },
  { label: "Workflows and tasks", types: ["workflow", "task"] },
  { label: "Agents, instructions, rules", types: ["agent", "instruction", "rule"] },
  { label: "Other", types: [] as string[] },
] as const;
const OTHER = FAMILIES.length - 1;
export const familyOf = (type: string) => {
  const at = FAMILIES.findIndex((family) => (family.types as readonly string[]).includes(type));
  return at === -1 ? OTHER : at;
};
