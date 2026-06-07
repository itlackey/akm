// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { formatShowPlain } from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const showFormatters: TextFormatterEntry[] = [
  { command: "show", handler: (r, detail) => formatShowPlain(r, detail) },
];
