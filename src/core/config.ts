// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Same-path re-export shim for the relocated config cluster (src/core/config/).
// Explicit named exports only (never `export *`) so the 82 importers stay
// byte-diff-free. Temporary scaffolding per the src-reorganization plan §5.

export type { AgentConfig } from "../integrations/agent/config";

export type { FeedbackFailureMode } from "./config/config";
export {
  DEFAULT_CONFIG,
  DEFAULT_GRAPH_EXTRACTION_BATCH_SIZE,
  FEEDBACK_FAILURE_MODES,
  getDefaultLlmConfig,
  getEffectiveRegistries,
  getIndexPassConfig,
  getSources,
  loadConfig,
  loadUserConfig,
  parseSourceSpec,
  requireLlmConfig,
  resetConfigCache,
  resolveBatchSize,
  resolveConfiguredSources,
  resolveSecret,
  saveConfig,
  stripJsonComments,
  updateConfig,
} from "./config/config";

export type {
  AgentProfileConfigV2,
  AkmConfig,
  BaseConnectionConfig,
  ConfiguredSource,
  EmbeddingConnectionConfig,
  ImproveConfig,
  ImproveProcessConfig,
  ImproveProfileConfig,
  IndexConfig,
  IndexConfigReservedKeys,
  IndexPassConfig,
  LlmCapabilities,
  LlmConnectionConfig,
  LlmProfileConfig,
  OutputConfig,
  RegistryConfigEntry,
  SourceConfigEntry,
  SourceConfigEntryOptions,
  SourceSpec,
} from "./config/config-types";
