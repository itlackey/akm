// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output shape registration for `akm proposal new` (#226; formerly the
// top-level `akm propose`, moved under `proposal` in the 0.9 CLI overhaul, S8).
// Shares the proposal-producer envelope shape (success carries a proposal
// entry; failure carries an AgentFailureReason discriminant) with the
// internal `akmReflect` result shape — but `reflect` has no standalone CLI
// verb and never reaches the output() chokepoint (reflect.ts is called
// directly by the improve loop, not through this registry), so only
// `proposal new` is registered here.
//
// Deliberately phrased WITHOUT the literal call spelling: the registry
// completeness scanner (tests/output-shape-registry-completeness.test.ts)
// greps sources for that exact pattern to find commands needing a shape, and
// it does not skip comments — so writing the spelling here to explain the
// absence would re-summon the very registration this comment says is gone.

import { shapeProposalProducerOutput } from "../helpers";
import type { OutputShapeEntry } from "../registry";

const handler = (result: unknown, detail: Parameters<typeof shapeProposalProducerOutput>[1]) =>
  shapeProposalProducerOutput(result as Record<string, unknown>, detail);

export const proposalProducerShapes: OutputShapeEntry[] = [{ command: "proposal-new", handler }];
