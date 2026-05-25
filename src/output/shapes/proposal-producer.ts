// Output shape registration for `akm reflect` and `akm propose` (#226).
// Both share the proposal-producer envelope shape (success carries a proposal
// entry; failure carries an AgentFailureReason discriminant).

import { shapeProposalProducerOutput } from "./helpers";
import { registerOutputShape } from "./registry";

const handler = (result: unknown, detail: Parameters<typeof shapeProposalProducerOutput>[1]) =>
  shapeProposalProducerOutput(result as Record<string, unknown>, detail);

registerOutputShape("reflect", handler);
registerOutputShape("propose", handler);
