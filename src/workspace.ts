// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// `akm-cli/workspace`: experimental re-exports of existing operations for a trusted
// local host (see docs/reference/api.md). Transport authentication belongs to the host.
// Declarations: scripts/node-runtime/workspace.d.ts, kept in step by tests/contracts/workspace-surface.test.ts.

export { removeEnv, writeEnv } from "./commands/env/env";
export { removeSecret, setSecret } from "./commands/env/secret";
export { akmClone, type CloneOptions, type CloneResponse } from "./commands/sources/source-clone";
export { handleApiRequest, NO_SUCH_ROUTE } from "./commands/ui/api";
export {
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
export { deriveCanonicalAssetName } from "./core/asset/asset-placement";
export {
  resolveEnvPath,
  resolveEnvWriteTarget,
  resolveSecretPath,
  resolveSecretWriteTarget,
  sensitiveMarkerPath,
  withEnvSecretWrite,
} from "./core/env-secret-ref";
export { AkmError, type AkmErrorKind, UsageError } from "./core/errors";
