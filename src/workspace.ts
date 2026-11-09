// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// `akm-cli/workspace`: typed application operations for a trusted local host such as akm Desktop (see
// docs/reference/api.md). Each namespace groups the operations of one capability; every operation takes one typed
// input and returns plain JSON-safe data, and throws an `AkmError` with a stable `code`. Transport (authentication,
// HTTP, status codes) belongs to the host.
// Declarations: scripts/node-runtime/workspace.d.ts, kept in step by tests/contracts/workspace-surface.test.ts.

export {
  AkmError,
  type AkmErrorKind,
  CONFLICT_CODES,
  ConfigError,
  NotFoundError,
  TransientError,
  UsageError,
} from "./core/errors";
export { indexWrittenAssets } from "./indexer/index-written-assets";
export * as activity from "./workspace/activity";
export * as assets from "./workspace/assets";
export * as bundles from "./workspace/bundles";
export * as config from "./workspace/config";
export * as documents from "./workspace/documents";
export * as feedback from "./workspace/feedback";
export * as proposals from "./workspace/proposals";
export { scrubUrlCredentials } from "./workspace/redact";
export * as sensitive from "./workspace/sensitive";
export * as setup from "./workspace/setup";
