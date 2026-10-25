// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ConfigError } from "../../core/errors";
import { withSchemaInstruction } from "../../core/structured";
import type { LoweringNotice, ResolvedExecutionRequestV1 } from "../../execution/resolved-request";
import { getHarness } from "../harnesses";
import type { AgentDispatchRequest, LoweredAgentDispatch } from "./builder-shared";
import { composeConversationFallbackPrompt } from "./conversation-fallback";
import { composePersonaFallbackPrompt } from "./persona-fallback";
import type { AgentProfile } from "./profiles";

/** What one harness can carry natively; everything else is composed into the prompt or noted. */
export interface AgentLowererOptions {
  readonly adapter: string;
  readonly personaChannel: "native" | "prompt";
  /** Inference keys this harness carries; any other key is reported untranslated. */
  readonly inference?: readonly string[];
  /**
   * What the transport can do, for one that is not a registered harness (akm's own
   * runtime); a registered harness's capabilities are read from its descriptor.
   */
  readonly capabilities?: { readonly nativeAgent: boolean; readonly modelWork: boolean };
}

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
 * Build one harness's request builder: map a resolved request onto the
 * harness-neutral {@link AgentDispatchRequest} its argv builder consumes,
 * composing into the prompt what the harness has no channel for.
 */
export function createAgentRequestLowerer(
  options: AgentLowererOptions,
): (profile: AgentProfile, request: ResolvedExecutionRequestV1) => LoweredAgentDispatch {
  const supportedInference = new Set(options.inference ?? []);
  const capabilities = () => options.capabilities ?? getHarness(options.adapter)?.capabilities;
  return (_profile, request) => {
    const notices: Readonly<LoweringNotice>[] = [];
    const skip = (field: string): void => {
      notices.push(untranslated(options.adapter, field));
    };

    let prompt = request.command.content;
    if (request.conversation && request.conversation.length > 0) {
      prompt = composeConversationFallbackPrompt(request.conversation, prompt);
      notices.push({
        code: "conversation-prompt-composed",
        severity: "warning",
        adapter: options.adapter,
        field: "conversation",
        message: `The ${options.adapter} transport has no native multi-message channel; AKM composed the conversation prefix into one deterministic JSON prompt block.`,
      });
    }
    const dispatch: AgentDispatchRequest = { prompt };
    if (request.persona) {
      if (options.personaChannel === "native") dispatch.systemPrompt = request.persona.content;
      else {
        const composed = composePersonaFallbackPrompt(request.persona.content, prompt, options.adapter);
        prompt = composed.prompt;
        notices.push(...composed.notices);
      }
    } else if (typeof request.agent === "string" && request.modelWork) {
      // Model work is not agent work: a native agent would replace the confined run.
      notices.push({
        code: "model-work-agent-ignored",
        severity: "warning",
        adapter: options.adapter,
        field: "agent",
        message: `The ${options.adapter} transport ignores native agent ${JSON.stringify(request.agent)} for model work.`,
      });
    } else if (typeof request.agent === "string") {
      if (!capabilities()?.nativeAgent) {
        throw new ConfigError(
          `The ${options.adapter} transport cannot consume native agent selector ${JSON.stringify(request.agent)}.`,
          "INVALID_CONFIG_FILE",
        );
      }
      dispatch.agent = request.agent;
    }
    // Every agent transport gets the schema as the one instruction; a harness
    // with a native channel (codex --output-schema) also reads dispatch.schema.
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
      if (capabilities()?.modelWork) dispatch.modelWork = true;
      else {
        notices.push({
          code: "model-work-unrestricted",
          severity: "info",
          adapter: options.adapter,
          field: "modelWork",
          message: `The ${options.adapter} transport cannot restrict its tools for model work; the run is unrestricted, in a scratch directory.`,
        });
      }
    }
    return { prompt, dispatch, notices };
  };
}
