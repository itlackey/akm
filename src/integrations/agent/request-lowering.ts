// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ConfigError } from "../../core/errors";
import { withSchemaInstruction } from "../../core/structured";
import type { LoweringNotice, ResolvedExecutionRequestV1 } from "../../execution/resolved-request";
import type { AgentDispatchRequest, LoweredAgentDispatch, LowerTarget } from "../harnesses/harness";
import { composeConversationFallbackPrompt } from "./conversation-fallback";
import { composePersonaFallbackPrompt } from "./persona-fallback";

/** The notice for a request field a transport does not carry; dispatch continues. */
export function untranslated(adapter: string, field: string): Readonly<LoweringNotice> {
  return {
    code: "untranslated-field",
    severity: "warning",
    adapter,
    field,
    message: `The ${adapter} lowerer does not translate resolved field ${field}; dispatch will continue optimistically.`,
  };
}

/**
 * Lower a resolved request for one target (a harness, or akm's own runtime): map
 * it onto the harness-neutral {@link AgentDispatchRequest} its builder consumes,
 * composing into the prompt what the target has no channel for.
 */
export function lowerRequest(target: LowerTarget, request: ResolvedExecutionRequestV1): LoweredAgentDispatch {
  const supportedInference = new Set(target.inference ?? []);
  const adapter = target.id;
  const notices: Readonly<LoweringNotice>[] = [];
  const skip = (field: string): void => {
    notices.push(untranslated(adapter, field));
  };

  let prompt = request.command.content;
  if (request.conversation && request.conversation.length > 0) {
    prompt = composeConversationFallbackPrompt(request.conversation, prompt);
    notices.push({
      code: "conversation-prompt-composed",
      severity: "warning",
      adapter,
      field: "conversation",
      message: `The ${adapter} transport has no native multi-message channel; AKM composed the conversation prefix into one deterministic JSON prompt block.`,
    });
  }
  const dispatch: AgentDispatchRequest = { prompt };
  if (request.persona) {
    if (target.systemPrompt) dispatch.systemPrompt = request.persona.content;
    else {
      const composed = composePersonaFallbackPrompt(request.persona.content, prompt, adapter);
      prompt = composed.prompt;
      notices.push(...composed.notices);
    }
  } else if (typeof request.agent === "string" && request.modelWork) {
    // Model work is not agent work: a native agent would replace the confined run.
    notices.push({
      code: "model-work-agent-ignored",
      severity: "warning",
      adapter,
      field: "agent",
      message: `The ${adapter} transport ignores native agent ${JSON.stringify(request.agent)} for model work.`,
    });
  } else if (typeof request.agent === "string") {
    if (!target.nativeAgent) {
      throw new ConfigError(
        `The ${adapter} transport cannot consume native agent selector ${JSON.stringify(request.agent)}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    dispatch.agent = request.agent;
  }
  // Every agent transport gets the schema as the one instruction.
  if (request.outputSchema) {
    prompt = withSchemaInstruction(prompt, request.outputSchema);
    dispatch.schema = request.outputSchema as Record<string, unknown>;
  }
  dispatch.prompt = prompt;
  if (request.model) dispatch.model = request.model.model;
  if (Object.hasOwn(request, "inference")) {
    dispatch.inference = request.inference ?? null;
    for (const key of Object.keys(request.inference ?? {}).sort()) {
      if (!supportedInference.has(key)) skip(`inference.${key}`);
    }
  }
  if (request.modelWork) {
    if (target.confinable) dispatch.modelWork = true;
    else {
      notices.push({
        code: "model-work-unrestricted",
        severity: "info",
        adapter,
        field: "modelWork",
        message: `The ${adapter} transport cannot restrict its tools for model work; the run is unrestricted, in a scratch directory.`,
      });
    }
  }
  return { prompt, dispatch, notices };
}
