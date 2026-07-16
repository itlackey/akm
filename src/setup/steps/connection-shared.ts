// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared collect-input / probe / derive-config helpers for the wizard's
 * connection steps (§4.6 dedup of the three near-identical steps in
 * connection.ts). Prompt copy, validation messages, and the probe's spinner
 * text are shared VERBATIM so the wizard's observable flow is unchanged;
 * each step keeps its own option assembly and branching.
 */

import * as p from "../../cli/clack";
import type { LlmConnectionConfig } from "../../core/config/config";
import { probeLlmCapabilities } from "../../llm/client";
import type { LMStudioDetectionResult } from "../detect";
import { prompt, promptOrBack } from "../prompt";

// ── Derive-config ───────────────────────────────────────────────────────────

/** Standard chat-connection config shared by every provider branch. */
export function llmConnection(
  provider: LlmConnectionConfig["provider"],
  endpoint: string,
  model: string,
  extra?: Partial<LlmConnectionConfig>,
): LlmConnectionConfig {
  return {
    provider,
    endpoint,
    model,
    temperature: 0.3,
    maxTokens: 1024,
    ...(extra ?? {}),
  };
}

/** The "Keep current: ..." select option appended when a connection exists. */
export function keepCurrentOption(current: LlmConnectionConfig): { value: string; label: string; hint?: string } {
  return {
    value: "keep",
    label: `Keep current: ${current.provider ?? current.endpoint}`,
    hint: current.model,
  };
}

/** Hint text for the "LM Studio / local server" select option. */
export function lmStudioOptionHint(lmStudio: LMStudioDetectionResult | undefined): string {
  return lmStudio?.available
    ? `${lmStudio.models.length} model${lmStudio.models.length === 1 ? "" : "s"} detected`
    : "http://localhost:1234";
}

// ── Collect-input ───────────────────────────────────────────────────────────

/** Non-empty model-name text prompt shared by every provider branch. */
export async function promptModelName(opts: {
  message?: string;
  placeholder: string;
  defaultValue?: string;
}): Promise<string> {
  return prompt(() =>
    p.text({
      message: opts.message ?? "Model name:",
      placeholder: opts.placeholder,
      ...(opts.defaultValue ? { defaultValue: opts.defaultValue } : {}),
      validate: (v) => (!v?.trim() ? "Model name cannot be empty" : undefined),
    }),
  );
}

/** http(s)-validated endpoint text prompt shared by every endpoint branch. */
export async function promptEndpointUrl(opts: {
  message?: string;
  placeholder: string;
  defaultValue?: string;
  /** Scheme-validation message; the stepLlm custom branch words it differently. */
  schemeMessage?: string;
}): Promise<string> {
  const schemeMessage = opts.schemeMessage ?? "Must start with http:// or https://";
  return prompt(() =>
    p.text({
      message: opts.message ?? "Endpoint URL:",
      placeholder: opts.placeholder,
      ...(opts.defaultValue ? { defaultValue: opts.defaultValue } : {}),
      validate: (v) => {
        if (!v?.trim()) return "Endpoint cannot be empty";
        if (!v.startsWith("http://") && !v.startsWith("https://")) return schemeMessage;
      },
    }),
  );
}

/**
 * LM Studio model selection: pick from the detected models (with an
 * "Enter manually..." escape hatch) or fall back to a free-text prompt when
 * nothing was detected.
 */
export async function promptLmStudioModel(
  lmStudio: LMStudioDetectionResult | undefined,
  currentModel: string | undefined,
): Promise<string> {
  const lmsModels = lmStudio?.available && lmStudio.models.length > 0 ? lmStudio.models : [];
  if (lmsModels.length > 0) {
    const modelChoice = await prompt(() =>
      p.select({
        message: "Model name:",
        options: [
          ...lmsModels.map((m) => ({ value: m, label: m })),
          { value: "__manual__", label: "Enter manually..." },
        ],
        initialValue: currentModel && lmsModels.includes(currentModel) ? currentModel : lmsModels[0],
      }),
    );
    if (modelChoice !== "__manual__") return modelChoice;
  }
  return promptModelName({ placeholder: currentModel ?? "local-model", defaultValue: currentModel });
}

/**
 * Optional API-key ENV VAR NAME prompt (never the key value — saveConfig()
 * strips secrets). Escape backs out with `null`.
 */
export async function promptApiKeyEnvVarName(): Promise<string | null> {
  return promptOrBack(() =>
    p.text({
      message: "API key environment variable name (optional):",
      placeholder: "CUSTOM_LLM_API_KEY",
      validate: (value) =>
        value && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
          ? "Use an environment variable name, not a key value"
          : undefined,
    }),
  );
}

// ── Probe ───────────────────────────────────────────────────────────────────

/**
 * Best-effort structured-output probe — never blocks setup. Annotates
 * `llm.capabilities.structuredOutput` in place when the endpoint answers,
 * and warns (configuration is still saved) when it does not.
 */
export async function probeLlmConnection(llm: LlmConnectionConfig): Promise<void> {
  const probeSpin = p.spinner();
  probeSpin.start("Probing LLM (structured-output round-trip)...");
  const probe = await probeLlmCapabilities(llm);
  if (probe.reachable && probe.structuredOutput) {
    probeSpin.stop("LLM reachable; structured output verified.");
    llm.capabilities = { ...(llm.capabilities ?? {}), structuredOutput: true };
  } else if (probe.reachable) {
    probeSpin.stop("LLM reachable but structured-output probe failed.");
    llm.capabilities = { ...(llm.capabilities ?? {}), structuredOutput: false };
  } else {
    probeSpin.stop("LLM not reachable.");
    p.log.warn(
      `Could not reach the LLM endpoint${probe.error ? ` (${probe.error})` : ""}. Configuration was saved; verify your endpoint and API key, then retry.`,
    );
  }
}
