// Output shape registration for `akm proposal reject` (#225).

import { shapeProposalRejectOutput } from "./helpers";
import { registerOutputShape } from "./registry";

registerOutputShape("proposal-reject", (result, detail) =>
  shapeProposalRejectOutput(result as Record<string, unknown>, detail),
);
