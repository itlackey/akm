// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Which OpenCode major a binary is (#1049).
 *
 * akm drives two OpenCode majors through separate adapters. There is no config
 * field for the choice: the binary says which major it is. {@link resolveOpencodeBin}
 * picks the binary (the engine's own `bin`, else the newest OpenCode on PATH) and
 * {@link detectOpencodeMajor} runs `<bin> --version` once per binary per process.
 *
 * - Major 1: OpenCode 1 adapters, plus a one-time warning recommending OpenCode 2.
 * - Major 2: OpenCode 2 adapters.
 * - Anything else, or a `--version` that fails or cannot be parsed: the newest
 *   adapters akm knows (OpenCode 2) and a one-time warning with the raw output.
 *   Detection never aborts; the dispatch reports whatever real error the binary
 *   produces.
 */

import childProcess from "node:child_process";
import { warnOnce } from "../../../core/warn";
import type { OpencodeMajor } from "../opencode-sdk/wire";

/** OpenCode 2's own alias for its binary; it can sit next to an OpenCode 1 `opencode` on PATH. */
export const OPENCODE2_BIN = "opencode2";
const OPENCODE_BIN = "opencode";
const VERSION_TIMEOUT_MS = 30_000;

export interface OpencodeVersionInfo {
  /** The binary that was probed, as resolved on PATH when possible. */
  readonly bin: string;
  /** The adapter major to use: 1, or 2 (also for every binary whose major is not 1). */
  readonly major: OpencodeMajor;
  /** The major the binary reported, when it reported one. */
  readonly reportedMajor?: number;
  /** Trimmed `--version` output; empty when the binary could not be run. */
  readonly version: string;
  /** Whether `<bin> --version` ran and exited 0. */
  readonly runnable: boolean;
}

interface DetectOptions {
  /** PATH lookup; defaults to `Bun.which`. */
  which?: Which;
  /** Replaces the `--version` run for this call (health injects its own spawn). */
  probe?: OpencodeVersionProbe;
}

/** Runs `<bin> --version`; the trimmed stdout, or undefined when the binary could not be run. */
export type OpencodeVersionProbe = (bin: string) => string | undefined;

type Which = (command: string) => string | null | undefined;

const defaultProbe: OpencodeVersionProbe = (bin) => {
  const result = childProcess.spawnSync(bin, ["--version"], {
    encoding: "utf8",
    env: process.env,
    stdio: "pipe",
    timeout: VERSION_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0) return undefined;
  return (result.stdout ?? "").trim();
};

let probeOverride: OpencodeVersionProbe | undefined;
const cache = new Map<string, OpencodeVersionInfo>();

/** TEST-ONLY. Swap the `--version` probe (and forget every cached detection); pass undefined to restore. */
export function _setOpencodeVersionProbeForTests(fake?: OpencodeVersionProbe): void {
  probeOverride = fake;
  cache.clear();
}

/** The major in `opencode --version` output (`1.18.34`, `opencode v2.0.26`), or undefined when there is none. */
export function parseOpencodeMajor(versionOutput: string): number | undefined {
  const match = versionOutput.match(/(\d+)\.\d+/);
  return match ? Number(match[1]) : undefined;
}

/**
 * The binary an OpenCode engine runs: its own `bin` when it sets one, else the
 * most recent OpenCode on PATH (`opencode2` when present, else `opencode`).
 */
export function resolveOpencodeBin(explicitBin?: string, which: Which = Bun.which): string {
  if (explicitBin) return explicitBin;
  return which(OPENCODE2_BIN) ? OPENCODE2_BIN : OPENCODE_BIN;
}

/** Detect the OpenCode major of `bin`: one `--version` run per binary per process. */
export function detectOpencodeMajor(bin: string, options: DetectOptions = {}): OpencodeVersionInfo {
  const path = (options.which ?? Bun.which)(bin) ?? bin;
  const cached = cache.get(path);
  if (cached) return cached;
  const raw = (options.probe ?? probeOverride ?? defaultProbe)(path);
  const version = raw ?? "";
  const reportedMajor = raw === undefined ? undefined : parseOpencodeMajor(raw);
  const major: OpencodeMajor = reportedMajor === 1 ? 1 : 2;
  if (reportedMajor === 1) {
    warnOnce(
      `opencode-version:${path}`,
      `${path} is OpenCode ${version}. OpenCode 1 support continues, but upgrading to OpenCode 2 is recommended.`,
    );
  } else if (reportedMajor !== 2) {
    warnOnce(
      `opencode-version:${path}`,
      raw === undefined
        ? `Could not run \`${path} --version\`, so its OpenCode major is unknown; treating it as OpenCode 2.`
        : `${path} reported an unrecognized OpenCode version (${JSON.stringify(raw)}); treating it as OpenCode 2.`,
    );
  }
  const info: OpencodeVersionInfo = {
    bin: path,
    major,
    ...(reportedMajor !== undefined ? { reportedMajor } : {}),
    version,
    runnable: raw !== undefined,
  };
  cache.set(path, info);
  return info;
}
