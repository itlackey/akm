// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { EXECUTION_MAX_TIMEOUT_MS } from "../execution/limits";

export const WORKFLOW_MAX_SOURCE_BYTES = 1024 * 1024;
export const WORKFLOW_MAX_INSTRUCTION_BYTES = 256 * 1024;
export const WORKFLOW_MAX_SCHEMA_BYTES = 256 * 1024;
export const WORKFLOW_MAX_EXTRA_PARAMS_BYTES = 64 * 1024;

// ── Bounds the parser enforces, mirrored by schemas/akm-workflow.json ────────
// (pinned by tests/workflows/schema-drift.test.ts)

/** Max per-step map fan-out concurrency (also the run-level concurrency ceiling). */
export const WORKFLOW_MAX_CONCURRENCY = 64;
/** Max timeout in milliseconds (setTimeout's 32-bit signed ceiling: 2^31-1, ~24.8 days). */
export const WORKFLOW_MAX_TIMEOUT_MS = EXECUTION_MAX_TIMEOUT_MS;
/** Engine names: lowercase dash-separated runs of letters/digits, starting with a letter. */
export const WORKFLOW_ENGINE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const WORKFLOW_MAX_ENGINE_NAME_LENGTH = 63;

// ── exec (shell) unit bounds ─────────────────────────────────────────────────

/** Grammar for an env var NAME (`pass_env:`, step `env:` keys, task env). */
export const WORKFLOW_ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Default timeout for an exec unit with no `timeout:` of its own or in
 * `defaults` (a command has no lifetime discipline; `timeout: none` opts out).
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 600_000;

/**
 * Max bytes of one captured pipe an exec unit retains in memory. Past it the
 * reader drains and discards, so the command still runs to its real exit
 * code; the artifact gets a {@link WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER}
 * block, or the unit fails `exec_output_limit` if it declared an `output:` schema.
 */
export const WORKFLOW_MAX_EXEC_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Appended to an exec artifact retained only in part, so it is never mistaken for complete output. */
export const WORKFLOW_EXEC_OUTPUT_TRUNCATED_MARKER = "__akm_exec_output_truncated__";

// ── exec context environment: per-platform spawn ceilings ────────────────────
// Turn an inevitable E2BIG into an error naming the `AKM_*` variable; the
// ceiling is the current platform's, never the smallest one.

/** The spawn ceilings that apply to one platform's `AKM_*` context environment. */
export interface ExecContextLimits {
  /** Max UTF-8 bytes of one `AKM_*` variable. */
  readonly perVarBytes: number;
  /** Max UTF-8 bytes of all `AKM_*` variables combined. */
  readonly totalBytes: number;
  /** Human-readable citation of where the two numbers come from, for the error message. */
  readonly source: string;
}

// Per-var: Win32 `SetEnvironmentVariable` caps one variable at 32 767 UTF-16
// code units; measuring UTF-8 bytes is conservative in the right direction.
// Total: akm's own share of the `CreateProcess` `lpEnvironment` block, which it
// shares with the allowlist, the unit's `env:` bindings and the argv.
const EXEC_CONTEXT_LIMITS_WIN32: ExecContextLimits = {
  perVarBytes: 32_767,
  totalBytes: 64_000,
  source: "Windows caps one environment variable at 32 767 characters (SetEnvironmentVariable)",
};

// Per-var: 75% of Linux's `MAX_ARG_STRLEN` (32 pages = 131 072 bytes), leaving
// margin for the name, `=`, NUL and the kernel's own accounting — the guard must
// never reject a spawn the platform would have accepted.
// Total: half of macOS's 256 KiB `ARG_MAX` (the tightest supported total), so
// the other half remains for the argv, the allowlist and the `env:` bindings.
const EXEC_CONTEXT_LIMITS_POSIX: ExecContextLimits = {
  perVarBytes: 96 * 1024,
  totalBytes: 128 * 1024,
  source:
    "Linux caps one argv/environ string at MAX_ARG_STRLEN (32 pages = 131 072 bytes) and macOS caps argv+environ at ARG_MAX (256 KiB)",
};

/**
 * The `AKM_*` context ceilings for THIS platform (or an explicitly named one,
 * which is how the tests drive both branches deterministically).
 */
export function execContextLimits(platform: string = process.platform): ExecContextLimits {
  return platform === "win32" ? EXEC_CONTEXT_LIMITS_WIN32 : EXEC_CONTEXT_LIMITS_POSIX;
}

/** Max characters of a unit's journaled diagnostic, on both the write and the display side. */
export const WORKFLOW_UNIT_DIAGNOSTIC_CLIP = 2_000;

/** Truncate to `max` chars with an ellipsis marker. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}
