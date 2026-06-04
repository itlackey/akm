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
import { registerTextFormatter } from "./registry";

registerTextFormatter("wiki-list", (r) => formatWikiListPlain(r));
registerTextFormatter("wiki-show", (r) => formatWikiShowPlain(r));
registerTextFormatter("wiki-create", (r) => formatWikiCreatePlain(r));
registerTextFormatter("wiki-remove", (r) => formatWikiRemovePlain(r));
registerTextFormatter("wiki-pages", (r) => formatWikiPagesPlain(r));
registerTextFormatter("wiki-stash", (r) => formatWikiStashPlain(r));
registerTextFormatter("wiki-lint", (r) => formatWikiLintPlain(r));
registerTextFormatter("wiki-ingest", (r) => formatWikiIngestPlain(r));
registerTextFormatter("wiki-register", (r) => formatWikiRegisterPlain(r));
