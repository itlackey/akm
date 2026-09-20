// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ConfigError } from "../../core/errors";
import type { ExecutionJsonObject } from "../../execution/json";
import type { LoweringNotice, ResolvedExecutionRequestV1 } from "../../execution/resolved-request";
import type { ToolSelection } from "../../execution/source";
import type { AgentDispatchRequest, LoweredAgentDispatch } from "./builder-shared";
import { composeConversationFallbackPrompt } from "./conversation-fallback";
import { composePersonaFallbackPrompt } from "./persona-fallback";
import type { AgentProfile } from "./profiles";

export type ToolTranslation = "all" | "flat" | "sdk" | "none";

export interface AgentLowererOptions {
  readonly adapter: string;
  readonly personaChannel: "native" | "prompt";
  readonly tools: ToolTranslation;
  readonly outputSchema: boolean;
  /** This harness has a documented exact native-agent selector channel. */
  readonly nativeAgentSelector?: boolean;
  /** Exact inference keys this harness currently translates. */
  readonly inference?: readonly string[];
}

function own(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function hasToolSelection(value: ToolSelection): boolean {
  if (value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Object.keys(value).length > 0;
}

function translatesTools(mode: ToolTranslation, value: ToolSelection): boolean {
  if (!hasToolSelection(value)) return true;
  if (mode === "all") return true;
  if (mode === "flat") return typeof value === "string" || Array.isArray(value);
  if (mode === "sdk") {
    return (
      typeof value === "string" ||
      Array.isArray(value) ||
      (value !== null && Object.values(value).every((entry) => typeof entry === "boolean"))
    );
  }
  return false;
}

function notice(adapter: string, field: string): Readonly<LoweringNotice> {
  return Object.freeze({
    code: "untranslated-field",
    severity: "warning" as const,
    adapter,
    field,
    message: `The ${adapter} lowerer does not translate resolved field ${field}; dispatch will continue optimistically.`,
  });
}

function conversationFallbackNotice(adapter: string): Readonly<LoweringNotice> {
  return Object.freeze({
    code: "conversation-prompt-composed",
    severity: "warning" as const,
    adapter,
    field: "conversation",
    message: `The ${adapter} transport has no native multi-message channel; AKM composed the conversation prefix into one deterministic JSON prompt block.`,
  });
}

function selectedExtensionPaths(request: ResolvedExecutionRequestV1): string[] {
  const out: string[] = [];
  if (own(request, "extensions")) out.push("extensions");
  if (own(request.command, "extensions")) out.push("command.extensions");
  const persona = own(request, "persona") ? request.persona : undefined;
  if (persona && own(persona, "extensions")) out.push("persona.extensions");
  if (own(request.engine, "extensions")) out.push("engine.extensions");
  if (own(request.runtime, "extensions")) out.push("runtime.extensions");
  return out;
}

function sortedUnique(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort());
}

/**
 * Build one harness-owned structural lowerer. Each harness registers the
 * function it gets back beside its argv builder; no global model/provider
 * capability table participates in dispatch.
 */
export function createAgentRequestLowerer(
  options: AgentLowererOptions,
): (profile: AgentProfile, request: ResolvedExecutionRequestV1) => LoweredAgentDispatch {
  const supportedInference = new Set(options.inference ?? []);
  return (_profile, request) => {
    const translated = new Set<string>(["command.content", "engine"]);
    for (const field of ["timeoutMs", "workspace", "environment"] as const) {
      if (own(request.runtime, field)) translated.add(`runtime.${field}`);
    }
    const untranslated = new Set<string>();
    const notices: Readonly<LoweringNotice>[] = [];
    const reject = (field: string): void => {
      untranslated.add(field);
      notices.push(notice(options.adapter, field));
    };

    let prompt = request.command.content;
    if (own(request, "conversation")) {
      translated.add("conversation");
      if (request.conversation && request.conversation.length > 0) {
        prompt = composeConversationFallbackPrompt(request.conversation, prompt);
        notices.push(conversationFallbackNotice(options.adapter));
      }
    }
    let systemPrompt: string | undefined;
    const persona = own(request, "persona") ? request.persona : undefined;
    const agent = own(request, "agent") ? request.agent : undefined;
    let nativeAgent: string | undefined;
    if (persona) {
      if (options.personaChannel === "native") {
        systemPrompt = persona.content;
        translated.add("persona");
      } else {
        const composed = composePersonaFallbackPrompt(persona.content, prompt, options.adapter);
        prompt = composed.prompt;
        notices.push(...composed.notices);
        translated.add("persona");
      }
      if (typeof agent === "string") translated.add("agent");
    } else if (typeof agent === "string") {
      if (!options.nativeAgentSelector) {
        throw new ConfigError(
          `The ${options.adapter} transport cannot consume native agent selector ${JSON.stringify(agent)}.`,
          "INVALID_CONFIG_FILE",
        );
      }
      nativeAgent = agent;
      translated.add("agent");
    } else if (own(request, "agent")) {
      translated.add("agent");
    }

    const dispatch: Record<string, unknown> = { prompt };
    if (nativeAgent !== undefined) dispatch.agent = nativeAgent;
    if (systemPrompt !== undefined) dispatch.systemPrompt = systemPrompt;
    if (own(request, "model")) {
      translated.add("model");
      if (request.model) {
        dispatch.model = request.model.resolved;
      }
    }
    if (own(request, "inference")) {
      dispatch.inference = request.inference;
      const inference = request.inference;
      if (inference && Object.keys(inference).length > 0) {
        for (const key of Object.keys(inference).sort()) {
          const field = `inference.${key}`;
          if (supportedInference.has(key)) translated.add(field);
          else reject(field);
        }
        if (typeof inference.effort === "string") dispatch.effort = inference.effort;
      } else {
        translated.add("inference");
      }
    }
    if (own(request, "outputSchema")) {
      if (request.outputSchema === null || options.outputSchema) translated.add("outputSchema");
      else reject("outputSchema");
      if (request.outputSchema) dispatch.schema = request.outputSchema;
    }
    if (own(request, "tools")) {
      const tools = request.tools as ToolSelection;
      if (translatesTools(options.tools, tools)) translated.add("tools");
      else {
        throw new ConfigError(
          `The ${options.adapter} transport cannot enforce the resolved tool policy.`,
          "INVALID_CONFIG_FILE",
        );
      }
      dispatch.tools = tools;
    }
    if (own(request.runtime, "settings")) {
      const settings = request.runtime.settings as ExecutionJsonObject | null;
      if (settings === null || Object.keys(settings).length === 0) translated.add("runtime.settings");
      else reject("runtime.settings");
    }
    for (const field of selectedExtensionPaths(request)) reject(field);

    return Object.freeze({
      prompt,
      dispatch: Object.freeze(dispatch) as unknown as Readonly<AgentDispatchRequest>,
      translatedFields: sortedUnique(translated),
      untranslatedFields: sortedUnique(untranslated),
      notices: Object.freeze(notices),
    });
  };
}
