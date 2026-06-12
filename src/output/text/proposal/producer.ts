// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for `akm reflect` / `akm propose` (#226).

import { formatProposalProducerPlain } from "../helpers";
import type { TextFormatterEntry } from "../registry";

export const proposalProducerFormatters: TextFormatterEntry[] = [
  { command: "reflect", handler: (r) => formatProposalProducerPlain("reflect", r) },
  { command: "propose", handler: (r) => formatProposalProducerPlain("propose", r) },
];
