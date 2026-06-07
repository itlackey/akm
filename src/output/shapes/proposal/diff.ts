// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output shape registration for `akm proposal diff` (#225).

import { shapeProposalDiffOutput } from "../helpers";
import type { OutputShapeEntry } from "../registry";

export const proposalDiffShapes: OutputShapeEntry[] = [
  {
    command: "proposal-diff",
    handler: (result, detail) => shapeProposalDiffOutput(result as Record<string, unknown>, detail),
  },
];
