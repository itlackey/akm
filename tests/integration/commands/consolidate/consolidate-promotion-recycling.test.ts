// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Consolidate stops offering the same text twice.
 *
 * 1. A memory whose body a reviewer already rejected as a promotion is held
 *    back, whatever the memory is called and whether or not its own ledger row
 *    knows the hash. Only rejections decided on or after 2026-09-29 count: the
 *    bulk audits before that rejected good promotions wholesale.
 * 2. A memory the model judged and left alone is held by its body hash, not a
 *    7-day clock, so an unchanged memory is not judged again every week.
 *
 * The real pool (`inspectConsolidationPool`), mint, proposal API and run
 * (`akmConsolidate` with the model behind a mocked fetch) over a real state.db
 * (ORG-03).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmConsolidate, inspectConsolidationPool } from "../../../../src/commands/improve/consolidate";
import { contentHash } from "../../../../src/commands/improve/content-hash";
import { recordLedgerAttempt } from "../../../../src/commands/improve/ledger";
import { akmProposalReject } from "../../../../src/commands/proposal/proposal";
import { createProposal } from "../../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../../src/core/config/config";
import { openStateDatabase } from "../../../../src/core/state-db";
import { getImproveLedgerRow } from "../../../../src/storage/repositories/improve-ledger-repository";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, withMockedFetch } from "../../../_helpers/sandbox";

const DAY_MS = 86_400_000;
const BEFORE_CUTOFF = Date.parse("2026-08-18T10:00:00Z");

let storage: IsolatedAkmStorage;
let stash: string;
let config: AkmConfig;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  stash = storage.stashDir;
  config = {
    configVersion: "0.9.0",
    semanticSearchMode: "off",
    bundles: { stash: { path: stash, writable: true } },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    engines: {
      planner: { kind: "llm", endpoint: "https://consolidate.example.test/v1/chat/completions", model: "planner" },
    },
    defaults: { llmEngine: "planner", improveStrategy: "default" },
    improve: { strategies: { default: { processes: { consolidate: { enabled: true } } } } },
  } as AkmConfig;
  for (const dir of ["memories", "knowledge"]) fs.mkdirSync(path.join(stash, dir), { recursive: true });
});

afterEach(() => {
  storage.cleanup();
});

const BODY =
  "Always run the release check on a clean checkout before tagging, because a dirty tree hides files the build needs. " +
  "The second sentence keeps this fixture above the promotion size gate.";
const EDITED = `${BODY} A later note adds that the check also needs network access.`;

function writeMemory(name: string, body: string, description = `${name} memory`): void {
  fs.writeFileSync(
    path.join(stash, "memories", `${name}.md`),
    `---\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

/** A user search returned the memory, so the retrieval scope never masks what the hold decides. */
function markRetrieved(name: string): void {
  const db = openStateDatabase();
  try {
    db.prepare("INSERT INTO usage_events (event_type, entry_ref, source, created_at) VALUES (?, ?, ?, ?)").run(
      "search",
      `stash//memories/${name}`,
      "user",
      new Date().toISOString().replace("T", " ").slice(0, 19),
    );
  } finally {
    db.close();
  }
}

/** A rejected promotion of `source`'s text, as an older release minted it (no source hash), under a slug of its own. */
async function rejectedPromotion(source: string, decidedAt: number, opts: { withHash?: boolean; body?: string } = {}) {
  const body = opts.body ?? BODY;
  const proposal = createProposal(stash, {
    ref: `knowledge/${source}-notes`,
    source: "consolidate",
    target: { source: "stash", root: stash },
    payload: { content: `---\ndescription: ${source}\n---\n\n${body}\n`, frontmatter: { description: source } },
    attemptedRefs: [`memories/${source}`],
    promotionSource: `memories/${source}`,
    ...(opts.withHash ? { promotionSourceHash: contentHash(body, "body") } : {}),
  });
  await akmProposalReject({ stashDir: stash, id: proposal.id, config, ctx: { now: () => decidedAt } });
}

const pool = () => inspectConsolidationPool({ config }, stash, []).memories.map((m) => m.name);

describe("a memory whose body was already rejected as a promotion", () => {
  it("is held under any name, with or without a recorded hash, until its body changes", async () => {
    writeMemory("original", BODY);
    // The same text captured again under other names; neither has a ledger row.
    writeMemory("twin", BODY, "a differently described copy");
    writeMemory(
      "unrelated",
      "Rotate the staging credentials every quarter and write the rotation into the shared calendar.",
    );
    for (const name of ["original", "twin", "unrelated"]) markRetrieved(name);

    await rejectedPromotion("original", Date.now() - 2 * DAY_MS); // legacy: no promotionSourceHash
    expect(pool()).toEqual(["unrelated"]);

    writeMemory("twin", EDITED);
    expect(pool().sort()).toEqual(["twin", "unrelated"]);
  });

  it("counts a rejection that recorded the source hash, and holds a copy of the text that has no row of its own", async () => {
    writeMemory("hashed", BODY);
    writeMemory("copy", BODY);
    markRetrieved("hashed");
    markRetrieved("copy");
    await rejectedPromotion("hashed", Date.now() - DAY_MS, { withHash: true });
    expect(pool()).toEqual([]);
  });

  it("ignores a rejection decided before 2026-09-29: the bulk audits do not hold good memories", async () => {
    writeMemory("audited", BODY);
    markRetrieved("audited");
    await rejectedPromotion("audited", BEFORE_CUTOFF);
    // Its own ledger row was decided that long ago too, so its 7-day window has run out.
    expect(pool()).toEqual(["audited"]);
  });

  it("is not held by an accepted or pending proposal of the same body", async () => {
    writeMemory("pending", BODY);
    markRetrieved("pending");
    createProposal(stash, {
      ref: "knowledge/pending-notes",
      source: "consolidate",
      target: { source: "stash", root: stash },
      payload: { content: `---\ndescription: p\n---\n\n${BODY}\n`, frontmatter: { description: "p" } },
      promotionSource: "memories/pending",
    });
    expect(pool()).toContain("pending");
  });
});

describe("a memory the model judged and left alone", () => {
  /** A whole run in which the model has nothing to promote. */
  async function runNoAction(at: number) {
    let modelCalls = 0;
    await withMockedFetch(
      () =>
        akmConsolidate({
          stashDir: stash,
          config,
          sourceRun: "consolidate-recycling-test",
          proposalsCtx: { now: () => at },
        }),
      async (_url, init) => {
        const messages = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages;
        if (!messages.some((m) => m.content.includes("You compare two assets"))) modelCalls++;
        const content = JSON.stringify({ operations: [], onlyInA: [], onlyInB: [], relation: "unrelated" });
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    return modelCalls;
  }

  const ledgerRow = (name: string) => {
    const db = openStateDatabase();
    try {
      return getImproveLedgerRow(db, stash, `memories/${name}`, "consolidate");
    } finally {
      db.close();
    }
  };

  it("stays out of the pool after the 7 days, until the body changes", async () => {
    writeMemory("quiet", BODY);
    markRetrieved("quiet");
    expect(await runNoAction(Date.now() - 9 * DAY_MS)).toBe(1);

    expect(ledgerRow("quiet")).toMatchObject({
      outcome: "judged_no_action",
      nextEligibleAt: null,
      contentHash: contentHash(BODY, "body"),
    });
    expect(pool()).toEqual([]);
    expect(await runNoAction(Date.now())).toBe(0); // no model call for an unchanged memory

    writeMemory("quiet", EDITED);
    expect(pool()).toEqual(["quiet"]);
  });

  it("keeps the 7-day revisit for a row recorded without a hash", () => {
    writeMemory("legacy", BODY);
    markRetrieved("legacy");
    // Untouched for 10 days, so no edit lifts the window.
    const tenDaysAgo = new Date(Date.now() - 10 * DAY_MS);
    fs.utimesSync(path.join(stash, "memories", "legacy.md"), tenDaysAgo, tenDaysAgo);
    recordLedgerAttempt({ proposalsCtx: { now: () => Date.now() - 9 * DAY_MS } }, [
      { stashDir: stash, ref: "memories/legacy", source: "consolidate", outcome: "judged_no_action" },
    ]);
    expect(pool()).toEqual(["legacy"]);
    recordLedgerAttempt({ proposalsCtx: { now: () => Date.now() - 3 * DAY_MS } }, [
      { stashDir: stash, ref: "memories/legacy", source: "consolidate", outcome: "judged_no_action" },
    ]);
    expect(pool()).toEqual([]);
  });
});
