// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export { removeEnv, writeEnv } from "./commands/env/env";
export { withSecretLock } from "./commands/env/secret";
export { akmLint } from "./commands/lint/index";
/** Experimental local operations; transport authentication belongs to the host. */
export { akmClone, type CloneOptions, type CloneResponse } from "./commands/sources/source-clone";
export { akmTasksSync } from "./commands/tasks/tasks";
export { handleApiRequest, NO_SUCH_ROUTE } from "./commands/ui/api";
export {
  assertWriteLeaseFree,
  classifyProposalError,
  handleWriteRequest,
  matchWriteRoute,
  type ProposalActionError,
  type WriteRoute,
} from "./commands/ui/proposal-actions";
export { scrubUrlCredentials } from "./commands/ui/redact";
export {
  classifyWorkspaceError,
  handleWorkspaceAction,
  matchWorkspaceAction,
  type WorkspaceAction,
} from "./commands/ui/workspace-actions";
export { assetPathForName, deriveCanonicalAssetName, stashDirFor } from "./core/asset/asset-placement";
export { parseRefInput } from "./core/asset/resolve-ref";
export { renameBundle } from "./core/bundle-rename";
export { isWithin, writeFileAtomic } from "./core/common";
// Existing operations used by the desktop's small, filesystem-based organizer.
export { loadConfig } from "./core/config/config";
export { sensitiveMarkerPath, withEnvSecretWrite } from "./core/env-secret-ref";
export { AkmError, type AkmErrorKind, UsageError } from "./core/errors";
export { resolveBundleWriteTarget } from "./core/mutation-target";
export { assertAkmAssetWrite, prepareWriteTargetForMutation, withWriteTargetMutation } from "./core/write-source";
export { withAssetMutationLease } from "./indexer/index-writer-lock";
export { indexWrittenAssets } from "./indexer/index-written-assets";
export { resolveSourceEntries } from "./indexer/search/search-source";
export { closeDatabase, openReadonlyExistingDatabase } from "./storage/repositories/index-connection";
export {
  getAllEntries,
  getEntryById,
  getEntryCount,
  getEntryIdByFilePath,
} from "./storage/repositories/index-entries-repository";
export { getMeta } from "./storage/repositories/index-meta-repository";
export {
  getAllEntriesForEmbedding,
  getNeighborsByEntryId,
  hasStoredEmbedding,
} from "./storage/repositories/index-vec-repository";
