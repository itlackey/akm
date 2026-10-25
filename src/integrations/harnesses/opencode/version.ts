// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Which OpenCode major an installed `opencode` binary is.
 *
 * The opencode harness runs OpenCode 2 embedded (`./embedded/`) and OpenCode 1
 * through its CLI; the installed binary's major decides which, once per request
 * (`./index.ts`). Plugin upgrades also ask it, to refresh a plugin cache with the
 * major that owns it. {@link detectOpencodeMajor} runs `<bin> --version` once per
 * binary per process.
 */

import childProcess from "node:child_process";
import { warnOnce } from "../../../core/warn";
import { defaultWhich } from "../../agent/detect";
import { OPENCODE_BIN } from "../../agent/profiles";

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

type Which = (command: string) => string | null | undefined;

/** Runs `<bin> --version`; the trimmed stdout, or undefined when the binary could not be run. */
type OpencodeVersionProbe = (bin: string) => string | undefined;

interface DetectOptions {
  /** PATH lookup; defaults to a memoized `defaultWhich` (works on Bun and Node). */
  which?: Which;
  /** Replaces the `--version` run for this call (health injects its own spawn). */
  probe?: OpencodeVersionProbe;
}

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
const detected = new Map<string, OpencodeVersionInfo>();
const onPath = new Map<string, string | undefined>();

/** TEST-ONLY. Swap the `--version` probe (and forget every cached detection and PATH lookup); pass undefined to restore. */
export function _setOpencodeVersionProbeForTests(fake?: OpencodeVersionProbe): void {
  probeOverride = fake;
  detected.clear();
  onPath.clear();
}

/** `which`, memoized for the process when it is the default lookup. */
function lookup(bin: string, which: Which | undefined): string | undefined {
  if (which) return which(bin) ?? undefined;
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
 * The binary an OpenCode engine runs: its own `bin` when it sets one, else the
 * most recent OpenCode on PATH (`opencode2` when present, else `opencode`).
 */
export function resolveOpencodeBin(explicitBin?: string, which?: Which): string {
  if (explicitBin) return explicitBin;
  return lookup(OPENCODE2_BIN, which) ? OPENCODE2_BIN : OPENCODE_BIN;
}

/** Detect the OpenCode major of `bin`: one `--version` run per binary per process. */
export function detectOpencodeMajor(bin: string, options: DetectOptions = {}): OpencodeVersionInfo {
  const path = lookup(bin, options.which) ?? bin;
  const cached = detected.get(path);
  if (cached) return cached;
  const raw = (options.probe ?? probeOverride ?? defaultProbe)(path);
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
