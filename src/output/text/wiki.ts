// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for all `akm wiki *` commands.

import {
  formatWikiCreatePlain,
  formatWikiIngestPlain,
  formatWikiLintPlain,
  formatWikiListPlain,
  formatWikiPagesPlain,
  formatWikiRegisterPlain,
  formatWikiRemovePlain,
  formatWikiShowPlain,
  formatWikiStashPlain,
} from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const wikiFormatters: TextFormatterEntry[] = [
  { command: "wiki-list", handler: (r) => formatWikiListPlain(r) },
  { command: "wiki-show", handler: (r) => formatWikiShowPlain(r) },
  { command: "wiki-create", handler: (r) => formatWikiCreatePlain(r) },
  { command: "wiki-remove", handler: (r) => formatWikiRemovePlain(r) },
  { command: "wiki-pages", handler: (r) => formatWikiPagesPlain(r) },
  { command: "wiki-stash", handler: (r) => formatWikiStashPlain(r) },
  { command: "wiki-lint", handler: (r) => formatWikiLintPlain(r) },
  { command: "wiki-ingest", handler: (r) => formatWikiIngestPlain(r) },
  { command: "wiki-register", handler: (r) => formatWikiRegisterPlain(r) },
];
