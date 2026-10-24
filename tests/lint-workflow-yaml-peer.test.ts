// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../src/commands/lint";
import { detectAdapterId } from "../src/core/adapter/detect-adapter";
import { runCliCapture } from "./_helpers/cli";
import { makeSandboxDir } from "./_helpers/sandbox";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixtureRoot(prefix: string): string {
  const { dir, cleanup } = makeSandboxDir(prefix);
  cleanups.push(cleanup);
  return dir;
}

function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function link(root: string, relative: string, target: string): string {
  const authored = path.join(root, relative);
  fs.mkdirSync(path.dirname(authored), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(authored), target), authored);
  return authored;
}

const VALID_YAML = `name: YAML peer
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: check
        run: bun test
`;

const INVALID_YAML = `name: Unsafe remote action
on:
  workflow_dispatch:
jobs:
  main:
    runs-on: [self-hosted]
    steps:
      - id: checkout
        env:
          RELEASE_TOKEN: AKM_SECRET_BYTES_MUST_NOT_LEAK
        uses: actions/checkout@v4
`;

const VALID_MARKDOWN = `---
type: workflow
description: Markdown peer
updated: 2026-08-22
steps:
  - id: check
    output: { type: string }
---

## check

Run checks.
`;

function diagnosticProjection(result: Awaited<ReturnType<typeof akmLint>>) {
  return result.flagged.map(({ issue, detail, fixed, line }) => ({ issue, detail, fixed, line }));
}

describe("ordinary AKM lint recognizes peer workflow YAML", () => {
  test("a valid workflows/*.yml source is compiled and remains byte-for-byte read-only under --fix", async () => {
    const root = fixtureRoot("akm-lint-yaml-valid-");
    const source = write(root, "workflows/valid.YML", VALID_YAML);
    expect(detectAdapterId(root)).toBe("akm");

    const result = await akmLint({ dir: root, typeFilter: "workflows", fix: true });

    expect(result.flagged).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.fixed).toEqual([]);
    expect(fs.readFileSync(source, "utf8")).toBe(VALID_YAML);
  });

  test("an unsupported remote action in workflows/*.yml is one fatal, located finding with no unrelated bytes", async () => {
    const root = fixtureRoot("akm-lint-yaml-invalid-");
    write(root, "workflows/invalid.yml", INVALID_YAML);

    const result = await akmLint({ dir: root, typeFilter: "workflows" });

    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0]).toMatchObject({
      file: "workflows/invalid.yml",
      issue: "invalid-workflow-structure",
      fixed: false,
      line: 11,
    });
    // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §3.1, row B-05,
    // F-A1.19): the locator grammar is deleted — this now rejects as an
    // unrecognized ref shape ("target ref ... must be a canonical ...
    // asset ref"), not the old "remote action acquisition" wording.
    expect(result.flagged[0]?.detail.toLowerCase()).toContain("target ref");
    expect(JSON.stringify(result)).not.toContain("AKM_SECRET_BYTES_MUST_NOT_LEAK");
    expect(result.summary).toEqual({ fixed: 0, flagged: 1, warnings: 0 });
  });

  test("a peer .md/.yml canonical-owner collision picks the .md deterministically and lints it cleanly", async () => {
    const root = fixtureRoot("akm-lint-yaml-collision-");
    write(root, "workflows/dual.md", VALID_MARKDOWN);
    write(root, "workflows/dual.yml", VALID_YAML);

    const result = await akmLint({ dir: root, typeFilter: "workflows" });

    expect(result.flagged).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("--fail-on-flagged exits nonzero for an invalid peer .yml source", async () => {
    const root = fixtureRoot("akm-lint-yaml-cli-");
    write(root, "workflows/invalid.yml", INVALID_YAML);

    const cli = await runCliCapture([
      "lint",
      "--dir",
      root,
      "--type",
      "workflows",
      "--fail-on-flagged",
      "--format",
      "json",
    ]);

    expect(cli.code).toBe(1);
    expect(cli.stderr).toBe("");
    const result = JSON.parse(cli.stdout) as { summary: { flagged: number }; flagged: Array<{ detail: string }> };
    expect(result.summary.flagged).toBe(1);
    expect(result.flagged).toHaveLength(1);
    expect(cli.stdout).not.toContain("AKM_SECRET_BYTES_MUST_NOT_LEAK");
  });

  test("ordinary AKM and explicit akm-workflow adapters return the same safe YAML diagnostic", async () => {
    const ordinary = fixtureRoot("akm-lint-yaml-ordinary-");
    const standalone = fixtureRoot("akm-lint-yaml-standalone-");
    write(ordinary, "workflows/invalid.yml", INVALID_YAML);
    write(standalone, "invalid.yml", INVALID_YAML);
    expect(detectAdapterId(ordinary)).toBe("akm");
    expect(detectAdapterId(standalone)).toBe("akm-workflow");

    const ordinaryResult = await akmLint({ dir: ordinary, typeFilter: "workflows" });
    const standaloneResult = await akmLint({ dir: standalone });

    expect(diagnosticProjection(ordinaryResult)).toEqual(diagnosticProjection(standaloneResult));
    expect(JSON.stringify(ordinaryResult)).not.toContain("AKM_SECRET_BYTES_MUST_NOT_LEAK");
    expect(JSON.stringify(standaloneResult)).not.toContain("AKM_SECRET_BYTES_MUST_NOT_LEAK");
  });

  test("the unsupported .yaml spelling remains outside the peer-source lint contract", async () => {
    const root = fixtureRoot("akm-lint-yaml-extension-");
    write(root, "workflows/ignored.yaml", INVALID_YAML);

    const result = await akmLint({ dir: root, typeFilter: "workflows" });

    expect(result.flagged).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("user directories named .cache or registry ARE linted (only akm's real registry cache is excluded)", async () => {
    // Pre-0.9.6 this asserted zero findings for these paths — which pinned the
    // exact bug where a bare name/segment match silently disabled lint for any
    // user directory that happened to be called ".cache" or "registry"
    // (fixed alongside #874; exclusion is now isAkmRegistryCachePath, anchored
    // to akm's resolved cache root, not a name).
    const root = fixtureRoot("akm-lint-yaml-cached-peer-");
    write(root, "workflows/release.md", VALID_MARKDOWN);
    write(root, "workflows/.cache/shadow.yml", INVALID_YAML);
    write(root, "workflows/registry/mirror.yml", INVALID_YAML);

    const result = await akmLint({ dir: root, typeFilter: "workflows" });

    // The invalid YAML peers inside those user directories must now surface.
    const flaggedFiles = result.flagged.map((f) => f.file).sort();
    expect(flaggedFiles.some((f) => f.includes(".cache/shadow"))).toBe(true);
    expect(flaggedFiles.some((f) => f.includes("registry/mirror"))).toBe(true);
  });

  test.each([
    ["collision.md.yml", VALID_YAML],
    ["collision.yml.md", VALID_MARKDOWN],
  ])("a repeated workflow suffix in %s lints cleanly under its real extension", async (filename, content) => {
    const root = fixtureRoot("akm-lint-yaml-nested-suffix-");
    write(root, `workflows/${filename}`, content);

    const result = await akmLint({ dir: root, typeFilter: "workflows" });

    expect(result.flagged).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test.skipIf(process.platform === "win32")(
    "a contained same-format workflow symlink is linted under its authored identity without mutation",
    async () => {
      const root = fixtureRoot("akm-lint-yaml-link-valid-");
      const target = write(root, "support/valid.yml", VALID_YAML);
      const authored = link(root, "workflows/linked.yml", target);
      const originalRead = fs.readFileSync;
      let authoredReads = 0;
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
        if (path.resolve(String(candidate)) === path.resolve(authored)) authoredReads++;
        return originalRead(candidate, options as never);
      }) as typeof fs.readFileSync);

      try {
        const result = await akmLint({ dir: root, typeFilter: "workflows", fix: true });

        expect(result.flagged).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.fixed).toEqual([]);
        expect(authoredReads).toBe(1);
        expect(fs.lstatSync(authored).isSymbolicLink()).toBe(true);
        expect(originalRead(target, "utf8")).toBe(VALID_YAML);
      } finally {
        readSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "an invalid contained same-format workflow symlink reports one safe source-IR finding under its authored identity",
    async () => {
      const root = fixtureRoot("akm-lint-yaml-link-invalid-");
      const target = write(root, "support/invalid.yml", INVALID_YAML);
      link(root, "workflows/bad.yml", target);

      const result = await akmLint({ dir: root, typeFilter: "workflows" });

      expect(result.flagged).toHaveLength(1);
      expect(result.flagged[0]).toMatchObject({
        file: "workflows/bad.yml",
        issue: "invalid-workflow-structure",
        fixed: false,
        line: 11,
      });
      expect(result.flagged[0]?.detail).toContain("actions/checkout@v4");
      expect(JSON.stringify(result)).not.toContain("AKM_SECRET_BYTES_MUST_NOT_LEAK");
      expect(fs.lstatSync(path.join(root, "workflows/bad.yml")).isSymbolicLink()).toBe(true);
    },
  );

  test.skipIf(process.platform === "win32")(
    "dangling, escaping, and format-changing workflow symlinks are silently skipped, never read for content",
    async () => {
      const root = fixtureRoot("akm-lint-yaml-link-domain-");
      const outside = fixtureRoot("akm-lint-yaml-link-outside-");
      const outsideTarget = write(outside, "outside.yml", "AKM_OUTSIDE_BYTES_MUST_NOT_LEAK\n");
      const markdownTarget = write(root, "support/format.md", VALID_MARKDOWN);
      const dangling = path.join(root, "workflows/broken.yml");
      fs.mkdirSync(path.dirname(dangling), { recursive: true });
      fs.symlinkSync("missing.yml", dangling);
      const escaping = link(root, "workflows/escape.yml", outsideTarget);
      const formatChanging = link(root, "workflows/format.yml", markdownTarget);
      const denied = new Set([dangling, escaping, formatChanging].map((candidate) => path.resolve(candidate)));
      const originalRead = fs.readFileSync;
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
        if (denied.has(path.resolve(String(candidate)))) {
          throw new Error(`ownership arbitration must not read ${String(candidate)}`);
        }
        return originalRead(candidate, options as never);
      }) as typeof fs.readFileSync);

      try {
        const result = await akmLint({ dir: root, typeFilter: "workflows", fix: true });

        expect(result.flagged).toEqual([]);
        expect(result.fixed).toEqual([]);
        expect(JSON.stringify(result)).not.toContain("AKM_OUTSIDE_BYTES_MUST_NOT_LEAK");
        expect(readSpy).not.toHaveBeenCalledWith(outsideTarget, expect.anything());
      } finally {
        readSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "a contained symlink and canonical peer: the .md peer wins and lints cleanly, the shadowed .yml symlink is never read",
    async () => {
      const root = fixtureRoot("akm-lint-yaml-link-collision-");
      const target = write(root, "support/dual.yml", INVALID_YAML);
      const linked = link(root, "workflows/dual.yml", target);
      write(root, "workflows/dual.md", VALID_MARKDOWN);
      const denied = new Set([linked, target].map((candidate) => path.resolve(candidate)));
      const originalRead = fs.readFileSync;
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
        if (denied.has(path.resolve(String(candidate)))) {
          throw new Error(`shadowed .yml sibling must not be read: ${String(candidate)}`);
        }
        return originalRead(candidate, options as never);
      }) as typeof fs.readFileSync);

      try {
        const result = await akmLint({ dir: root, typeFilter: "workflows", fix: true });

        expect(result.flagged).toEqual([]);
        expect(JSON.stringify(result)).not.toContain("AKM_SECRET_BYTES_MUST_NOT_LEAK");
        expect(result.fixed).toEqual([]);
      } finally {
        readSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "a workflow symlink directory is never traversed or read as an authored source",
    async () => {
      const root = fixtureRoot("akm-lint-yaml-link-directory-");
      const targetDir = path.join(root, "support/linked-directory");
      const sentinel = write(root, "support/linked-directory/hidden.yml", INVALID_YAML);
      const authoredDir = path.join(root, "workflows/linked-directory");
      fs.mkdirSync(path.dirname(authoredDir), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(authoredDir), targetDir), authoredDir, "dir");
      const originalRead = fs.readFileSync;
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((candidate, options) => {
        if (path.resolve(String(candidate)) === path.resolve(sentinel)) {
          throw new Error(`workflow collection must not read ${sentinel}`);
        }
        return originalRead(candidate, options as never);
      }) as typeof fs.readFileSync);
      const originalReadDir = fs.readdirSync;
      const traversed = new Set<string>();
      const readDirSpy = spyOn(fs, "readdirSync").mockImplementation(((candidate, options) => {
        traversed.add(path.resolve(String(candidate)));
        return originalReadDir(candidate, options as never);
      }) as typeof fs.readdirSync);

      try {
        const result = await akmLint({ dir: root, typeFilter: "workflows" });

        expect(result.flagged).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(traversed.has(path.resolve(authoredDir))).toBe(false);
        expect(traversed.has(path.resolve(targetDir))).toBe(false);
      } finally {
        readDirSpy.mockRestore();
        readSpy.mockRestore();
      }
    },
  );

  test("flat workflow ownership arbitration reads its directory a constant number of times", async () => {
    const root = fixtureRoot("akm-lint-yaml-linear-");
    const workflows = path.join(root, "workflows");
    for (let index = 0; index < 50; index++) {
      write(root, `workflows/workflow-${String(index).padStart(2, "0")}.yml`, VALID_YAML);
    }
    const originalReadDir = fs.readdirSync;
    let workflowDirectoryReads = 0;
    const readDirSpy = spyOn(fs, "readdirSync").mockImplementation(((candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(workflows)) workflowDirectoryReads++;
      return originalReadDir(candidate, options as never);
    }) as typeof fs.readdirSync);

    try {
      const result = await akmLint({ dir: root, typeFilter: "workflows" });

      expect(result.flagged).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(workflowDirectoryReads).toBeLessThanOrEqual(2);
    } finally {
      readDirSpy.mockRestore();
    }
  });
});
