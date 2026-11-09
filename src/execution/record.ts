// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export type StrictRecordSnapshot = Readonly<Record<PropertyKey, unknown>>;

export interface StrictRecordSnapshotOptions {
  /** Private construction markers allowed only on an internal projection path. */
  readonly allowedSymbols?: ReadonlySet<symbol>;
}

/**
 * Snapshot one structured input without invoking user code or silently
 * discarding state. Every own data descriptor is read exactly once.
 */
export function snapshotStrictRecord(
  value: unknown,
  path: string,
  options: StrictRecordSnapshotOptions = {},
): StrictRecordSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must use a plain or null prototype`);
  }

  const out = Object.create(null) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor) throw new TypeError(`${path}.${String(key)} must have a stable own descriptor`);
    if (typeof key === "symbol" && !options.allowedSymbols?.has(key)) {
      throw new TypeError(`${path} contains unsupported symbol field: ${String(key)}`);
    }
    if (!("value" in descriptor)) {
      throw new TypeError(`${path}.${String(key)} must be an enumerable data property, not an accessor`);
    }
    if (typeof key === "string" && !descriptor.enumerable) {
      throw new TypeError(`${path}.${key} must be an enumerable data property, not a non-enumerable field`);
    }
    Object.defineProperty(out, key, {
      value: descriptor.value,
      enumerable: descriptor.enumerable,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(out);
}

export function assertSnapshotKeys(
  value: StrictRecordSnapshot,
  allowed: readonly string[],
  path: string,
  allowedSymbols: ReadonlySet<symbol> = new Set(),
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      if (!allowedSymbols.has(key)) throw new TypeError(`${path} contains unsupported field: ${String(key)}`);
    } else if (!allowedKeys.has(key)) {
      throw new TypeError(`${path} contains unsupported field: ${key}`);
    }
  }
}
