// Output shape registration for `akm proposal accept` (#225).

import { shapeProposalAcceptOutput } from "./helpers";
import { registerOutputShape } from "./registry";

registerOutputShape("proposal-accept", (result, detail) =>
  shapeProposalAcceptOutput(result as Record<string, unknown>, detail),
);
