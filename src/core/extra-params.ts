// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export const EXTRA_PARAMS_PROTECTED_TOP_LEVEL_KEYS = [
  "model",
  "messages",
  "temperature",
  "maxtokens",
  "responseformat",
  "stream",
  "streamoptions",
  "enablethinking",
  "reasoningeffort",
  "chattemplatekwargs",
] as const;

export const EXTRA_PARAMS_CREDENTIAL_KEYS = [
  "authorization",
  "headers",
  "apikey",
  "token",
  "password",
  "secret",
  "cookie",
  "setcookie",
] as const;

const PROTECTED_TOP_LEVEL_KEYS = new Set<string>(EXTRA_PARAMS_PROTECTED_TOP_LEVEL_KEYS);
const CREDENTIAL_KEYS = new Set<string>(EXTRA_PARAMS_CREDENTIAL_KEYS);

// ── Protected-key remedies (#852) ───────────────────────────────────────────
//
// `EXTRA_PARAMS_PROTECTED_TOP_LEVEL_KEYS` rightly stops a provider extra from
// shadowing an AKM-managed field, but naming the rule without naming the fix
// leaves the reader stuck (#852). Every protected key gets a one-line remedy
// baked into its issue message.

/** normalizeExtraParamKey(key) -> the first-class engine field it shadows. */
const LEGACY_EXTRA_PARAMS_FIELD: Readonly<Record<string, string>> = {
  model: "model",
  temperature: "temperature",
  maxtokens: "maxTokens",
  enablethinking: "enableThinking",
  reasoningeffort: "reasoningEffort",
};

/** Remedies for protected keys with no scalar first-class field. */
const EXTRA_PARAMS_NO_FIELD_REMEDY: Readonly<Record<string, string>> = {
  messages: "AKM builds the request messages internally — remove it from extraParams",
  responseformat: "AKM controls the response format internally — remove it from extraParams",
  stream: "AKM controls streaming internally — remove it from extraParams",
  streamoptions: "AKM controls streaming internally — remove it from extraParams",
  chattemplatekwargs: "set engines.<name>.enableThinking instead of chat_template_kwargs.enable_thinking",
};

function protectedKeyRemedy(normalized: string): string | undefined {
  const field = LEGACY_EXTRA_PARAMS_FIELD[normalized];
  if (field) {
    const note = normalized === "reasoningeffort" ? " (moved to a first-class field in 0.9.2)" : "";
    return `set engines.<name>.${field} instead${note}`;
  }
  return EXTRA_PARAMS_NO_FIELD_REMEDY[normalized];
}

export interface ExtraParamsIssue {
  path: (string | number)[];
  message: string;
}

export function normalizeExtraParamKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Validate provider extras without allowing them to override AKM fields or carry credentials. */
export function validateExtraParams(value: unknown): ExtraParamsIssue[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ path: [], message: "must be an object" }];
  }

  const issues: ExtraParamsIssue[] = [];
  // A self-referential YAML anchor (`extraParams: &a { nested: *a }`) resolves
  // to a genuinely cyclic object — the yaml package's alias-count guard does not
  // catch cycles — so an unguarded walk overflowed the stack with a RangeError
  // that escaped task parsing. Track visited containers and stop at a revisit.
  const seen = new WeakSet<object>();
  const visit = (entry: unknown, path: (string | number)[]): void => {
    if (Array.isArray(entry)) {
      if (seen.has(entry)) return;
      seen.add(entry);
      entry.forEach((child, index) => {
        visit(child, [...path, index]);
      });
      return;
    }
    if (!entry || typeof entry !== "object") return;
    if (seen.has(entry)) return;
    seen.add(entry);
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      const normalized = normalizeExtraParamKey(key);
      if (path.length === 0 && PROTECTED_TOP_LEVEL_KEYS.has(normalized)) {
        const remedy = protectedKeyRemedy(normalized);
        issues.push({
          path: [key],
          message: remedy ? `${key} is protected by AKM — ${remedy}.` : `${key} is protected by AKM`,
        });
      }
      if (CREDENTIAL_KEYS.has(normalized)) {
        issues.push({ path: [...path, key], message: `${key} cannot carry credentials` });
      }
      visit(child, [...path, key]);
    }
  };
  visit(value, []);
  return issues;
}

export function formatExtraParamsIssue(label: string, issue: ExtraParamsIssue): string {
  const suffix = issue.path.map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`)).join("");
  return `${label}${suffix} ${issue.message}`;
}
