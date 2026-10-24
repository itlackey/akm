// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode SDK harness descriptor (#564).
 *
 * Descriptor only. The runner (`./sdk-runner`) imports `core/config`, so the
 * registry must never load it; `agent/runner-dispatch.ts` imports it directly.
 */

import { ConfigError } from "../../../core/errors";
import type { AgentDispatchRequest } from "../../agent/builder-shared";
import type { AgentProfile } from "../../agent/profiles";
import { createAgentRequestLowerer } from "../../agent/request-lowering";
import { MODEL_WORK_AGENT_INFERENCE } from "../opencode/model-config";
import { detectOpencodeMajor } from "../opencode/version";
import { caps } from "../shared";
import { BaseHarness } from "../types";

/**
 * Tool names only the other OpenCode major has, with this major's name for the
 * same tool. Tool names reach OpenCode as written, and a name it does not have
 * matches nothing, so `bash: false` would leave OpenCode 2's `shell` allowed.
 * Such a selection is refused rather than sent.
 */
const OTHER_MAJOR_TOOLS: Readonly<Record<1 | 2, Readonly<Record<string, string>>>> = {
  1: { shell: "bash", subagent: "task" },
  2: { bash: "shell", write: "edit", patch: "edit", apply_patch: "edit", task: "subagent" },
};

function toolNames(tools: AgentDispatchRequest["tools"]): string[] {
  if (typeof tools === "string") return tools.split(",").map((name) => name.trim());
  if (Array.isArray(tools)) return tools.filter((name): name is string => typeof name === "string");
  return tools ? Object.keys(tools) : [];
}

function refuseOtherMajorTools(profile: AgentProfile, tools: AgentDispatchRequest["tools"]): void {
  if (tools === undefined) return;
  const major = detectOpencodeMajor(profile.bin).major;
  const wrong = toolNames(tools).filter((name) => Object.hasOwn(OTHER_MAJOR_TOOLS[major], name));
  if (wrong.length === 0) return;
  const fixes = wrong.map((name) => `"${name}" is "${OTHER_MAJOR_TOOLS[major][name]}"`).join(", ");
  throw new ConfigError(
    `OpenCode ${major} has no tool named ${wrong.map((name) => `"${name}"`).join(", ")}; name its own tools in this selection (on OpenCode ${major}, ${fixes}).`,
    "INVALID_CONFIG_FILE",
  );
}

const lowerRequest = createAgentRequestLowerer({
  adapter: "opencode-sdk",
  personaChannel: "native",
  tools: "sdk",
  inference: MODEL_WORK_AGENT_INFERENCE,
});

/**
 * OpenCode SDK (embedded-SDK dispatch path).
 *
 * Dispatch-only: no native session logs, but detected at setup.
 */
export class OpencodeSdkHarness extends BaseHarness {
  readonly id = "opencode-sdk" as const;
  readonly displayName = "OpenCode SDK";
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  readonly executionLowerer = {
    platform: "opencode-sdk",
    personaChannel: "native" as const,
    lower: (profile: AgentProfile, request: Parameters<typeof lowerRequest>[1]) => {
      const lowered = lowerRequest(profile, request);
      refuseOtherMajorTools(profile, lowered.dispatch.tools);
      return lowered;
    },
  };
  // No flag-shaped resume: session reuse is programmatic — the SDK session id is
  // stored opportunistically on the unit row and passed back to
  // `session.prompt`, not replayed via a CLI flag.
  // No `identityEnv`: the SDK runs in-process; it does not mark a child
  // process environment with a session id of its own.
  readonly capabilities = caps({
    agentDispatch: true,
    detection: true,
    modelWork: true,
    nativeAgent: true,
  });
}
