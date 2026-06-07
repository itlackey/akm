// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output shape registration for `akm history` — paired with the text renderer in text.ts.

import { shapeHistoryOutput } from "./helpers";
import type { OutputShapeEntry } from "./registry";

export const historyShapes: OutputShapeEntry[] = [
  {
    command: "history",
    handler: (result, detail) => shapeHistoryOutput(result as Record<string, unknown>, detail),
  },
];
