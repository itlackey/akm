// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Environment values that identify the runtime rather than carry credentials. */
export const ENV_PASSTHROUGH_REDACTION_ALLOWLIST: ReadonlySet<string> = new Set([
  "HOME",
  "PATH",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "AKM_EVENT_SOURCE",
]);

/**
 * Replace exact sensitive values in text. Longer values are replaced first so
 * an overlapping prefix cannot expose the suffix of a longer credential.
 */
export function redactSensitiveText(text: string, sensitiveValues: Iterable<string>): string {
  const values = [...new Set(sensitiveValues)]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  let redacted = text;
  for (const value of values) redacted = redacted.replaceAll(value, "[REDACTED]");
  return redacted;
}

/** Recursively redact string leaves before a structured value crosses a durable/output boundary. */
export function redactSensitiveValue<T>(value: T, sensitiveValues: Iterable<string>): T {
  const values = [...sensitiveValues];
  const redact = (entry: unknown): unknown => {
    if (typeof entry === "string") return redactSensitiveText(entry, values);
    if (Array.isArray(entry)) return entry.map(redact);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry).map(([key, child]) => [redactSensitiveText(key, values), redact(child)]),
      );
    }
    return entry;
  };
  return redact(value) as T;
}
