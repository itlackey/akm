// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { register } from "node:module";

// Embedded text imports must be registered before evaluating the workspace graph.
register("./text-import-hook.mjs", import.meta.url);

const {
  AkmError,
  CONFLICT_CODES,
  ConfigError,
  NotFoundError,
  TransientError,
  UsageError,
  activity,
  assets,
  bundles,
  config,
  documents,
  feedback,
  indexWrittenAssets,
  proposals,
  scrubUrlCredentials,
  sensitive,
  setup,
} = await import("./workspace.js");

export {
  AkmError,
  CONFLICT_CODES,
  ConfigError,
  NotFoundError,
  TransientError,
  UsageError,
  activity,
  assets,
  bundles,
  config,
  documents,
  feedback,
  indexWrittenAssets,
  proposals,
  scrubUrlCredentials,
  sensitive,
  setup,
};
