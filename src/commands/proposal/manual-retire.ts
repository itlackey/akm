// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A person retires an asset: the ordinary retire proposal, minted and accepted at once the way
 * `akm feedback`'s typed fix is. Undo is `POST /api/proposals/:id/revert`.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { parseRefInput } from "../../core/asset/resolve-ref";
import { resolveStashDir, toErrorMessage } from "../../core/common";
import { UsageError } from "../../core/errors";
import { warn } from "../../core/warn";
import { assertWriteLeaseFree } from "../../indexer/index-writer-lock";
import { isSingleFileDocumentType, resolveWritableIndexedAsset } from "../read/document";
import { akmProposalAccept } from "./proposal";
import { createRetireProposal, recordGateDecision, rejectProposalDurably } from "./repository";

export async function retireAsset(ref: string, revision: string) {
  const identity = parseRefInput(ref);
  if (identity.type === "skill" || !isSingleFileDocumentType(identity.type))
    throw new UsageError("Retire supports single-file assets, not skill packages or protected files.");
  await assertWriteLeaseFree("manual-retire");
  const { canonical, target, path: file } = await resolveWritableIndexedAsset(ref);
  if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== revision)
    throw new UsageError("The asset changed. Reload before retiring it.", "ASSET_CONTENT_CHANGED");
  const stashDir = resolveStashDir();
  const minted = createRetireProposal(stashDir, {
    ref: canonical,
    source: "propose",
    target: { source: target.source.name, root: target.source.path },
  });
  let accepted: Awaited<ReturnType<typeof akmProposalAccept>>["proposal"];
  try {
    recordGateDecision(stashDir, minted.id, { outcome: "auto-accepted", reason: "manual-retire", gate: "workspace" });
    accepted = (await akmProposalAccept({ stashDir, id: minted.id })).proposal;
  } catch (error) {
    try {
      rejectProposalDurably(stashDir, minted.id, `manual retire not applied: ${toErrorMessage(error)}`);
    } catch (rejectError) {
      warn(`[retire] could not reject proposal ${minted.id}: ${toErrorMessage(rejectError)}`);
    }
    throw error;
  }
  return {
    proposalId: accepted.id,
    ref: canonical,
    bundle: target.source.name,
    archiveDirs: accepted.retiredArchive?.dirs ?? [],
    warnings:
      identity.type === "task" ? ["Installed schedules are not changed. Run akm task sync to reconcile them."] : [],
  };
}
