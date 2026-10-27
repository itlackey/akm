// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Files out of a package on the npm registry, fetched without installing the
 * package. akm's own agent runtime (an OpenCode binary) and the local
 * embedder's runtime (onnxruntime-node's binding and library) come this way:
 * installing either package would bring what akm does not use, every platform's
 * binary in one case and an install script that downloads CUDA providers in the
 * other.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeResponseToFileCapped } from "../runtime";
import { fetchWithRetry, isRecord } from "./common";
import { extractTarGzMembers } from "./tar";

export const NPM_REGISTRY = "https://registry.npmjs.org";

/** The `sha512-<base64>` integrity npm records for a tarball. */
function sha512Integrity(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(`sha512-${hash.digest("base64")}`));
  });
}

/** Throws unless the tarball at `file` has the integrity the registry lists for it. */
export async function verifyIntegrity(file: string, expected: string): Promise<void> {
  const listed = expected.split(/\s+/).filter((integrity) => integrity.startsWith("sha512-"));
  if (listed.length === 0) throw new Error(`the registry lists no sha512 integrity for it (${expected || "none"})`);
  const actual = await sha512Integrity(file);
  if (!listed.includes(actual))
    throw new Error(`its sha512 integrity is ${actual}, not the ${listed.join(" or ")} the registry lists`);
}

async function registryDocument(url: string): Promise<{ tarball: string; integrity: string }> {
  const response = await fetchWithRetry(url, { headers: { accept: "application/json" } }, { timeout: 30_000 });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`the registry answered HTTP ${response.status}`);
  }
  const dist = ((await response.json()) as { dist?: unknown }).dist;
  if (!isRecord(dist) || typeof dist.tarball !== "string" || typeof dist.integrity !== "string") {
    throw new Error("the registry document has no dist.tarball and dist.integrity");
  }
  return { tarball: dist.tarball, integrity: dist.integrity };
}

/**
 * Keep members of `name@version`'s tarball in `directory`, each as `file`: the registry document of that one version,
 * its tarball, the check against the sha512 integrity the registry lists before anything is extracted, then each
 * member by temp file and rename (mode 0755), in the order given. Two akm processes fetching at once both finish: a
 * rename that loses to the other leaves the file the other made.
 */
export async function fetchNpmPackageFiles(
  name: string,
  version: string,
  directory: string,
  files: ReadonlyArray<{ member: string; file: string }>,
): Promise<void> {
  fs.mkdirSync(directory, { recursive: true });
  const download = path.join(directory, `.download-${process.pid}.tgz`);
  const partial = (file: string): string => path.join(directory, `.${file}-${process.pid}.tmp`);
  try {
    const { tarball, integrity } = await registryDocument(`${NPM_REGISTRY}/${name}/${version}`);
    const response = await fetchWithRetry(tarball, undefined, { timeout: 60_000 });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${tarball} answered HTTP ${response.status}`);
    }
    // No overall deadline for a large tarball on a slow link: only 60 s without bytes fails it.
    await writeResponseToFileCapped(download, response, { stallTimeoutMs: 60_000 });
    await verifyIntegrity(download, integrity);
    const sizes = await extractTarGzMembers(
      download,
      new Map(files.map(({ member, file }) => [member, partial(file)])),
    );
    for (const { member, file } of files) {
      const target = path.join(directory, file);
      fs.chmodSync(partial(file), 0o755);
      try {
        fs.renameSync(partial(file), target);
      } catch (error) {
        // Where a file in use cannot be replaced, the other process's file stands.
        if (!fs.existsSync(target) || fs.statSync(target).size !== sizes.get(member)) throw error;
      }
    }
  } finally {
    fs.rmSync(download, { force: true });
    for (const { file } of files) fs.rmSync(partial(file), { force: true });
  }
}
