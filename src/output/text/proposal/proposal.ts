// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for `akm proposal *` (#225).

import {
  formatProposalAcceptPlain,
  formatProposalDiffPlain,
  formatProposalDrainPlain,
  formatProposalListPlain,
  formatProposalRejectPlain,
  formatProposalShowPlain,
} from "../helpers";
import type { TextFormatterEntry } from "../registry";

export const proposalFormatters: TextFormatterEntry[] = [
  { command: "proposal-list", handler: (r) => formatProposalListPlain(r) },
  { command: "proposal-show", handler: (r) => formatProposalShowPlain(r) },
  { command: "proposal-accept", handler: (r) => formatProposalAcceptPlain(r) },
  { command: "proposal-reject", handler: (r) => formatProposalRejectPlain(r) },
  { command: "proposal-diff", handler: (r) => formatProposalDiffPlain(r) },
  { command: "proposal-drain", handler: (r) => formatProposalDrainPlain(r) },
];
