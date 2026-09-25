// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The fs-txn kind names `src/commands/proposal/repository.ts` registers.
 * Side-effect-free (no `registerTxnKind` call here) so a reader that only
 * needs the kind strings — `src/commands/health/txn-quarantine.ts` — does
 * not have to import `repository.ts` and trigger its registration.
 */

/** Kind of a `proposal` transaction (accept/revert). */
export const PROPOSAL_TXN_KIND = "proposal";

/** Kind of a `proposal-reject` transaction. */
export const REJECT_TXN_KIND = "proposal-reject";
