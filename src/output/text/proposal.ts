// Output text formatters for `akm proposal *` (#225).

import {
  formatProposalAcceptPlain,
  formatProposalDiffPlain,
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
