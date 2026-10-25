// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Internal entry point for the `agent` integration. CLI-only project — no
 * public exports map. Other akm modules import from this barrel for the
 * sake of grouping imports.
 *
 * Surface:
 *   • Types: AgentProfile, AgentRunResult, AgentFailureReason.
 *   • Profiles: getBuiltinAgentProfile, listBuiltinAgentProfiles.
 *   • Engine lowering lives in engine-resolution.ts; public config has no profile aliases.
 *   • Builder contract types: AgentDispatchRequest, BuiltCommand (harnesses/harness.ts).
 *   • Detection: detectAgentCliProfiles, defaultWhich.
 */

export type { SpawnedSubprocess, SpawnFn } from "../../core/subprocess";
export type { AgentDispatchRequest, BuiltCommand } from "../harnesses/harness";
export { DEFAULT_AGENT_TIMEOUT_MS } from "./config";
export type {
  AgentDetectionResult,
  WhichFn,
} from "./detect";
export { _setAgentDetectForTests, defaultWhich, detectAgentCliProfiles } from "./detect";
export type {
  AgentProfile,
  AgentStdioMode,
} from "./profiles";
export {
  getBuiltinAgentProfile,
  listBuiltinAgentProfiles,
} from "./profiles";
export type { AgentProposalPayload, ProposePromptInput, ReflectPromptInput } from "./prompts";
export { buildProposePrompt, buildReflectPrompt, parseAgentProposalPayload } from "./prompts";
export type {
  AgentFailureReason,
  AgentRunResult,
  RunAgentOptions,
} from "./spawn";
