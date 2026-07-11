// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type ConfigObject = Record<string, unknown>;

export function isPlainObject(value: unknown): value is ConfigObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyConfigValue);
  if (!isPlainObject(value)) return value;
  const copy: ConfigObject = {};
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) throw new TypeError(`Unsafe configuration key: ${key}`);
    copy[key] = copyConfigValue(value[key]);
  }
  return copy;
}

/**
 * Merge configuration values without mutating either input. Plain objects merge
 * recursively; arrays and scalar values replace the less-specific value.
 */
export function deepMergeConfig(base: ConfigObject, override: ConfigObject): ConfigObject {
  const result = copyConfigValue(base) as ConfigObject;
  for (const key of Object.keys(override)) {
    if (UNSAFE_KEYS.has(key)) throw new TypeError(`Unsafe configuration key: ${key}`);
    const next = override[key];
    if (next === undefined) continue;
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(next) ? deepMergeConfig(current, next) : copyConfigValue(next);
  }
  return result;
}
