// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const source = fs.readFileSync(path.resolve(import.meta.dir, "../../.github/workflows/release.yml"), "utf8");
const VERSION_INPUT = "$" + "{{ inputs.version }}";

describe("release workflow", () => {
  test("is one straightforward release job", () => {
    const workflow = YAML.parse(source) as { jobs: Record<string, unknown> };
    expect(Object.keys(workflow.jobs)).toEqual(["release"]);
    expect(source).toContain("bun install --frozen-lockfile");
    expect(source).toContain("bun run build");
    expect(source).toContain("npm publish");
    expect(source).toContain("gh release create");
  });

  test("publishes the exact version already committed in package.json", () => {
    expect(source).toContain(`CANDIDATE_VERSION: ${VERSION_INPUT}`);
    expect(source).toContain("require('./package.json').version");
    expect(source).toContain('"$PACKAGE_VERSION" != "$CANDIDATE_VERSION"');
    expect(source).not.toContain("npm version");
  });

  test("builds all supported standalone binaries", () => {
    for (const artifact of [
      "akm-linux-x64",
      "akm-linux-arm64",
      "akm-darwin-x64",
      "akm-darwin-arm64",
      "akm-windows-x64.exe",
    ]) {
      expect(source).toContain(artifact);
    }
    expect(source).toContain("sha256sum akm-* install.sh install.ps1");
  });

  test("keeps the dispatch value out of shell source", () => {
    const workflow = YAML.parse(source) as {
      jobs: { release: { steps: Array<{ run?: string }> } };
    };
    for (const step of workflow.jobs.release.steps) {
      expect(step.run ?? "").not.toContain(VERSION_INPUT);
    }
  });
});
