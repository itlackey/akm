// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { formatModelsPlain, formatModelsSetPlain } from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const modelsFormatters: TextFormatterEntry[] = [
  { command: "models", handler: (r) => formatModelsPlain(r) },
  { command: "models-set", handler: (r) => formatModelsSetPlain(r) },
];
