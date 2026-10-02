// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ConfigError } from "../../core/errors";
import { withSchemaInstruction } from "../../core/structured";
import type { LoweringNotice, ResolvedExecutionRequestV1 } from "../../execution/resolved-request";
import { isModelWorkTools, type ToolSelection } from "../../execution/source";
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
  /** The harness has an exact native-agent selector flag. */
  readonly nativeAgentSelector?: boolean;
  /**
   * The harness builder confines the model-work tool policy (see
   * `MODEL_WORK_TOOLS`). Mirrored by `enforcesModelWorkTools` in
   * `harnesses/ids.ts`, which config validation reads.
   */
  readonly modelWorkTools?: boolean;
  /**
   * The inference keys this harness translates; a harness whose translation
   * depends on the request (opencode needs a `provider/model` to attach them
   * to) gives a function of it. Mirrored by `inference` in `harnesses/ids.ts`,
   * which config validation reads: its set is the most the function returns.
   */
  readonly inference?:
    | readonly string[]
    | ((profile: AgentProfile, request: ResolvedExecutionRequestV1) => readonly string[]);
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
  return (profile, request) => {
    const supportedInference = new Set(
      typeof options.inference === "function" ? options.inference(profile, request) : (options.inference ?? []),
    );
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
    // Every agent transport gets the schema as the one instruction; a harness
    // with a native channel (codex --output-schema) also reads dispatch.schema.
    if (request.outputSchema) {
      prompt = withSchemaInstruction(prompt, request.outputSchema);
      dispatch.schema = request.outputSchema as Record<string, unknown>;
    }
    dispatch.prompt = prompt;
    if (request.model) dispatch.model = request.model.resolved;
    if (Object.hasOwn(request, "inference")) {
      dispatch.inference = request.inference ?? null;
      for (const key of Object.keys(request.inference ?? {}).sort()) {
        if (!supportedInference.has(key)) skip(`inference.${key}`);
      }
    }
    if (isModelWorkTools(request.tools)) {
      if (!options.modelWorkTools) {
        throw new ConfigError(
          `The ${options.adapter} transport cannot enforce the model-work tool policy.`,
          "INVALID_CONFIG_FILE",
        );
      }
      // The builder selects its own confined agent or flags; another agent would replace them.
      if (dispatch.agent) {
        throw new ConfigError(
          `The ${options.adapter} transport cannot run native agent ${JSON.stringify(dispatch.agent)} under the model-work tool policy.`,
          "INVALID_CONFIG_FILE",
        );
      }
      dispatch.tools = request.tools as AgentDispatchRequest["tools"];
    } else if (request.tools !== undefined) {
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
