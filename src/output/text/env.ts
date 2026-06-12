// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for `akm env *` commands.

import {
  formatEnvCreatePlain,
  formatEnvExportPlain,
  formatEnvListPlain,
  formatEnvRemovePlain,
  formatEnvSetPlain,
  formatEnvUnsetPlain,
} from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const envFormatters: TextFormatterEntry[] = [
  { command: "env-list", handler: (r) => formatEnvListPlain(r) },
  { command: "env-create", handler: (r) => formatEnvCreatePlain(r) },
  { command: "env-export", handler: (r) => formatEnvExportPlain(r) },
  { command: "env-remove", handler: (r) => formatEnvRemovePlain(r) },
  { command: "env-set", handler: (r) => formatEnvSetPlain(r) },
  { command: "env-unset", handler: (r) => formatEnvUnsetPlain(r) },
];
