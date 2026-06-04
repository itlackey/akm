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
} from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("proposal-list", (r) => formatProposalListPlain(r));
registerTextFormatter("proposal-show", (r) => formatProposalShowPlain(r));
registerTextFormatter("proposal-accept", (r) => formatProposalAcceptPlain(r));
registerTextFormatter("proposal-reject", (r) => formatProposalRejectPlain(r));
registerTextFormatter("proposal-diff", (r) => formatProposalDiffPlain(r));
registerTextFormatter("proposal-drain", (r) => formatProposalDrainPlain(r));
