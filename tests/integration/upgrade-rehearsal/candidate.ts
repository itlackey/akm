// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Resolves the CANDIDATE release's npm tarball: `AKM_CANDIDATE_TARBALL`
 * (release-check.sh passes `$PACKAGE_CANDIDATE`, already packed from this
 * exact checkout) or a fresh `npm pack` of the repo.
 */

import fs from "node:fs";
import path from "node:path";
import { type CommandRunner, packPackage, runCommand } from "../../../scripts/package-install";

export function candidateTarballFromEnv(): string | undefined {
  const explicit = process.env.AKM_CANDIDATE_TARBALL?.trim();
  if (!explicit) return undefined;
  if (!fs.existsSync(explicit)) throw new Error(`AKM_CANDIDATE_TARBALL does not exist: ${explicit}`);
  return path.resolve(explicit);
}

export async function resolveCandidateTarball(
  repoRoot: string,
  workDir: string,
  runner: CommandRunner = runCommand,
): Promise<string> {
  const explicit = candidateTarballFromEnv();
  if (explicit) return explicit;

  const cliEntry = path.join(repoRoot, "dist", "cli.js");
  if (!fs.existsSync(cliEntry)) {
    throw new Error(`Candidate build is missing: ${cliEntry} does not exist — run \`bun run build\`.`);
  }
  return packPackage(repoRoot, path.join(workDir, "candidate"), runner);
}
