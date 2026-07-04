// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cloud provider endpoint + default-model lookup, used by the setup wizard's
 * `deriveRecommendedConfig` to map a detected cloud API-key provider to an LLM
 * connection. Data table in place of the former paired `switch` statements.
 */

export interface ProviderDefaults {
  endpoint: string;
  model: string;
}

/**
 * Endpoint + default model for each cloud provider akm can recommend from a
 * detected API key. A provider absent from this table yields no recommendation
 * (the previous paired `switch`es both returned `undefined`).
 */
export const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  anthropic: { endpoint: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" },
  openai: { endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  gemini: { endpoint: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-1.5-flash" },
  groq: { endpoint: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
};
