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
  const visit = (entry: unknown, path: (string | number)[]): void => {
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => {
        visit(child, [...path, index]);
      });
      return;
    }
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      const normalized = normalizeExtraParamKey(key);
      if (path.length === 0 && PROTECTED_TOP_LEVEL_KEYS.has(normalized)) {
        issues.push({ path: [key], message: `${key} is protected by AKM` });
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
