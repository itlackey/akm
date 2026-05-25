// Output text formatters for `akm reflect` / `akm propose` (#226).

import { formatProposalProducerPlain } from "./helpers";
import { registerTextFormatter } from "./registry";

registerTextFormatter("reflect", (r) => formatProposalProducerPlain("reflect", r));
registerTextFormatter("propose", (r) => formatProposalProducerPlain("propose", r));
