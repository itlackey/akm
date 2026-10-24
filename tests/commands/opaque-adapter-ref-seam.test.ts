// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The ref-parser seam accepts opaque adapter conceptIds.
 *
 * `parseRefInput` must not reject a conceptId just because its leading path
 * segment is not one of AKM's OWN placement stash-subdirs (`resolve-ref.ts`'s
 * `typeNameFromConceptId` reverse table). Adapter-emitted conceptIds — an OKF
 * item under a bundle-owned directory (`tables/customers`), a website page, a
 * wiki pageKind, an adapter `instruction` doc — are valid in every
 * ref-consuming command (tasks, improve, proposals, utility repo, indexer
 * walk). `show` bypasses `parseRefInput` entirely via its indexed-projection
 * path.
 *
 * This file drives each of those command-level surfaces (utility-repo
 * coverage lives in `tests/integration/get-retrieval-counts.test.ts`, next to
 * its existing durable-ref suite) against a real OKF-adapter component whose
 * conceptId (`tables/customers`) has NO AKM placement type at all — proving
 * the round trip end to end, not just that the parser stops throwing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveImproveScope } from "../../src/commands/improve/eligibility";
import { resetConfigCache } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { resolveAssetPath } from "../../src/indexer/walk/path-resolver";
import { type ProposalRow, proposalRowToProposal } from "../../src/storage/repositories/proposals-repository";
import { planTaskToV4File } from "../../src/tasks/source/task-to-v4";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

function write(root: string, rel: string, content: string): void {
  const destination = path.join(root, rel);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, "utf8");
}

describe("opaque adapter conceptIds at the ref-consuming commands", () => {
  let storage: IsolatedAkmStorage;
  let okfRoot: string;
  let conceptPath: string;

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    okfRoot = path.join(storage.root, "okf-adversarial");
    conceptPath = path.join(okfRoot, "tables", "customers.md");
    // `tables` is an OKF bundle directory that is NOT one of AKM's own
    // placement stash-subdirs (skills/, knowledge/, memories/, …) — exactly
    // the "opaque adapter conceptId" shape. The OKF frontmatter
    // `type` ("table") is unrelated to the directory name, underscoring that
    // the conceptId identity comes from the PATH, not the semantic type.
    write(okfRoot, "tables/customers.md", "---\ntype: table\ntitle: Customers\n---\n\nCustomer records.\n");

    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "local",
      engines: { "test-agent": { kind: "agent", platform: "opencode-sdk" } },
      defaults: { engine: "test-agent" },
      bundles: {
        local: {
          path: storage.stashDir,
          writable: true,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
        adversarial: {
          path: okfRoot,
          writable: true,
          components: { main: { root: ".", adapter: "okf", writable: true } },
        },
      },
    });
    resetConfigCache();
  });

  afterEach(() => storage.cleanup());

  test("indexer walk resolves opaque conceptIds from the index without guessing a disk serialization", async () => {
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const indexed = await resolveAssetPath("adversarial//tables/customers", { honorOrigin: true });
    expect(indexed).toBe(conceptPath);

    // Core cannot assume an opaque adapter serializes a concept as `<id>.md`.
    const diskOnly = await resolveAssetPath("adversarial//tables/customers", {
      mode: "disk-only",
      honorOrigin: true,
    });
    expect(diskOnly).toBeNull();
  });

  test("improve: `--scope` recognizes an opaque conceptId as a REF, not a bogus type filter", async () => {
    await akmIndex({ stashDir: storage.stashDir, full: true });
    // Treating the value as a bare type filter
    // (`{ mode: "type", value: "tables/customers" }`) would silently match
    // zero entries.
    expect(resolveImproveScope("tables/customers")).toEqual({ mode: "ref", value: "tables/customers" });
    expect(resolveImproveScope("adversarial//tables/customers")).toEqual({
      mode: "ref",
      value: "adversarial//tables/customers",
    });
  });

  test("proposals repo: a stored opaque conceptId round-trips through the canonical-ref check", () => {
    const row: ProposalRow = {
      id: "prop-opaque-1",
      stash_dir: storage.stashDir,
      ref: "adversarial//tables/customers",
      status: "pending",
      source: "propose",
      created_at: "2026-07-27T00:00:00.000Z",
      updated_at: "2026-07-27T00:00:00.000Z",
      content: "Customer records.",
      frontmatter_json: null,
      metadata_json: JSON.stringify({
        proposedTarget: { source: "adversarial", root: okfRoot },
        changes: [{ path: "tables/customers.md", op: "update" }],
      }),
    };
    // `currentProposalRef` must keep the "tables/" prefix: reconstructing the
    // bare name "customers" would no longer equal the stored ref and would
    // throw "not canonical".
    const proposal = proposalRowToProposal(row);
    expect(proposal.ref).toBe("adversarial//tables/customers");
  });

  test("task migration recognizes the opaque ref and blocks because task-v3 has no generic asset target", () => {
    const filePath = path.join(storage.stashDir, "tasks", "opaque-prompt-source.yml");
    const outcome = planTaskToV4File({
      filePath,
      bytes: Buffer.from('version: 2\nschedule: "@daily"\nprompt: adversarial//tables/customers\n', "utf8"),
      mode: 0o644,
      writable: true,
      containmentRoot: storage.stashDir,
    });
    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "non-command-asset-has-no-v3-command-ref-equivalent",
    });
  });
});
