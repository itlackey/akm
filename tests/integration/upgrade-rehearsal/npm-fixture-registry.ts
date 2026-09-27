// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A tiny local npm registry: serves a packument plus tarball for one
 * fixture package, the same shape
 * `tests/integration/registry/registry-network-boundary.test.ts` and
 * `tests/registry-resolve.test.ts` exercise against `AKM_NPM_REGISTRY`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type CommandRunner, packPackage, runCommand } from "../../../scripts/package-install";

export interface FakeNpmRegistry {
  readonly url: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly close: () => void;
}

export async function serveFakeNpmRegistry(
  workDir: string,
  packageName = "akm-upgrade-rehearsal-fixture",
  packageVersion = "1.0.0",
  runner: CommandRunner = runCommand,
): Promise<FakeNpmRegistry> {
  const sourceDir = path.join(workDir, "npm-pkg-source");
  fs.mkdirSync(path.join(sourceDir, "skills", "npm-fixture-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, "package.json"),
    `${JSON.stringify({ name: packageName, version: packageVersion, files: ["skills"] }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(sourceDir, "skills", "npm-fixture-skill", "SKILL.md"),
    "---\ndescription: Upgrade rehearsal npm bundle fixture skill\n---\n\n# npm fixture skill\n",
  );

  const tarball = await packPackage(sourceDir, path.join(workDir, "npm-pkg-packed"), runner);
  const tarballBytes = fs.readFileSync(tarball);
  const shasum = createHash("sha1").update(tarballBytes).digest("hex");
  const tarballName = `${packageName}-${packageVersion}.tgz`;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === `/${packageName}`) {
        const tarballUrl = `${url.origin}/${packageName}/-/${tarballName}`;
        const packument: Record<string, unknown> = {
          name: packageName,
          "dist-tags": { latest: packageVersion },
          versions: {
            [packageVersion]: {
              name: packageName,
              version: packageVersion,
              dist: { tarball: tarballUrl, shasum },
            },
          },
        };
        return new Response(JSON.stringify(packument), { headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname === `/${packageName}/-/${tarballName}`) {
        return new Response(tarballBytes, { headers: { "Content-Type": "application/octet-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    packageName,
    packageVersion,
    close: () => server.stop(true),
  };
}
