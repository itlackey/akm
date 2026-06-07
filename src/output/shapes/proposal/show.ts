// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output shape registration for `akm proposal show` (#225).

import { shapeProposalShowOutput } from "../helpers";
import type { OutputShapeEntry } from "../registry";

export const proposalShowShapes: OutputShapeEntry[] = [
  {
    command: "proposal-show",
    handler: (result, detail) => shapeProposalShowOutput(result as Record<string, unknown>, detail),
  },
];
