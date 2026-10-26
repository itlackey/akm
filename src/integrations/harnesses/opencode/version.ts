// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Which OpenCode major an installed `opencode` binary is.
 *
 * The opencode harness runs the installed binary through its CLI for both majors;
 * the binary's major decides the flags (`./agent-builder.ts`). Plugin upgrades also
 * ask it, to refresh a plugin cache with the major that owns it.
 * {@link detectOpencodeMajor} runs `<bin> --version` once per binary per process.
 */

import childProcess from "node:child_process";
import { warnOnce } from "../../../core/warn";
import { defaultWhich } from "../../agent/detect";

/**
 * The OpenCode CLI binary: the opencode harness runs it and asks it for its major,
 * and plugin upgrades refresh OpenCode's plugin caches with it. akm's own runtime
 * is embedded and needs no binary.
 */
export const OPENCODE_BIN = "opencode";

/** OpenCode 2's own alias for its binary; it can sit next to an OpenCode 1 `opencode` on PATH. */
export const OPENCODE2_BIN = "opencode2";
const VERSION_TIMEOUT_MS = 30_000;

export interface OpencodeVersionInfo {
  /** The major the binary reported, when it reported an OpenCode version. */
  readonly reportedMajor?: number;
  /** Trimmed `--version` output; empty when the binary could not be run. */
  readonly version: string;
  /** Whether `<bin> --version` ran and exited 0. */
  readonly runnable: boolean;
}

/** Runs `<bin> --version`; the trimmed stdout, or undefined when the binary could not be run. */
type OpencodeVersionProbe = (bin: string) => string | undefined;

const defaultProbe: OpencodeVersionProbe = (bin) => {
  const result = childProcess.spawnSync(bin, ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: VERSION_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0) return undefined;
  return (result.stdout ?? "").trim();
};

let probeOverride: OpencodeVersionProbe | undefined;
const detected = new Map<string, OpencodeVersionInfo>();
const onPath = new Map<string, string | undefined>();

/** TEST-ONLY. Swap the `--version` probe (and forget every cached detection and PATH lookup); pass undefined to restore. */
export function _setOpencodeVersionProbeForTests(fake?: OpencodeVersionProbe): void {
  probeOverride = fake;
  detected.clear();
  onPath.clear();
}

/** `which`, memoized for the process. */
function lookup(bin: string): string | undefined {
  if (!onPath.has(bin)) onPath.set(bin, defaultWhich(bin));
  return onPath.get(bin);
}

/**
 * The major in `opencode --version` output (`1.18.34`, `opencode v2.0.26`), or
 * undefined when the output is not an OpenCode version (another program's
 * `--version`, such as `true (GNU coreutils) 9.7`).
 */
export function parseOpencodeMajor(versionOutput: string): number | undefined {
  const match = versionOutput.trim().match(/^(?:opencode\s+)?v?(\d+)\.\d+(?:\.\d+)?(?:[-+.\w]*)$/im);
  return match ? Number(match[1]) : undefined;
}

/**
 * The binary plugin upgrade refreshes OpenCode 2's plugin cache with: the most
 * recent OpenCode on PATH (`opencode2` when present, else `opencode`). The harness
 * itself runs `opencode`, or the `bin` its config names.
 */
export function resolveOpencodeBin(): string {
  return lookup(OPENCODE2_BIN) ? OPENCODE2_BIN : OPENCODE_BIN;
}

/** Detect the OpenCode major of `bin`: one `--version` run per binary per process. */
export function detectOpencodeMajor(bin: string): OpencodeVersionInfo {
  const path = lookup(bin) ?? bin;
  const cached = detected.get(path);
  if (cached) return cached;
  const raw = (probeOverride ?? defaultProbe)(path);
  const version = raw ?? "";
  const reportedMajor = raw === undefined ? undefined : parseOpencodeMajor(raw);
  if (reportedMajor === 1) {
    warnOnce(
      `opencode-version:${path}`,
      `${path} is OpenCode ${version}. OpenCode 1 support continues, but upgrading to OpenCode 2 is recommended.`,
    );
  }
  const info: OpencodeVersionInfo = {
    ...(reportedMajor !== undefined ? { reportedMajor } : {}),
    version,
    runnable: raw !== undefined,
  };
  detected.set(path, info);
  return info;
}

/** Whether `bin` is OpenCode 2 or later: its CLI takes the flags the builder passes. A binary whose version cannot be read counts as OpenCode 1. */
export function isOpencode2(bin: string): boolean {
  return (detectOpencodeMajor(bin).reportedMajor ?? 0) >= 2;
}
