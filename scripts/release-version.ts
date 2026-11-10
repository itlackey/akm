// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Release versions, used by .github/workflows/release.yml and scripts/release.sh.
 *
 * Plain semver from 0.11: prereleases are `0.11.0-alpha.N`, `-beta.N` and `-rc.N`, the stable release is `0.11.0`,
 * then patches `0.11.1`, `0.11.2`; the next minor starts at `0.12.0`. The counter N is one above the highest published
 * for that version and stage. package.json holds the release's version (a stage with counter 0, `0.11.0-beta.0`, while
 * the release is in progress; the bare version once it ships).
 *
 *   bun scripts/release-version.ts next [0.<minor>]
 *   VERSION_INPUT=... STAGE_INPUT=... bun scripts/release-version.ts resolve
 *
 * `next` prints the version of the next release of a line (package.json's unless one is given): the next patch of
 * the line's latest stable on npm, or `0.<minor>.0` when the line has none. `resolve` is what the Release workflow
 * runs on package.json's version and the dispatched stage.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import semver from "semver";

export const STAGES = ["alpha", "beta", "rc"] as const;

const RELEASE = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$/;

/** An error message when `version` is not `0.x.y` or `0.x.y-(alpha|beta|rc).N`, else undefined. */
export function validateVersion(version: string): string | undefined {
  return RELEASE.test(version) ? undefined : `"${version}" is not 0.x.y or 0.x.y-(alpha|beta|rc).N`;
}

/**
 * The next release of `line` (for example `0.11`): one patch above its highest stable version in `published`, or
 * `<line>.0` when it has none. Prereleases do not count.
 */
export function nextVersion(line: string, published: readonly string[]): string {
  let patch = -1;
  for (const v of published) {
    const p = semver.parse(v);
    if (p && p.prerelease.length === 0 && `${p.major}.${p.minor}` === line) patch = Math.max(patch, p.patch);
  }
  return `${line}.${patch + 1}`;
}

/**
 * The version to publish: `versionInput` as it is for a stable release (`stageInput` empty; it must have no
 * prerelease part), or its base with `stage` and the next counter for a prerelease. Throws an Error naming what is
 * wrong.
 */
export function resolveVersion(versionInput: string, stageInput: string, published: readonly string[] = []): string {
  const given = versionInput.trim();
  const stage = stageInput.trim();
  let candidate = given;
  if (stage !== "") {
    if (!(STAGES as readonly string[]).includes(stage)) {
      throw new Error(`stage "${stage}" is not one of ${STAGES.join(", ")}`);
    }
    const base = given.replace(/-.*/, "");
    if (published.includes(base)) throw new Error(`${base} is already published; package.json must name a new version`);
    let highest = 0;
    for (const v of published) {
      const p = semver.parse(v);
      if (p && `${p.major}.${p.minor}.${p.patch}` === base && p.prerelease[0] === stage) {
        highest = Math.max(highest, Number(p.prerelease[1]) || 0);
      }
    }
    candidate = `${base}-${stage}.${highest + 1}`;
  } else if (given.includes("-")) {
    throw new Error(`"${given}" is a prerelease; dispatch the Release workflow with a stage, or ship the bare version`);
  }
  const problem = validateVersion(candidate);
  if (problem) throw new Error(problem);
  return candidate;
}

function packageJson(): { name: string; version: string } {
  return JSON.parse(fs.readFileSync("package.json", "utf8")) as { name: string; version: string };
}

/** Versions of `name` on npm; none when it has never been published. */
function npmVersions(name: string): string[] {
  try {
    const out = execFileSync("npm", ["view", name, "versions", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed: unknown = out.trim() === "" ? [] : JSON.parse(out);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (stderr.includes("E404")) return [];
    throw err;
  }
}

function main(argv: string[]): number {
  const [command, arg] = argv;
  try {
    if (command === "resolve") {
      const stage = (process.env.STAGE_INPUT ?? "").trim();
      const published = stage === "" ? [] : npmVersions(packageJson().name);
      console.log(resolveVersion(process.env.VERSION_INPUT ?? "", stage, published));
      return 0;
    }
    if (command === "next") {
      const pkg = packageJson();
      const line = /^0\.\d+(?=\.|$)/.exec(arg ?? pkg.version);
      if (!line) throw new Error(`${arg ?? `package.json ${pkg.version}`} is not a 0.<minor> line`);
      // package.json is what the line last shipped: npm may not have it yet right after its merge.
      console.log(nextVersion(line[0], [...npmVersions(pkg.name), pkg.version]));
      return 0;
    }
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
  console.error("usage: release-version.ts resolve | next [0.<minor>]");
  return 2;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
