/**
 * Backward-compatible facade for the LLM module.
 *
 * The implementation has been split into:
 * - `./llm-client`     — transport (chatCompletion, parseJsonResponse,
 *                       isLlmAvailable, probeLlmCapabilities, ChatMessage,
 *                       ChatCompletionOptions, stripJsonFences)
 * - `./metadata-enhance` — higher-level metadata enhancement workflow
 *                          (enhanceMetadata)
 *
 * New code should import from those modules directly. This re-export barrel
 * exists so existing call sites and tests that import from `./llm` keep
 * working without modification.
 */

export * from "./llm-client";
export { enhanceMetadata } from "./metadata-enhance";
