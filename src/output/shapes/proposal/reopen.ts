// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output shape registration for `akm proposal reopen` (#997). One reopened
// proposal is the same envelope `reject` returns (`ok`, `id`, `ref`, an
// optional `reason` — here the reopen reason — and the shaped proposal), so it
// shares that shaper; several are the passthrough `proposal-reopen-batch`.

import { shapeProposalRejectOutput } from "../helpers";
import type { OutputShapeEntry } from "../registry";

export const proposalReopenShapes: OutputShapeEntry[] = [
  {
    command: "proposal-reopen",
    handler: (result, detail) => shapeProposalRejectOutput(result as Record<string, unknown>, detail),
  },
];
