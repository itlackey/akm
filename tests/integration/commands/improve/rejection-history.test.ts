// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Native reflect and distill retries read the real sandbox ledger and queue.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmDistill } from "../../../../src/commands/improve/distill";
import { akmReflect } from "../../../../src/commands/improve/reflect";
import { archiveProposal, listProposals } from "../../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../../src/core/config/config";
import { byFile } from "../../../_helpers/asset-at-file";
import { reflectReply } from "../../../_helpers/factories";
import { testLlmRunner } from "../../../_helpers/llm-runner";
import { withIsolatedAkmStorage } from "../../../_helpers/sandbox";

const endpoint = "http://localhost:11434/v1/chat/completions";
const llmRunner = testLlmRunner({ endpoint, model: "test-model" });
const config = {
  semanticSearchMode: "off",
  connections: { default: { endpoint, models: { fast: "test-model" } } },
  improve: {
    strategy: "default",
    strategies: {
      default: {
        processes: { reflect: { qualityGate: { enabled: false } }, distill: { qualityGate: { enabled: false } } },
      },
    },
  },
} satisfies AkmConfig;
const confirmed = "Exports are retained for 30 days; this was verified by the retention job.";
const description = "Nightly export retention is 30 days";
const lesson = `---
description: Keep nightly exports for 30 days before removal
when_to_use: When configuring nightly export retention
---

Keep nightly exports for 30 days before removal.
`;

test("reflect retries see a real guard rejection without blocking a revision backed by new evidence", async () => {
  const storage = withIsolatedAkmStorage();
  try {
    const ref = "knowledge/nightly-export",
      itemRef = `stash//${ref}`;
    const source =
      "---\ndescription: How the nightly export runs\n---\n\n# Nightly export\n\nExport starts at 02:00.\n";
    const reflect = (assetContent: string) =>
      akmReflect({
        ref,
        itemRef,
        assetContent,
        stashDir: storage.stashDir,
        config,
        llmRunner,
        chat: async (_connection, messages) => {
          const prompt = messages.at(-1)?.content;
          if (prompt?.includes(confirmed)) return reflectReply({ description });
          if (prompt?.includes("Rejection reason: placeholder_added")) return reflectReply();
          return reflectReply({ description: "When nightly export runs; retention window to be confirmed" });
        },
      });

    expect(await reflect(source)).toMatchObject({
      ok: false,
      reason: "quality_rejected",
      error: expect.stringContaining("placeholder_added"),
    });
    expect(listProposals(storage.stashDir, { includeArchive: true })).toEqual([]);
    expect(await reflect(source)).toMatchObject({ ok: false, reason: "no_change" });
    expect(await reflect(`${source}\n${confirmed}\n`)).toMatchObject({
      ok: true,
      proposal: { payload: { content: expect.stringContaining(description) } },
    });
  } finally {
    storage.cleanup();
  }
});

test.each([
  "review",
  "quality-gate",
  "stale-target",
] as const)("distill retries use content rejections, not procedural refusals (%s)", async (route) => {
  const storage = withIsolatedAkmStorage();
  try {
    const ref = "memories/nightly-export";
    const itemRef = `stash//${ref}`;
    const file = path.join(storage.stashDir, "memories/nightly-export.md");
    const source =
      "---\ndescription: Note about export retention\n---\n\nThe initial review did not verify the suggested 30-day retention.\n";
    fs.writeFileSync(file, source);
    const rejection = "Retention duration was not verified by the source.";
    const distill = () =>
      akmDistill({
        ref,
        itemRef,
        stashDir: storage.stashDir,
        config,
        ...(route === "quality-gate"
          ? { improveProfile: { processes: { distill: { enabled: true, qualityGate: { enabled: true } } } } }
          : {}),
        llmRunner,
        lookupFn: byFile(async () => file),
        fetchRelatedFn: async () => [],
        chat: async (_connection, messages) => {
          const prompt = messages.at(-1)?.content;
          if (prompt?.includes("Score this lesson")) {
            return JSON.stringify(
              prompt.includes(confirmed)
                ? { score: 5, reason: "Grounded in the new evidence." }
                : { score: 1.5, reason: rejection },
            );
          }
          if (prompt?.includes(`Rejection reason: ${rejection}`) && !prompt.includes(confirmed)) return "NONE";
          return lesson;
        },
      });

    const initial = await distill();
    expect(initial.proposalRef).toBe("lessons/memory-nightly-export-lesson");
    if (route === "quality-gate") {
      expect(initial.outcome).toBe("quality_rejected");
      expect(listProposals(storage.stashDir, { includeArchive: true })).toEqual([]);
    } else {
      expect(initial.outcome).toBe("queued");
      archiveProposal(
        storage.stashDir,
        initial.proposalId!,
        "rejected",
        rejection,
        undefined,
        route === "stale-target" ? { outcome: "auto-rejected", reason: "stale-target", gate: "triage" } : undefined,
      );
    }
    if (route === "stale-target") {
      expect(await distill()).toMatchObject({ outcome: "queued" });
      return;
    }
    expect(await distill()).toMatchObject({ outcome: "skipped" });
    expect(listProposals(storage.stashDir)).toEqual([]);
    fs.appendFileSync(file, `\n${confirmed}\n`);
    expect(await distill()).toMatchObject({ outcome: "queued", proposalRef: "lessons/memory-nightly-export-lesson" });
  } finally {
    storage.cleanup();
  }
});
