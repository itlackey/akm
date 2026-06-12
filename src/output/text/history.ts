// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatter for `akm history` — paired with the shape in shapes/history.ts.

import { formatHistoryPlain } from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const historyFormatters: TextFormatterEntry[] = [{ command: "history", handler: (r) => formatHistoryPlain(r) }];
