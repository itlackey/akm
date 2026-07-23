// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// PROOF for candidate finding: a fully-resolvable legacy task target whose
// origin contains '@' (scoped-npm) or '#' (pinned-github), written as a PLAIN
// (unquoted) YAML scalar exactly the way `yaml.stringify` emits it, is rejected
// by renderScalarLike's conservative regex and blocks the whole migration with
// the misleading "unsupported YAML scalar style" error — even though the
// workflow exists and the origin resolves to a configured bundle.

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { stringify as yamlStringify } from "yaml";
import type { AkmConfig } from "../../src/core/config/config";
import { planTaskTargetRefMigration } from "../../src/migrate/legacy/task-target-ref-migration";
import { makeSandboxDir } from "../_helpers/sandbox";

function configFor(
  bundles: Record<string, { path?: string; registryId?: string; writable?: boolean }>,
  defaultBundle = "stash",
): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles,
    defaultBundle,
  } as AkmConfig;
}

function writeBundle(root: string, workflow: string, tasks: Record<string, string>): void {
  fs.mkdirSync(path.join(root, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(root, "workflows", `${workflow}.md`), `# ${workflow}\n`);
  for (const [name, yaml] of Object.entries(tasks)) fs.writeFileSync(path.join(root, "tasks", `${name}.yml`), yaml);
}

test("scoped-npm (@) origin plain scalar: healthy resolvable target is blocked by the scalar-style regex", () => {
  const sandbox = makeSandboxDir("akm-review-task-target-at");
  try {
    const stash = path.join(sandbox.dir, "stash");
    const pkg = path.join(sandbox.dir, "pkg");

    // Exactly what akm's own serializer (yaml.stringify) emits for this value:
    // a PLAIN, unquoted scalar. (Verified separately; asserted below too.)
    const plainYaml = yamlStringify({
      version: 1,
      schedule: "@daily",
      workflow: "npm:@scope/pkg//workflow:ship",
      enabled: true,
    });
    // Sanity: the emitted line is a plain scalar, not quoted — this is the
    // realistic on-disk 0.8.x form, not a hand-crafted edge case.
    expect(plainYaml).toContain("workflow: npm:@scope/pkg//workflow:ship");

    writeBundle(stash, "unused", { cross: plainYaml });
    // The referenced workflow EXISTS in the resolvable bundle.
    writeBundle(pkg, "ship", {});

    const cfg = configFor({
      stash: { path: stash, writable: true },
      pkg: { path: pkg, registryId: "npm:@scope/pkg" },
    });

    // The target is fully healthy (origin resolves, workflows/ship.md exists),
    // yet planning throws the misleading scalar-style error and blocks apply.
    expect(() => planTaskTargetRefMigration(cfg)).toThrow(/unsupported YAML scalar style/i);

    // Prove the block is PURELY a rendering-regex false rejection, not an
    // unresolvable target: hand-quoting the identical value migrates cleanly.
    fs.writeFileSync(
      path.join(stash, "tasks", "cross.yml"),
      'version: 1\nschedule: "@daily"\nworkflow: "npm:@scope/pkg//workflow:ship"\nenabled: true\n',
    );
    const plan = planTaskTargetRefMigration(cfg);
    expect(plan.rewrites).toHaveLength(1);
    expect(plan.rewrites[0]).toMatchObject({
      from: "npm:@scope/pkg//workflow:ship",
      to: "pkg//workflows/ship",
    });
  } finally {
    sandbox.cleanup();
  }
});

test("pinned-github (#) origin plain scalar is likewise blocked by the scalar-style regex", () => {
  const sandbox = makeSandboxDir("akm-review-task-target-hash");
  try {
    const stash = path.join(sandbox.dir, "stash");
    const team = path.join(sandbox.dir, "team");

    const plainYaml = yamlStringify({
      version: 1,
      schedule: "@daily",
      workflow: "github:owner/repo#v1//workflow:ship",
      enabled: true,
    });
    expect(plainYaml).toContain("workflow: github:owner/repo#v1//workflow:ship");

    writeBundle(stash, "unused", { cross: plainYaml });
    writeBundle(team, "ship", {});

    const cfg = configFor({
      stash: { path: stash, writable: true },
      team: { path: team, registryId: "github:owner/repo#v1" },
    });

    expect(() => planTaskTargetRefMigration(cfg)).toThrow(/unsupported YAML scalar style/i);
  } finally {
    sandbox.cleanup();
  }
});
