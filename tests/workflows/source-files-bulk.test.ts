// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveUniqueWorkflowSource, resolveWorkflowSourceDomains } from "../../src/workflows/source-files";
import { makeSandboxDir } from "../_helpers/sandbox";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixtureRoot(prefix: string): string {
  const { dir, cleanup } = makeSandboxDir(prefix);
  cleanups.push(cleanup);
  return dir;
}

function workflow(root: string, name: string): string {
  const file = path.join(root, "workflows", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\ntype: workflow\nsteps:\n  - id: a\n---\n\n## a\n\nDo it.\n", "utf8");
  return file;
}

function lexicalDotPath(file: string): string {
  return `${path.dirname(file)}${path.sep}.${path.sep}${path.basename(file)}`;
}

function projection(root: string, inputs: readonly string[]) {
  return resolveWorkflowSourceDomains(root, "akm", inputs).map((domain) => ({
    canonicalName: domain.canonicalName,
    sourcePaths: domain.sourcePaths,
    source: domain.source?.relativePath,
    rejection: domain.rejection?.message,
  }));
}

describe("bulk workflow source ownership deduplicates authored paths", () => {
  test("an exact duplicate absolute path remains one owner with point-lookup parity", () => {
    const root = fixtureRoot("akm-workflow-source-bulk-exact-");
    const file = workflow(root, "exact.md");
    const point = resolveUniqueWorkflowSource(root, "akm", "exact");

    const domains = resolveWorkflowSourceDomains(root, "akm", [file, file]);

    expect(domains).toHaveLength(1);
    expect(domains[0]).toEqual({
      canonicalName: "exact",
      sourcePaths: ["workflows/exact.md"],
      source: point,
    });
  });

  test("lexically equivalent normalized paths collapse before domain arbitration", () => {
    const root = fixtureRoot("akm-workflow-source-bulk-lexical-");
    const file = workflow(root, "lexical.md");
    const lexical = lexicalDotPath(file);

    const domains = resolveWorkflowSourceDomains(root, "akm", [lexical, file, lexical]);

    expect(domains).toHaveLength(1);
    expect(domains[0]?.sourcePaths).toEqual(["workflows/lexical.md"]);
    expect(domains[0]?.source).toEqual(resolveUniqueWorkflowSource(root, "akm", "lexical.md"));
    expect(domains[0]?.rejection).toBeUndefined();
  });

  test("deduplication is deterministic across input order and preserves each point owner", () => {
    const root = fixtureRoot("akm-workflow-source-bulk-order-");
    const alpha = workflow(root, "alpha.md");
    const beta = workflow(root, "beta.md");
    const inputs = [beta, lexicalDotPath(alpha), beta, alpha, lexicalDotPath(beta)];

    const forward = projection(root, inputs);
    const reverse = projection(root, [...inputs].reverse());

    expect(forward).toEqual(reverse);
    expect(forward).toEqual([
      {
        canonicalName: "alpha",
        sourcePaths: ["workflows/alpha.md"],
        source: "workflows/alpha.md",
        rejection: undefined,
      },
      {
        canonicalName: "beta",
        sourcePaths: ["workflows/beta.md"],
        source: "workflows/beta.md",
        rejection: undefined,
      },
    ]);
    expect(resolveUniqueWorkflowSource(root, "akm", "alpha")).toMatchObject({ relativePath: forward[0]?.source });
    expect(resolveUniqueWorkflowSource(root, "akm", "beta")).toMatchObject({ relativePath: forward[1]?.source });
  });

  test("a duplicated nested-suffix path resolves as one valid domain with point-lookup parity", () => {
    const root = fixtureRoot("akm-workflow-source-bulk-invalid-");
    const file = workflow(root, "hostile.md.md");
    const point = resolveUniqueWorkflowSource(root, "akm", "hostile.md.md");

    const domains = resolveWorkflowSourceDomains(root, "akm", [file, lexicalDotPath(file), file]);

    expect(point).toBeDefined();
    expect(domains).toHaveLength(1);
    expect(domains[0]?.sourcePaths).toEqual(["workflows/hostile.md.md"]);
    expect(domains[0]?.source).toEqual(point);
    expect(domains[0]?.rejection).toBeUndefined();
  });
});
