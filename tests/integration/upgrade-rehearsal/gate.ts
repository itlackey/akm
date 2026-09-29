// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * AKM_UPGRADE_REHEARSAL=1 gate. Mirrors tests/docker/docker-gate.ts: when the
 * gate is explicitly requested, a missing capability THROWS naming the fix
 * rather than letting the suite skip "inconclusively" (#795).
 */

export interface UpgradeRehearsalCapabilities {
  requested: boolean;
  npmAvailable: boolean;
  /** true when AKM_CANDIDATE_TARBALL names an existing file — bypasses the dist/cli.js requirement. */
  candidateTarballProvided: boolean;
  distCliExists: boolean;
}

export function requireUpgradeRehearsalCapabilities(capabilities: UpgradeRehearsalCapabilities): void {
  if (!capabilities.requested) return;

  if (!capabilities.npmAvailable) {
    throw new Error("AKM_UPGRADE_REHEARSAL=1 requires npm on PATH (used to install both releases as real packages)");
  }

  if (!capabilities.candidateTarballProvided && !capabilities.distCliExists) {
    throw new Error(
      "AKM_UPGRADE_REHEARSAL=1 requires a candidate build: dist/cli.js is missing — run `bun run build`, " +
        "or set AKM_CANDIDATE_TARBALL to a pre-packed tarball (tests/release-check.sh passes $PACKAGE_CANDIDATE).",
    );
  }
}
