// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Secret asset type — whole-file secret storage.
 *
 * A `secret` holds a single SENSITIVE value used on its own for authentication
 * (a PEM private key, an API token, a TLS cert, a service-account JSON): the
 * ENTIRE file is the secret. There is no safe region to parse, so only the
 * filename is ever surfaced. Where an `env` file holds a GROUP of related
 * configuration and exposes key NAMES as metadata, a secret is ONE value and
 * exposes nothing but its name — reach for `secret` when one value *is* the
 * credential, and for `env` when loading a service's related configuration.
 *
 * Invariant: a secret's bytes must never be written to stdout, returned
 * through the indexer / `akm show` renderer, or any structured output channel.
 * The supported value-use paths are:
 *
 *   - `akm secret run <ref> <VAR> -- <cmd>` — value injected into the child
 *     process env as `VAR=<value>` (see `readValue`).
 *   - `akm secret path <ref>` — print the file path so a command can read it
 *     itself (Docker `/run/secrets` + `_FILE` convention).
 *
 * Values are stored as raw bytes (no quoting, multi-line allowed) so they
 * round-trip byte-exact, unlike env values which forbid literal newlines.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../core/common";
import { probeLock, releaseLock, tryAcquireLockSync } from "../../core/file-lock";

// ── Write-lock helper ─────────────────────────────────────────────────────────

/**
 * Acquire an exclusive lock for the given secret path, run `fn`, then release.
 * Mirrors the env write-lock: O_EXCL creation, 5s deadline, PID-based stale
 * detection. A timeout is always a stale lock or a programming error, so we
 * throw rather than silently proceeding.
 */
export function withSecretLock<T>(secretPath: string, fn: () => T): T {
  const lockPath = `${secretPath}.lock`;
  const deadline = Date.now() + 5000;

  while (!tryAcquireLockSync(lockPath, String(process.pid))) {
    const probe = probeLock(lockPath);
    if (probe.state === "stale") {
      releaseLock(lockPath);
      continue;
    }
    if (Date.now() > deadline) {
      const holderHint =
        probe.state === "held"
          ? ` Lock file ${lockPath} is held by live PID ${probe.holderPid}.`
          : ` Lock file ${lockPath} could not be inspected.`;
      throw new Error(
        `Could not acquire secret lock for ${secretPath} after 5s.${holderHint} Retry once any other akm secret operation finishes, or remove the stale lock file.`,
      );
    }
    if (
      typeof (globalThis as Record<string, unknown> & { Bun?: { sleepSync?: (ms: number) => void } }).Bun?.sleepSync ===
      "function"
    ) {
      (globalThis as Record<string, unknown> & { Bun: { sleepSync: (ms: number) => void } }).Bun.sleepSync(10);
    } else {
      let spin = 0;
      while (spin++ < 100_000) {
        /* yield */
      }
    }
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}

// ── Atomic byte write ──────────────────────────────────────────────────────────

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Walk a `secrets/` directory and return the POSIX-relative names of every
 * secret file. Lock files (`*.lock`), sensitive markers (`*.sensitive`), and
 * secrets with a sibling `<name>.sensitive` marker are excluded. The file
 * bodies are NEVER read.
 */
export function listNames(secretsRoot: string): string[] {
  if (!fs.existsSync(secretsRoot)) return [];
  const names: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".lock") || entry.name.endsWith(".sensitive")) continue;
      // A sibling `<name>.sensitive` marker suppresses listing.
      if (fs.existsSync(`${full}.sensitive`)) continue;
      names.push(path.relative(secretsRoot, full).split(path.sep).join("/"));
    }
  };
  walk(secretsRoot);
  return names.sort();
}

/**
 * Read a secret's raw bytes. Internal use only (for `secret run` / `secret
 * path`). Callers MUST NOT write the returned value to stdout or any log.
 */
export function readValue(secretPath: string): Buffer {
  return fs.readFileSync(secretPath);
}

/**
 * Write (create or overwrite) a secret with the given raw bytes, atomically at
 * mode 0600 under a write-lock. No quoting; multi-line / binary allowed.
 */
export function setSecret(secretPath: string, value: Buffer): void {
  ensureParentDir(secretPath);
  withSecretLock(secretPath, () => {
    // Mode 0600: secrets must never be world-readable, even transiently.
    writeFileAtomic(secretPath, value, 0o600);
  });
}

/**
 * Remove a secret file (and its `.sensitive` marker, if present). Returns true
 * if the secret existed.
 */
export function removeSecret(secretPath: string): boolean {
  return withSecretLock(secretPath, () => {
    if (!fs.existsSync(secretPath)) return false;
    fs.rmSync(secretPath);
    const marker = `${secretPath}.sensitive`;
    if (fs.existsSync(marker)) fs.rmSync(marker);
    return true;
  });
}
