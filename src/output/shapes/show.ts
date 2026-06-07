// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { shapeShowOutput } from "./helpers";
import type { OutputShapeEntry } from "./registry";

export const showShapes: OutputShapeEntry[] = [
  {
    command: "show",
    handler: (result, detail, shape) => shapeShowOutput(result as Record<string, unknown>, detail, shape),
  },
];
