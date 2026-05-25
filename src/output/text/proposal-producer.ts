// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for `akm reflect` / `akm propose` (#226).

import { formatProposalProducerPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("reflect", (r) => formatProposalProducerPlain("reflect", r));
registerTextFormatter("propose", (r) => formatProposalProducerPlain("propose", r));
