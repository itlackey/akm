// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output shape registration for `akm proposal reject` (#225).

import { shapeProposalRejectOutput } from "../helpers";
import type { OutputShapeEntry } from "../registry";

export const proposalRejectShapes: OutputShapeEntry[] = [
  {
    command: "proposal-reject",
    handler: (result, detail) => shapeProposalRejectOutput(result as Record<string, unknown>, detail),
  },
];
