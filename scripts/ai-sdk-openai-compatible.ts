// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * An extra entry of the standalone build (`scripts/build-standalone.ts`): the
 * AI SDK package the embedded OpenCode reaches an OpenAI-compatible endpoint
 * with, bundled with its dependencies into the binary as
 * `ai-sdk-openai-compatible.js` beside the main module. The runtime points
 * OpenCode at it by file URL (`runner-models.ts`), so the binary has nothing to
 * download on its first run.
 */
export * from "@ai-sdk/openai-compatible";
