/**
 * Internal entry point for the `agent` integration. CLI-only project — no
 * public exports map. Other akm modules import from this barrel for the
 * sake of grouping imports.
 *
 * Surface:
 *   • Types: AgentProfile, AgentConfig, AgentRunResult, AgentFailureReason.
 *   • Profiles: getBuiltinAgentProfile, listBuiltinAgentProfiles, BUILTIN_AGENT_PROFILE_NAMES.
 *   • Config: parseAgentConfig, resolveProfileFromConfig, requireAgentProfile, listResolvedAgentProfiles, listAgentProfileNames.
 *   • Spawn: runAgent.
 *   • Detection: detectAgentCliProfiles, pickDefaultAgentProfile, defaultWhich.
 */

export type { AgentCommandBuilder, AgentDispatchRequest, BuiltCommand } from "./builders";
export { getCommandBuilder } from "./builders";
export type {
  AgentConfig,
  AgentProfileConfig,
} from "./config";
export {
  DEFAULT_AGENT_TIMEOUT_MS,
  listAgentProfileNames,
  listResolvedAgentProfiles,
  parseAgentConfig,
  requireAgentProfile,
  resolveAgentProfile,
  resolveDefaultProfileName,
  resolveProfileFromConfig,
} from "./config";
export type {
  AgentDetectionResult,
  WhichFn,
} from "./detect";
export { defaultWhich, detectAgentCliProfiles, pickDefaultAgentProfile } from "./detect";
export type { PlatformModelMap } from "./model-aliases";
export { listBuiltinModelAliases, resolveModel } from "./model-aliases";
export type {
  AgentParseMode,
  AgentProfile,
  AgentStdioMode,
} from "./profiles";
export {
  BUILTIN_AGENT_PROFILE_NAMES,
  getBuiltinAgentProfile,
  listBuiltinAgentProfiles,
} from "./profiles";
export type { AgentProposalPayload, ProposePromptInput, ReflectPromptInput, SchemaRepairPromptInput } from "./prompts";
export {
  buildProposePrompt,
  buildReflectPrompt,
  buildSchemaRepairPrompt,
  parseAgentProposalPayload,
  stripJsonFences,
} from "./prompts";
export type { AgentRunner, AgentRunRequest } from "./runners";
export { runWithAgentRunner, selectAgentRunner } from "./runners";
export { runAgentSdk } from "./sdk-runner";
export type {
  AgentFailureReason,
  AgentRunResult,
  RunAgentOptions,
  SpawnedSubprocess,
  SpawnFn,
} from "./spawn";
export { runAgent } from "./spawn";
