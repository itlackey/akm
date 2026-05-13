import type { LlmConnectionConfig } from "../../core/config";
import type { AgentProfile } from "./profiles";
import { runAgentSdk } from "./sdk-runner";
import type { AgentRunResult, RunAgentOptions } from "./spawn";
import { runAgent } from "./spawn";

export interface AgentRunRequest {
  profile: AgentProfile;
  prompt?: string;
  runOptions?: RunAgentOptions;
  llmConfig?: LlmConnectionConfig;
}

export interface AgentRunner {
  name: string;
  supports(profile: AgentProfile): boolean;
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

const spawnAgentRunner: AgentRunner = {
  name: "spawn-agent-runner",
  supports(profile) {
    return profile.sdkMode !== true;
  },
  run(request) {
    return runAgent(request.profile, request.prompt, request.runOptions ?? {});
  },
};

const sdkAgentRunner: AgentRunner = {
  name: "sdk-agent-runner",
  supports(profile) {
    return profile.sdkMode === true;
  },
  run(request) {
    return runAgentSdk(request.profile, request.prompt ?? "", request.runOptions ?? {}, request.llmConfig);
  },
};

export const defaultAgentRunners: AgentRunner[] = [spawnAgentRunner, sdkAgentRunner];

export function selectAgentRunner(profile: AgentProfile, runners: AgentRunner[] = defaultAgentRunners): AgentRunner {
  const runner = runners.find((candidate) => candidate.supports(profile));
  if (!runner) {
    throw new Error(`No agent runner available for profile "${profile.name}".`);
  }
  return runner;
}

export async function runWithAgentRunner(
  request: AgentRunRequest,
  runners: AgentRunner[] = defaultAgentRunners,
): Promise<AgentRunResult> {
  return selectAgentRunner(request.profile, runners).run(request);
}
