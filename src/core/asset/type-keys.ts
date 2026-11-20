// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The frontmatter keys akm knows for a type, with the ones its validators require. A key is required when its absence is
 * a finding of the check that owns it: `lintLessonContent` (a lesson's `description` and `when_to_use`),
 * `factDiagnostics` (a fact's `category`), `nameOrTypeDiagnostics` (a command's and an agent's `name` and `type`), the
 * workflow compiler (`steps`) and `missing-updated` (every Markdown asset). Anything else in a file is kept as written.
 */

import { KNOWN_CATEGORIES } from "../adapter/adapters/akm-lint";

export type FrontmatterKeyKind = "text" | "list" | "flag" | "map";

export interface FrontmatterKey {
  key: string;
  required: boolean;
  kind: FrontmatterKeyKind;
  /** The values akm accepts, when it checks against a fixed set. */
  values?: readonly string[];
  /** One line on what the key is for. */
  hint: string;
  /** akm sets the key when it writes the file, so a person need not. */
  stamped?: boolean;
}

const key = (
  name: string,
  kind: FrontmatterKeyKind,
  hint: string,
  options: Partial<Pick<FrontmatterKey, "required" | "values" | "stamped">> = {},
): FrontmatterKey => ({ key: name, kind, hint, required: options.required ?? false, ...options });

const description = (required = false) =>
  key("description", "text", "What the asset is, in one sentence.", { required });
const COMMON: FrontmatterKey[] = [
  description(),
  key("tags", "list", "Words that find the asset in search."),
  key("project", "text", "The project the asset belongs to."),
  key("updated", "text", "The date the asset was last changed.", { required: true, stamped: true }),
  key("aliases", "list", "Other names the asset is searched by."),
  key("searchHints", "list", "Phrases that should find the asset."),
  key("xrefs", "list", "Refs of related assets."),
  key("supersededBy", "list", "Refs of the assets that replace this one."),
  key("contradictedBy", "list", "Refs of the assets that contradict this one."),
  key("beliefState", "text", "Whether the asset is current, superseded or contradicted."),
];

const BY_TYPE: Record<string, FrontmatterKey[]> = {
  lesson: [
    description(true),
    key("when_to_use", "text", "The trigger that should make a caller apply the lesson.", { required: true }),
  ],
  fact: [key("category", "text", "Whose fact this is.", { required: true, values: [...KNOWN_CATEGORIES] })],
  command: [
    key("name", "text", "The command's name.", { required: true }),
    key("type", "text", "The asset type.", { required: true, stamped: true }),
  ],
  agent: [
    key("name", "text", "The agent's name.", { required: true }),
    key("type", "text", "The asset type.", { required: true, stamped: true }),
    key("model", "text", "The model the agent runs on."),
  ],
  workflow: [
    description(true),
    key("steps", "list", "The steps, in order, each with an id.", { required: true }),
    key("params", "map", "The parameters a run takes."),
  ],
  memory: [
    key("source", "text", "Where the memory came from."),
    key("observed", "text", "When it was observed."),
    key("expires", "text", "When it stops being true."),
    key("subjective", "flag", "An opinion rather than a fact."),
  ],
};

/** The keys for `type`, in the order a form shows them: description, tags, project and updated first. */
export function frontmatterKeysFor(type: string): FrontmatterKey[] {
  const own = BY_TYPE[type] ?? [];
  const merged = new Map<string, FrontmatterKey>();
  for (const known of [...COMMON, ...own]) merged.set(known.key, { ...merged.get(known.key), ...known });
  return [...merged.values()];
}
