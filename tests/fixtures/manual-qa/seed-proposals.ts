// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fs from "node:fs";
import path from "node:path";
import { createProposal, type Proposal, type ProposalSource } from "../../../src/commands/proposal/repository";

const stashArg = process.argv[2];
if (!stashArg) {
  process.stderr.write("Usage: bun seed-proposals.ts <configured-sandbox-bundle>\n");
  process.exit(2);
}
const stashDir = path.resolve(stashArg as string);

const seedDir = path.join(import.meta.dir, "proposal-seeds");
const readSeed = (name: string): string => fs.readFileSync(path.join(seedDir, name), "utf8");
const writeMemory = (name: string, content: string): void => {
  const destination = path.join(stashDir, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
};

const updateBefore = readSeed("update-before.md");
const updateAfter = readSeed("update-after.md");
const emptyBefore = readSeed("empty-before.md");
const deferBefore = readSeed("defer-before.md");

writeMemory("qa-proposal-update", updateBefore);
writeMemory("qa-proposal-empty", emptyBefore);
writeMemory("qa-proposal-defer", deferBefore);

const ids = [
  "11111111-0000-4000-8000-000000000001",
  "22222222-0000-4000-8000-000000000002",
  "33333333-0000-4000-8000-000000000003",
  "33333333-1111-4000-8000-000000000004",
];
let idIndex = 0;
const context = {
  now: () => Date.parse("2026-08-05T00:00:00.000Z"),
  randomUUID: () =>
    ids[idIndex++] ??
    (() => {
      throw new Error("Manual QA proposal id fixture exhausted");
    })(),
};

function seed(ref: string, source: ProposalSource, content: string, frontmatter?: Record<string, unknown>): Proposal {
  return createProposal(
    stashDir,
    {
      ref,
      source,
      sourceRun: "manual-qa-seed",
      payload: { content, ...(frontmatter ? { frontmatter } : {}) },
    },
    context,
  );
}

const proposals = {
  update: seed("memories/qa-proposal-update", "reflect", updateAfter),
  newAsset: seed("memories/qa-proposal-new", "distill", readSeed("new-memory.md")),
  emptyDiff: seed("memories/qa-proposal-empty", "consolidate", emptyBefore, {
    description: "Existing target for an empty-diff proposal",
  }),
  defer: seed("memories/qa-proposal-defer", "consolidate", readSeed("defer-after.md"), {
    description: "Updated target for a deferred proposal",
  }),
};

process.stdout.write(
  `${JSON.stringify(
    Object.fromEntries(
      Object.entries(proposals).map(([label, proposal]) => [label, { id: proposal.id, ref: proposal.ref }]),
    ),
    null,
    2,
  )}\n`,
);
