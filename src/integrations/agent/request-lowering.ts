// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ConfigError } from "../../core/errors";
import type { LoweringNotice, ResolvedExecutionRequestV1 } from "../../execution/resolved-request";
import type { ToolSelection } from "../../execution/source";
import type { AgentDispatchRequest, LoweredAgentDispatch } from "./builder-shared";
import { composeConversationFallbackPrompt } from "./conversation-fallback";
import { composePersonaFallbackPrompt } from "./persona-fallback";
import type { AgentProfile } from "./profiles";

export type ToolTranslation = "all" | "flat" | "sdk" | "none";

/** What one harness can carry natively; everything else is composed into the prompt or noted. */
export interface AgentLowererOptions {
  readonly adapter: string;
  readonly personaChannel: "native" | "prompt";
  readonly tools: ToolTranslation;
  readonly outputSchema: boolean;
  /** The harness has an exact native-agent selector flag. */
  readonly nativeAgentSelector?: boolean;
  /** Inference keys this harness translates. */
  readonly inference?: readonly string[];
}

/** A tool selection that actually names tools (not omitted, null, or empty). */
export function hasToolSelection(value: ToolSelection | undefined): value is Exclude<ToolSelection, null> {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

function translatesTools(mode: ToolTranslation, value: ToolSelection): boolean {
  if (mode === "all") return true;
  if (typeof value === "string" || Array.isArray(value)) return mode === "flat" || mode === "sdk";
  return mode === "sdk" && value !== null && Object.values(value).every((entry) => typeof entry === "boolean");
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

/** Request fields carrying adapter-owned extensions, which no transport translates. */
export function extensionFields(request: ResolvedExecutionRequestV1): string[] {
  return [
    ...(request.extensions ? ["extensions"] : []),
    ...(request.command.extensions ? ["command.extensions"] : []),
    ...(request.persona?.extensions ? ["persona.extensions"] : []),
    ...(request.engine.extensions ? ["engine.extensions"] : []),
    ...(request.runtime.extensions ? ["runtime.extensions"] : []),
  ];
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
    } else if (typeof request.agent === "string") {
      if (!options.nativeAgentSelector) {
        throw new ConfigError(
          `The ${options.adapter} transport cannot consume native agent selector ${JSON.stringify(request.agent)}.`,
          "INVALID_CONFIG_FILE",
        );
      }
      dispatch.agent = request.agent;
    }
    dispatch.prompt = prompt;
    if (request.model) dispatch.model = request.model.resolved;
    if (Object.hasOwn(request, "inference")) {
      dispatch.inference = request.inference ?? null;
      for (const key of Object.keys(request.inference ?? {}).sort()) {
        if (!supportedInference.has(key)) skip(`inference.${key}`);
      }
      if (typeof request.inference?.effort === "string") dispatch.effort = request.inference.effort;
    }
    if (request.outputSchema) {
      if (!options.outputSchema) skip("outputSchema");
      dispatch.schema = request.outputSchema as Record<string, unknown>;
    }
    if (request.tools !== undefined) {
      // An explicit empty selection still reaches the builder (e.g. an empty allowlist).
      if (hasToolSelection(request.tools) && !translatesTools(options.tools, request.tools)) {
        throw new ConfigError(
          `The ${options.adapter} transport cannot enforce the resolved tool policy.`,
          "INVALID_CONFIG_FILE",
        );
      }
      dispatch.tools = request.tools as AgentDispatchRequest["tools"];
    }
    const settings = request.runtime.settings;
    if (settings && Object.keys(settings).length > 0) skip("runtime.settings");
    for (const field of extensionFields(request)) skip(field);
    return { prompt, dispatch, notices };
  };
}
