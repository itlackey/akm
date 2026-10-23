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
 * The supported value-use path is:
 *
 *   - `akm secret run <ref> <VAR> -- <cmd>` — value injected into the child
 *     process env as `VAR=<value>` (see `readValue`).
 *
 * `akm secret path <ref>` (print the file path for the Docker `/run/secrets` +
 * `_FILE` convention) was removed in 0.9.0 alongside `akm secret remove` — an
 * audit found the two resolved a ref through different stash-selection logic
 * and could silently target different files. A ref's file still lives at
 * `<stash>/secrets/<name>`; locate or delete it there directly.
 *
 * Values are stored as raw bytes (no quoting, multi-line allowed), unlike env
 * values which forbid literal newlines; they are read back trimmed (`readValue`).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeRealpath, writeFileAtomic } from "../../core/common";
import {
  createLockPayload,
  type LockOwnership,
  probeLock,
  reclaimStaleLock,
  releaseLock,
  tryAcquireLockSync,
} from "../../core/file-lock";
import { getDataDir } from "../../core/paths";
import { sleepSync } from "../../runtime";

// ── Write-lock helper ─────────────────────────────────────────────────────────

/**
 * Acquire an exclusive lock for the given secret path, run `fn`, then release.
 * Mirrors the env write-lock: O_EXCL creation, 5s deadline, PID-based stale
 * detection. A timeout is always a stale lock or a programming error, so we
 * throw rather than silently proceeding.
 */
export function withSecretLock<T>(secretPath: string, fn: () => T): T {
  const lockPath = secretLockPath(secretPath);
  const lockDir = path.dirname(lockPath);
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5000;
  let ownership: LockOwnership | undefined;

  while (!ownership) {
    ownership = tryAcquireLockSync(lockPath, createLockPayload());
    if (ownership) break;
    const probe = probeLock(lockPath);
    if (probe.state === "stale" && reclaimStaleLock(lockPath, probe)) {
      continue;
    }
    if (Date.now() > deadline) {
      const holderHint = probe.state === "held" ? ` It is held by live PID ${probe.holderPid}.` : "";
      throw new Error(
        `Could not acquire the secret write lock after 5s.${holderHint} Retry once any other akm secret operation finishes.`,
      );
    }
    sleepSync(10);
  }

  try {
    return fn();
  } finally {
    releaseLock(ownership);
  }
}

export function secretLockPath(secretPath: string, platform = process.platform): string {
  const canonical = safeRealpath(secretPath);
  const identity = platform === "win32" ? canonical.toLowerCase() : canonical;
  const key = createHash("sha256").update(identity).digest("hex");
  return path.join(getDataDir(), "secret-locks", `${key}.lock`);
}

// ── Atomic byte write ──────────────────────────────────────────────────────────

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Read a secret's value: the file content as UTF-8 with surrounding whitespace
 * trimmed. The one read every consumer uses (`secret run`, env `${ref}`
 * tokens, config credentials, website fetchers), so a hand-written file's
 * trailing newline never lands in an HTTP header. Callers MUST NOT write the
 * returned value to stdout or any log.
 */
export function readValue(secretPath: string): string {
  return fs.readFileSync(secretPath, "utf8").trim();
}

/**
 * Write (create or overwrite) a secret with the given raw bytes, atomically at
 * mode 0600 under a write-lock. No quoting; multi-line / binary allowed.
 */
export function setSecret(secretPath: string, value: Buffer): void {
  withSecretLock(secretPath, () => {
    ensureParentDir(secretPath);
    // Mode 0600: secrets must never be world-readable, even transiently.
    writeFileAtomic(secretPath, value, 0o600);
  });
}
