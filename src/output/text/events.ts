// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatter for `akm log` (#204).
//
// The formatter key is `log-list` — see src/output/shapes/events.ts.

import { formatEventsPlain } from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const eventsFormatters: TextFormatterEntry[] = [{ command: "log-list", handler: (r) => formatEventsPlain(r) }];
