// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for `akm registry *` commands.

import { formatRegistryAddPlain, formatRegistryListPlain, formatRegistryRemovePlain } from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const registryCommandFormatters: TextFormatterEntry[] = [
  { command: "registry-list", handler: (r) => formatRegistryListPlain(r) },
  { command: "registry-add", handler: (r) => formatRegistryAddPlain(r) },
  { command: "registry-remove", handler: (r) => formatRegistryRemovePlain(r) },
];
