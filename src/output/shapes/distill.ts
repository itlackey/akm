// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output shape registration for `akm distill <ref>` (#228). The shape is
// simple — outcome + ids + optional payload — so `brief` strips the full
// proposal blob, `normal` keeps the headline fields, and `full` projects
// everything for downstream automation.

import { shapeDistillOutput } from "./helpers";
import type { OutputShapeEntry } from "./registry";

export const distillShapes: OutputShapeEntry[] = [
  {
    command: "distill",
    handler: (result, detail) => shapeDistillOutput(result as Record<string, unknown>, detail),
  },
];
