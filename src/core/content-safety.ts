// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Marker emitted by output redaction. It must never become durable asset content. */
export const REDACTED_CONTENT_MARKER = "[REDACTED]";

/** Reflect prompt section that contains run diagnostics, not proposed asset content. */
export const REFLECT_AVOID_PATTERNS_HEADING = "Avoid These Patterns";

const REFLECT_AVOID_PATTERNS_RE = /^##[ \t]+Avoid These Patterns[ \t]*$/i;

export function containsRedactedContent(content: string): boolean {
  return content.includes(REDACTED_CONTENT_MARKER);
}

export function containsReflectPromptScaffolding(content: string): boolean {
  return content.split(/\r?\n/).some((line) => REFLECT_AVOID_PATTERNS_RE.test(line));
}

/**
 * Return a secret-free rejection reason when generated content is unsafe to
 * persist. `redactedContent` is the same body after applying the dispatch
 * lease's sensitive-value inventory; comparing it avoids exposing the value.
 */
export function generatedContentRejection(content: string, redactedContent: string): string | undefined {
  if (containsRedactedContent(content)) {
    return `Agent proposal content contains ${REDACTED_CONTENT_MARKER}; refusing to persist already-redacted text.`;
  }
  if (redactedContent !== content) {
    return "Agent proposal content echoed a configured credential; refusing to persist either the secret or a redacted replacement.";
  }
  return undefined;
}
