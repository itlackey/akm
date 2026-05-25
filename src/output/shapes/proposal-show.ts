// Output shape registration for `akm proposal show` (#225).

import { shapeProposalShowOutput } from "./helpers";
import { registerOutputShape } from "./registry";

registerOutputShape("proposal-show", (result, detail) =>
  shapeProposalShowOutput(result as Record<string, unknown>, detail),
);
