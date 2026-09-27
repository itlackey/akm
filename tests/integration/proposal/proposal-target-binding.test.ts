import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmProposalAccept } from "../../../src/commands/proposal/proposal";
import { createProposal, listProposals, resolveProposalId } from "../../../src/commands/proposal/repository";
import { type AkmConfig, resetConfigCache } from "../../../src/core/config/config";
import { openStateDatabase } from "../../../src/core/state-db";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

const VALID_LESSON = `---\ndescription: Proposal with a stable bound destination\nwhen_to_use: Testing proposal destinations\n---\n\nBound content.\n`;
const tempDirs: string[] = [];
let storage: IsolatedAkmStorage;

function stash(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "lessons"), { recursive: true });
  return root;
}

function namedStash(name: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "akm-proposal-named-"));
  tempDirs.push(parent);
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, "lessons"), { recursive: true });
  return root;
}

function config(primary: string, team: string, other?: string): AkmConfig {
  return {
    bundles: {
      primary: { path: primary, writable: true },
      team: { path: team, writable: true },
      ...(other ? { other: { path: other, writable: true } } : {}),
    } as AkmConfig["bundles"],
    defaultBundle: "primary",
    defaultWriteTarget: "primary",
  } as AkmConfig;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("proposal queue target binding", () => {
  function insertHistorical(stashDir: string, id: string, ref: string): void {
    const db = openStateDatabase();
    try {
      db.prepare(
        `INSERT INTO proposals
         (id, stash_dir, ref, status, source, created_at, updated_at, content, frontmatter_json, metadata_json)
         VALUES (?, ?, ?, 'pending', 'reflect', ?, ?, ?, NULL, '{}')`,
      ).run(id, stashDir, ref, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", VALID_LESSON);
    } finally {
      db.close();
    }
  }

  test("historical rows without current changes fail closed before target binding", async () => {
    const primary = stash("akm-proposal-historical-primary-");
    const team = stash("akm-proposal-historical-team-");
    const cfg = config(primary, team);
    insertHistorical(primary, "historical-qualified", "team//lessons/historical-qualified");
    insertHistorical(primary, "historical-short", "lessons/historical-short");

    // metadata_json is entirely empty here, so both `changes` and
    // `proposedTarget` are missing — #859 (reopened) established that
    // neither field alone should abort decode/accept for a legacy row: an
    // already-decided proposal is counted/displayed, never re-applied, and
    // `resolveProposalWriteTarget` already falls back to resolving the write
    // target from the proposal's ref (bundle-qualified ref, or an explicit
    // --target for a short ref) when proposedTarget is absent. What DOES
    // still fail closed is that this row has no captured content to apply
    // (`changes` is also empty) — accept correctly refuses to publish empty
    // content rather than silently promoting nothing.
    await expect(akmProposalAccept({ stashDir: primary, id: "historical-qualified", config: cfg })).rejects.toThrow(
      /has no content/i,
    );
    await expect(
      akmProposalAccept({ stashDir: primary, id: "historical-short", target: "team", config: cfg }),
    ).rejects.toThrow(/has no content/i);
    expect(fs.existsSync(path.join(team, "lessons", "historical-qualified.md"))).toBe(false);
    expect(fs.existsSync(path.join(team, "lessons", "historical-short.md"))).toBe(false);
  });
  test("an unqualified ref in a named secondary queue uses and records the configured source identity", async () => {
    const primary = stash("akm-proposal-primary-");
    const team = stash("akm-proposal-directory-name-is-not-identity-");
    const cfg = config(primary, team);
    const created = createProposal(team, {
      ref: "lessons/bound-secondary",
      source: "propose",
      target: { source: "team", root: team },
      payload: { content: VALID_LESSON },
    });

    expect(created.ref).toBe("team//lessons/bound-secondary");
    expect(created.proposedTarget).toEqual({ source: "team", root: path.resolve(team) });

    const accepted = await akmProposalAccept({ queue: "team", id: created.id, config: cfg });
    expect(accepted.assetPath).toBe(path.join(team, "lessons", "bound-secondary.md"));
    expect(fs.existsSync(path.join(primary, "lessons", "bound-secondary.md"))).toBe(false);
  });

  test("accept persists its terminal gate decision in the acceptance transaction", async () => {
    const primary = stash("akm-proposal-terminal-primary-");
    const team = stash("akm-proposal-terminal-team-");
    const cfg = config(primary, team);
    const created = createProposal(team, {
      ref: "lessons/terminal-accept",
      source: "propose",
      target: { source: "team", root: team },
      payload: { content: VALID_LESSON },
    });

    await akmProposalAccept({
      queue: "team",
      id: created.id,
      config: cfg,
      gateDecision: { outcome: "auto-accepted", reason: "policy-accept", gate: "triage:test" },
    });
    expect(resolveProposalId(team, created.id)).toMatchObject({
      status: "accepted",
      review: { outcome: "accepted" },
      gateDecision: { outcome: "auto-accepted", reason: "policy-accept", gate: "triage:test" },
    });
  });

  test("a secondary-queue proposal records its configured bundle instead of the default", async () => {
    const team = stash("akm-proposal-git-default-secondary-");
    const cfg = {
      bundles: {
        remote: { git: "https://example.com/default.git", writable: true },
        team: { path: team, writable: true },
      } as AkmConfig["bundles"],
      defaultBundle: "remote",
    } as AkmConfig;
    writeSandboxConfig(cfg);
    resetConfigCache();
    const created = createProposal(team, {
      ref: "lessons/git-default-fallback",
      source: "propose",
      payload: { content: VALID_LESSON },
    });
    expect(created.proposedTarget).toEqual({ source: "team", root: path.resolve(team) });

    const accepted = await akmProposalAccept({ queue: "team", id: created.id, config: cfg });
    expect(accepted.assetPath).toBe(path.join(team, "lessons", "git-default-fallback.md"));
    expect(fs.existsSync(accepted.assetPath)).toBe(true);
  });

  test("a qualified proposal cannot use an unconfigured queue bundle", () => {
    const team = stash("akm-proposal-implicit-default-team-");
    const cfg = {
      bundles: { team: { path: team, writable: true } } as AkmConfig["bundles"],
      defaultWriteTarget: "team",
    } as AkmConfig;
    writeSandboxConfig(cfg);

    expect(() =>
      createProposal(storage.stashDir, {
        ref: "stash//lessons/implicit-bound",
        source: "propose",
        payload: { content: VALID_LESSON },
      }),
    ).toThrow(/configured bundle|bundle "stash" is not configured/i);
    expect(fs.existsSync(path.join(team, "lessons", "implicit-bound.md"))).toBe(false);
  });

  test("a conflicting explicit target is rejected before a bound proposal writes", async () => {
    const primary = stash("akm-proposal-conflict-primary-");
    const team = stash("akm-proposal-conflict-team-");
    const other = stash("akm-proposal-conflict-other-");
    const cfg = config(primary, team, other);
    const created = createProposal(team, {
      ref: "lessons/target-conflict",
      source: "propose",
      target: { source: "team", root: team },
      payload: { content: VALID_LESSON },
    });

    await expect(akmProposalAccept({ queue: "team", target: "other", id: created.id, config: cfg })).rejects.toThrow(
      /bound to target|resolves to/,
    );
    expect(fs.existsSync(path.join(team, "lessons", "target-conflict.md"))).toBe(false);
    expect(fs.existsSync(path.join(other, "lessons", "target-conflict.md"))).toBe(false);
  });

  test("a qualified proposal cannot bind its bundle identity to another queue root", () => {
    const primary = stash("akm-proposal-qualified-primary-");
    const team = stash("akm-proposal-qualified-team-");

    expect(() =>
      createProposal(primary, {
        ref: "team//lessons/wrong-root",
        source: "propose",
        target: { source: "primary", root: primary },
        payload: { content: VALID_LESSON },
      }),
    ).toThrow(/conflicts with queue target/i);
    expect(fs.existsSync(path.join(primary, "lessons", "wrong-root.md"))).toBe(false);
    expect(fs.existsSync(path.join(team, "lessons", "wrong-root.md"))).toBe(false);
  });

  test("qualified filters preserve bundle identity while a short ref scopes to all duplicates in the queue", () => {
    const queue = stash("akm-proposal-duplicate-queue-");
    const team = createProposal(queue, {
      ref: "team//lessons/shared",
      source: "propose",
      target: { source: "team", root: queue },
      payload: { content: VALID_LESSON },
    });
    const other = createProposal(queue, {
      ref: "other//lessons/shared",
      source: "propose",
      target: { source: "other", root: queue },
      payload: { content: VALID_LESSON },
    });

    expect(listProposals(queue, { ref: "lessons/shared" }).map((proposal) => proposal.id)).toEqual([team.id, other.id]);
    expect(listProposals(queue, { ref: "team//lessons/shared" }).map((proposal) => proposal.id)).toEqual([team.id]);
    expect(resolveProposalId(queue, "other//lessons/shared").id).toBe(other.id);
  });

  test("a path-derived qualifier is not rewritten to the configured owner", () => {
    const primary = namedStash("physical");
    const team = stash("akm-proposal-alias-team-");
    const cfg = config(primary, team);
    writeSandboxConfig(cfg);
    resetConfigCache();

    expect(() =>
      createProposal(primary, {
        ref: "physical//lessons/configured-owner",
        source: "propose",
        payload: { content: VALID_LESSON },
      }),
    ).toThrow(/bundle "physical" is not configured/i);

    const unqualified = createProposal(primary, {
      ref: "lessons/configured-default",
      source: "propose",
      payload: { content: VALID_LESSON },
    });
    expect(unqualified.ref).toBe("primary//lessons/configured-default");
    expect(unqualified.proposedTarget).toEqual({ source: "primary", root: path.resolve(primary) });
  });

  test("a configured bundle name wins even when it matches another queue's directory name", () => {
    const primary = namedStash("collision");
    const collisionTarget = stash("akm-proposal-collision-target-");
    const cfg = {
      bundles: {
        primary: { path: primary, writable: true },
        collision: { path: collisionTarget, writable: true },
      } as AkmConfig["bundles"],
      defaultBundle: "primary",
      defaultWriteTarget: "primary",
    } as AkmConfig;
    writeSandboxConfig(cfg);
    resetConfigCache();

    const created = createProposal(primary, {
      ref: "collision//lessons/no-redirect",
      source: "propose",
      payload: { content: VALID_LESSON },
    });
    expect(created.ref).toBe("collision//lessons/no-redirect");
    expect(created.proposedTarget).toEqual({ source: "collision", root: path.resolve(collisionTarget) });
  });

  test("accept rejects a target changed after the proposal captured its before hash", async () => {
    const primary = stash("akm-proposal-stale-primary-");
    const team = stash("akm-proposal-stale-team-");
    const cfg = config(primary, team);
    const assetPath = path.join(team, "lessons", "stale-target.md");
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Bound content.", "Original content."), "utf8");
    const created = createProposal(team, {
      ref: "team//lessons/stale-target",
      source: "propose",
      target: { source: "team", root: team },
      payload: { content: VALID_LESSON },
    });
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Bound content.", "Newer user content."), "utf8");

    await expect(akmProposalAccept({ queue: "team", id: created.id, config: cfg })).rejects.toThrow(
      /changed after proposal/i,
    );
    expect(fs.readFileSync(assetPath, "utf8")).toContain("Newer user content.");
  });

  test("accept promotes across a bookkeeping-only target rewrite and carries the bookkeeping forward (STALE, R20)", async () => {
    const primary = stash("akm-proposal-bookkeeping-primary-");
    const team = stash("akm-proposal-bookkeeping-team-");
    const cfg = config(primary, team);
    const assetPath = path.join(team, "lessons", "bookkeeping-target.md");
    const original = VALID_LESSON.replace("Bound content.", "Original content.");
    fs.writeFileSync(assetPath, original, "utf8");
    const created = createProposal(team, {
      ref: "team//lessons/bookkeeping-target",
      source: "propose",
      target: { source: "team", root: team },
      payload: { content: VALID_LESSON },
    });
    expect(created.beforeHashNormalized).toBeDefined();

    // Simulate a same-run improve bookkeeping rewrite of the target (distill's
    // salience scoring, memory inference's `inferenceProcessed` marker) —
    // same authored content, new akm-owned frontmatter keys only.
    const bookkept = original.replace(
      "when_to_use: Testing proposal destinations\n---",
      "when_to_use: Testing proposal destinations\nsalience: 0.82\ninferenceProcessed: true\n---",
    );
    fs.writeFileSync(assetPath, bookkept, "utf8");

    const accepted = await akmProposalAccept({ queue: "team", id: created.id, config: cfg });
    const finalContent = fs.readFileSync(accepted.assetPath, "utf8");
    expect(finalContent).toContain("Bound content.");
    expect(finalContent).toContain("salience: 0.82");
    expect(finalContent).toContain("inferenceProcessed: true");
  });

  test("accept still rejects when the target's real content changed alongside bookkeeping (STALE, R20)", async () => {
    const primary = stash("akm-proposal-real-change-primary-");
    const team = stash("akm-proposal-real-change-team-");
    const cfg = config(primary, team);
    const assetPath = path.join(team, "lessons", "real-change-target.md");
    const original = VALID_LESSON.replace("Bound content.", "Original content.");
    fs.writeFileSync(assetPath, original, "utf8");
    const created = createProposal(team, {
      ref: "team//lessons/real-change-target",
      source: "propose",
      target: { source: "team", root: team },
      payload: { content: VALID_LESSON },
    });

    // A real body edit, not just bookkeeping — the normalized-hash guard must
    // still refuse this.
    const realChange = original.replace("Original content.", "Someone else's content.");
    fs.writeFileSync(assetPath, realChange, "utf8");

    await expect(akmProposalAccept({ queue: "team", id: created.id, config: cfg })).rejects.toThrow(
      /changed after proposal/i,
    );
    expect(fs.readFileSync(assetPath, "utf8")).toContain("Someone else's content.");
  });

  test("a legacy proposal without a normalized before hash keeps the raw check for a bookkeeping-only rewrite", async () => {
    const primary = stash("akm-proposal-legacy-normalized-primary-");
    const team = stash("akm-proposal-legacy-normalized-team-");
    const cfg = config(primary, team);
    const assetPath = path.join(team, "lessons", "legacy-normalized.md");
    const original = VALID_LESSON.replace("Bound content.", "Original content.");
    fs.writeFileSync(assetPath, original, "utf8");
    const created = createProposal(team, {
      ref: "team//lessons/legacy-normalized",
      source: "propose",
      target: { source: "team", root: team },
      payload: { content: VALID_LESSON },
    });
    expect(created.beforeHashNormalized).toBeDefined();

    // Simulate a proposal minted before `beforeHashNormalized` existed: strip
    // it from the persisted row so the promote guard falls back to its exact
    // original raw-hash check.
    const db = openStateDatabase();
    try {
      const row = db.prepare("SELECT metadata_json FROM proposals WHERE id = ?").get(created.id) as {
        metadata_json: string;
      };
      const meta = JSON.parse(row.metadata_json);
      delete meta.beforeHashNormalized;
      db.prepare("UPDATE proposals SET metadata_json = ? WHERE id = ?").run(JSON.stringify(meta), created.id);
    } finally {
      db.close();
    }

    // Bookkeeping-only rewrite of the target — no authored content changed.
    const bookkept = original.replace(
      "when_to_use: Testing proposal destinations\n---",
      "when_to_use: Testing proposal destinations\ninferenceProcessed: true\n---",
    );
    fs.writeFileSync(assetPath, bookkept, "utf8");

    await expect(akmProposalAccept({ queue: "team", id: created.id, config: cfg })).rejects.toThrow(
      /changed after proposal/i,
    );
  });

  test("accept rejects a file created after a bound create proposal", async () => {
    const primary = stash("akm-proposal-created-primary-");
    const team = stash("akm-proposal-created-team-");
    const cfg = config(primary, team);
    const assetPath = path.join(team, "lessons", "created-later.md");
    const created = createProposal(team, {
      ref: "team//lessons/created-later",
      source: "propose",
      target: { source: "team", root: team },
      payload: { content: VALID_LESSON },
    });
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Bound content.", "User-created content."), "utf8");

    await expect(akmProposalAccept({ queue: "team", id: created.id, config: cfg })).rejects.toThrow(
      /created after proposal/i,
    );
    expect(fs.readFileSync(assetPath, "utf8")).toContain("User-created content.");
  });
});
