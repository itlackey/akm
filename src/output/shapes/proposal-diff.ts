// Output shape registration for `akm proposal diff` (#225).

import { shapeProposalDiffOutput } from "./helpers";
import { registerOutputShape } from "./registry";

registerOutputShape("proposal-diff", (result, detail) =>
  shapeProposalDiffOutput(result as Record<string, unknown>, detail),
);
