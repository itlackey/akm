// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Redaction for `akm ui`'s config view. Starts from `listConfig` (which already
 * drops literal `apiKey` values and normalises registry URLs) and then masks
 * anything secret-like by key name, because the UI shows config the CLI's
 * `config list` never had to defend against a browser leaking.
 *
 * Symbolic references (`$VAR`, `${VAR}`, `${secrets/name}`) are kept: they say
 * where a credential comes from without being one.
 */

import { isApiKeyReference } from "../../core/config/schema/primitives";
import { REDACTED, redactUrlCredentials } from "../../core/redaction";

/** Key names whose string values are credentials, or sit in a bag of them. */
const SECRET_KEY = /(api[-_]?key|token|password|passwd|secret|credential|authorization|bearer|private[-_]?key)/i;

/** A whole subtree of values (`env`, `secrets`) that is data, not settings. */
const SECRET_BAG_KEY = /^(env|secrets?)$/i;

/** `text` with the credentials in every URL it contains masked (`llm default: https://host/?token=x`). */
export function redactUrlsInText(text: string): string {
  return text.includes("://") ? text.replace(/https?:\/\/[^\s"'<>)\]]+/gi, (url) => redactUrlCredentials(url)) : text;
}

/**
 * Deep copy of an API response with the credentials in any URL masked. The
 * last line of defence for every endpoint: health and metrics evidence quotes
 * configured endpoints verbatim, and a configured URL can carry a token.
 */
export function scrubUrlCredentials(value: unknown): unknown {
  if (typeof value === "string") return redactUrlsInText(value);
  if (Array.isArray(value)) return value.map(scrubUrlCredentials);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrubUrlCredentials(child)]));
}

/** Deep copy of `value` with every secret-like string masked. */
export function redactForUi(value: unknown, inSecretBag = false): unknown {
  if (Array.isArray(value)) return value.map((child) => redactForUi(child, inSecretBag));
  if (typeof value === "string") {
    if (isApiKeyReference(value)) return value;
    return inSecretBag ? REDACTED : redactUrlCredentials(value);
  }
  if (!value || typeof value !== "object") return inSecretBag && value !== null ? REDACTED : value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string" && SECRET_KEY.test(key) && !isApiKeyReference(child)) {
      result[key] = REDACTED;
    } else {
      result[key] = redactForUi(child, inSecretBag || SECRET_BAG_KEY.test(key));
    }
  }
  return result;
}

/** Whether an environment variable name looks like it holds a credential. */
export function isSecretEnvName(name: string): boolean {
  return SECRET_KEY.test(name);
}
