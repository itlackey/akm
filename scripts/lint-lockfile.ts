// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * lint-lockfile.ts
 *
 * Checks that `bun.lock` still says what `package.json` asks for. For every
 * direct dependency (`dependencies`, `optionalDependencies`, `devDependencies`):
 *
 *   - the lock has an entry for it;
 *   - the entry resolves to the package of the same name, unless the spec is an
 *     `npm:<other>@<range>` alias, in which case to that package;
 *   - the resolved version satisfies the declared range or pin (specs that are
 *     not semver ranges, such as git URLs and dist-tags, are not judged).
 *
 * And for every other entry, a dependency of a dependency: it resolves to the
 * package of the name it is installed under, unless the package depending on it
 * declares that name as an `npm:<other>@<range>` alias.
 *
 * `bun install --frozen-lockfile` checks none of this when the lock key and the
 * requested version agree. `8055cd1e4` removed the `onnxruntime-node` ->
 * `onnxruntime-web` alias from package.json but not from the lock, where
 * `@huggingface/transformers` then depended on it, so every checkout and CI run
 * ran ONNX on WASM until it was found by hand.
 *
 * Exit codes:
 *   0 — the lock agrees with package.json
 *   1 — a disagreement (printed, one per line) or an unreadable file
 *
 * Usage:
 *   bun scripts/lint-lockfile.ts
 */

import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { parseJsonc } from "../src/core/common";

const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "devDependencies"] as const;

interface PackageJson {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface BunLock {
  packages?: Record<string, [string, ...unknown[]]>;
}

/** Split `name@rest` at the `@` that ends the name (a scoped name starts with one). */
function splitAtVersion(specifier: string): { name: string; rest: string } {
  const at = specifier.indexOf("@", 1);
  return at < 0 ? { name: specifier, rest: "" } : { name: specifier.slice(0, at), rest: specifier.slice(at + 1) };
}

/** The name a lock entry is installed under: the last package name of its key (`parent/child`, scoped names included). */
function installedName(key: string): string {
  const parts = key.split("/");
  return parts.at(-2)?.startsWith("@") ? parts.slice(-2).join("/") : (parts.at(-1) as string);
}

/** The disagreements between a parsed `package.json` and the text of its `bun.lock`. */
export function lintLockfile(pkg: PackageJson, lockText: string): string[] {
  const lock = parseJsonc(lockText) as BunLock;
  const problems: string[] = [];

  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      const resolved = lock.packages?.[name]?.[0];
      if (typeof resolved !== "string") {
        problems.push(`"${name}" (${field}) has no entry in bun.lock; run \`bun install\`.`);
        continue;
      }
      const declared = spec.startsWith("npm:") ? splitAtVersion(spec.slice("npm:".length)) : { name, rest: spec };
      const { name: lockedName, rest: lockedVersion } = splitAtVersion(resolved);

      if (lockedName !== declared.name) {
        problems.push(
          `bun.lock resolves "${name}" to the package "${lockedName}" (${resolved}), but package.json (${field}) declares "${name}": "${spec}". ` +
            `An alias belongs in package.json as "npm:<package>@<range>"; run \`bun update ${name}\`.`,
        );
      } else if (
        semver.valid(lockedVersion) &&
        semver.validRange(declared.rest) &&
        !semver.satisfies(lockedVersion, declared.rest, { includePrerelease: true })
      ) {
        problems.push(
          `bun.lock resolves "${name}" to ${lockedVersion}, which does not satisfy "${declared.rest}" declared in package.json (${field}); run \`bun update ${name}\`.`,
        );
      }
    }
  }

  // The npm: aliases the packages in the lock declare for their own dependencies, as "<name> -> <package>".
  const aliases = new Set<string>();
  for (const entry of Object.values(lock.packages ?? {})) {
    const meta = entry.find((part, i) => i > 0 && typeof part === "object" && part !== null) as
      | Record<string, Record<string, string> | undefined>
      | undefined;
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries(meta?.[field] ?? {})) {
        if (spec.startsWith("npm:")) aliases.add(`${name} -> ${splitAtVersion(spec.slice("npm:".length)).name}`);
      }
    }
  }
  const direct = new Set(DEPENDENCY_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {})));
  for (const [key, [resolved]] of Object.entries(lock.packages ?? {})) {
    const name = installedName(key);
    const lockedName = splitAtVersion(resolved).name;
    if (direct.has(key) || lockedName === name || aliases.has(`${name} -> ${lockedName}`)) continue;
    problems.push(
      `bun.lock installs the package "${lockedName}" (${resolved}) as "${name}" (entry "${key}"), but no package declares "${name}" as "npm:${lockedName}@<range>": a stale alias; run \`bun update ${name}\`.`,
    );
  }
  return problems;
}

if (import.meta.main) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
  const problems = lintLockfile(pkg, fs.readFileSync(path.join(repoRoot, "bun.lock"), "utf8"));
  if (problems.length > 0) {
    console.error(`lint-lockfile: ${problems.length} disagreement(s) between package.json and bun.lock:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("lint-lockfile: OK");
}
