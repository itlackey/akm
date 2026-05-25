// Output shape registration for `akm proposal list` (#225).

import { shapeProposalListOutput } from "./helpers";
import { registerOutputShape } from "./registry";

registerOutputShape("proposal-list", (result, detail) =>
  shapeProposalListOutput(result as Record<string, unknown>, detail),
);
