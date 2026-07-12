// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export const WORKFLOW_MAX_PLAN_BYTES = 2 * 1024 * 1024;
export const WORKFLOW_MAX_SOURCE_BYTES = 1024 * 1024;
export const WORKFLOW_MAX_STEPS = 256;
export const WORKFLOW_MAX_ENGINES = 64;
export const WORKFLOW_MAX_PARAMS = 128;
export const WORKFLOW_MAX_ROUTE_BRANCHES = 256;
export const WORKFLOW_MAX_INSTRUCTION_BYTES = 256 * 1024;
export const WORKFLOW_MAX_SCHEMA_BYTES = 256 * 1024;
export const WORKFLOW_MAX_EXTRA_PARAMS_BYTES = 64 * 1024;
export const WORKFLOW_MAX_JSON_DEPTH = 64;
export const WORKFLOW_MAX_MAP_EXPANSION = 10_000;

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}
