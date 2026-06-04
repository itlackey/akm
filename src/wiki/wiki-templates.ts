// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import indexTemplate from "./index-template.md" with { type: "text" };
import logTemplate from "./log-template.md" with { type: "text" };
import schemaTemplate from "./schema-template.md" with { type: "text" };

export function buildSchemaMd(wikiName: string): string {
  return schemaTemplate.replaceAll("{{WIKI_NAME}}", wikiName);
}

export function buildIndexMd(wikiName: string): string {
  return indexTemplate.replaceAll("{{WIKI_NAME}}", wikiName);
}

export function buildLogMd(wikiName: string): string {
  return logTemplate.replaceAll("{{WIKI_NAME}}", wikiName);
}
