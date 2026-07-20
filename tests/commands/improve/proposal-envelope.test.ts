// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-7.4 — the `emitProposal` facade (D10 / R7).
 *
 * The facade is the single seam the five surviving improve emit sites adopt so
 * Chunk 6 can later thread `FileChange[]` / `beforeHash` through ONE call site.
 * At Chunk 7 it wraps the CURRENT `createProposal` shape verbatim — `payload`
 * carries `content` + optional `frontmatter`, status is `pending`, and there is
 * NO `beforeHash` / `FileChange` field. This suite pins arg-for-arg equivalence
 * to a direct `createProposal` call against a real state.db.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { emitProposal } from "../../../src/commands/improve/proposal-envelope";
import {
  type CreateProposalInput,
  createProposal,
  isProposalSkipped,
  listProposals,
  type ProposalsContext,
} from "../../../src/commands/proposal/repository";
import { deriveEntryProvenance, deriveInstallations, slugForPath } from "../../../src/indexer/installations";
import { makeStashDir, type SandboxedDir, sandboxXdgDataHome } from "../../_helpers/sandbox";

const disposers: Array<{ cleanup: () => void }> = [];

/** The durable `proposals.ref` item_ref (WI-8.5a): `<bundle>//<conceptId>`. */
function durableRef(stashDir: string, type: string, name: string): string {
  const bundleId = deriveInstallations([{ path: stashDir, writable: true }])[0]?.id ?? slugForPath(stashDir);
  return deriveEntryProvenance({ bundleId, componentId: bundleId, adapterId: "akm" }, type, name).itemRef;
}

function freshStash(): string {
  const stash: SandboxedDir = makeStashDir();
  for (const sub of ["memories", "lessons", "knowledge"]) {
    fs.mkdirSync(path.join(stash.dir, sub), { recursive: true });
  }
  disposers.push(stash);
  return stash.dir;
}

function baseInput(ref: string): CreateProposalInput {
  return {
    ref,
    source: "reflect",
    sourceRun: "reflect-run-1",
    payload: {
      content: `---\ntitle: ${ref}\n---\nbody for ${ref}`,
      frontmatter: { title: ref },
    },
  };
}

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

describe("emitProposal facade", () => {
  test("emits through createProposal with an equivalent persisted Proposal", () => {
    const dataSb = sandboxXdgDataHome();
    try {
      const stash = freshStash();
      const ctx = { dbPath: path.join(dataSb.dir, "akm", "state.db") };

      const result = emitProposal({ stashDir: stash, proposalsCtx: ctx }, baseInput("knowledge:guide.md"));

      expect(isProposalSkipped(result)).toBe(false);
      if (isProposalSkipped(result)) throw new Error("unexpected skip");
      expect(result.status).toBe("pending");
      expect(result.source).toBe("reflect");
      expect(result.sourceRun).toBe("reflect-run-1");
      expect(result.payload.content).toContain("body for knowledge:guide.md");
      expect(result.payload.frontmatter).toEqual({ title: "knowledge:guide.md" });
      // No Chunk-6 fields exist on the current shape.
      expect("beforeHash" in result).toBe(false);
      expect("fileChanges" in result).toBe(false);

      const persisted = listProposals(stash, {}, ctx);
      expect(persisted.map((p) => p.ref)).toEqual([durableRef(stash, "knowledge", "guide.md")]);
    } finally {
      dataSb.cleanup();
    }
  });

  test("is arg-for-arg equivalent to a direct createProposal call (same skip semantics)", () => {
    // Run the identical create→duplicate→force scenario through the direct API
    // and through the facade on two isolated stashes, then assert the observable
    // outcomes match exactly — the facade adds no behaviour of its own.
    const runScenario = (emit: (stash: string, ctx: ProposalsContext, input: CreateProposalInput) => unknown) => {
      const dataSb = sandboxXdgDataHome();
      try {
        const stash = freshStash();
        const ctx: ProposalsContext = { dbPath: path.join(dataSb.dir, "akm", "state.db") };
        const input = baseInput("knowledge:dup.md");
        const first = emit(stash, ctx, input) as ReturnType<typeof createProposal>;
        const second = emit(stash, ctx, input) as ReturnType<typeof createProposal>; // identical → guard fires
        const forced = emit(stash, ctx, { ...input, force: true }) as ReturnType<typeof createProposal>;
        return {
          firstSkipped: isProposalSkipped(first),
          secondReason: isProposalSkipped(second) ? second.reason : null,
          forcedSkipped: isProposalSkipped(forced),
        };
      } finally {
        dataSb.cleanup();
      }
    };

    const direct = runScenario((stash, ctx, input) => createProposal(stash, input, ctx));
    const facade = runScenario((stash, ctx, input) => emitProposal({ stashDir: stash, proposalsCtx: ctx }, input));

    expect(facade).toEqual(direct);
    // And the scenario actually exercised a guard (not a trivially-equal no-op).
    expect(direct).toEqual({ firstSkipped: false, secondReason: "fingerprint_match", forcedSkipped: false });
  });

  test("forwards an undefined proposalsCtx straight through to createProposal", () => {
    const dataSb = sandboxXdgDataHome();
    try {
      const stash = freshStash();
      // No explicit ctx — the default state.db path resolves under the sandboxed
      // XDG_DATA_HOME, so the write still lands in the isolated tmpdir.
      const result = emitProposal({ stashDir: stash }, baseInput("lesson:x.md"));
      expect(isProposalSkipped(result)).toBe(false);
      const rows = listProposals(stash);
      expect(rows.map((p) => p.ref)).toEqual([durableRef(stash, "lesson", "x.md")]);
    } finally {
      dataSb.cleanup();
    }
  });
});
