import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { stageJudgedProposal } from "../../src/commands/improve/distill/quality-gate";
import { akmProposalAccept } from "../../src/commands/proposal/proposal";
import { createProposal, getProposal } from "../../src/commands/proposal/repository";
import type { AkmConfig } from "../../src/core/config/config";
import { slugForPath } from "../../src/indexer/installations";
import { runCliCapture } from "../_helpers/cli";
import { durableItemRef } from "../_helpers/durable-ref";
import { makeSandboxDir, type SandboxedDir, withEnv, writeSandboxConfig } from "../_helpers/sandbox";

// Migrated from per-test spawnSync("bun", [cliPath, ...]) to the in-process
// harness (tests/_helpers/cli.ts). Proposals are seeded in-process via
// createProposal() against an isolated stash dir; the CLI then reads that stash
// back through AKM_BUNDLE_DIR. The preload (tests/_preload.ts) sandboxes
// HOME / XDG dirs per test, so runCli only needs to point AKM_BUNDLE_DIR at the
// seeded stash for the duration of the call (via the allowlisted withEnv
// wrapper). The spawn version set cwd: repoRoot, which is already the in-process
// cwd — no chdir needed — so every test migrates cleanly.

const disposers: SandboxedDir[] = [];

function makeTempDir(prefix = "akm-proposal-cli-"): string {
  const d = makeSandboxDir(prefix);
  disposers.push(d);
  return d.dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-proposal-cli-stash-");
  for (const sub of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  const bundleId = slugForPath(stash);
  writeSandboxConfig({
    bundles: { [bundleId]: { path: stash, writable: true } },
    defaultBundle: bundleId,
    defaultWriteTarget: bundleId,
  });
  return stash;
}

afterEach(() => {
  for (const d of disposers.splice(0)) d.cleanup();
});

async function runCli(
  args: string[],
  options: { stashDir: string; env?: Record<string, string | undefined> } = { stashDir: "" },
): Promise<{ stdout: string; stderr: string; status: number }> {
  const { code, stdout, stderr } = await withEnv(
    { AKM_BUNDLE_DIR: options.stashDir || undefined, ...options.env },
    () => runCliCapture(args),
  );
  return { stdout, stderr, status: code };
}

const VALID_LESSON = `---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos\n---\n\nPrefer rg.\n`;

describe("akm proposal drain strategy selector", () => {
  test("accepts --strategy and rejects the retired --profile flag", async () => {
    const stashDir = makeStashDir();
    const selected = await runCli(["proposal", "drain", "--strategy", "default", "--dry-run", "--format=json"], {
      stashDir,
    });
    expect(selected.status).toBe(0);
    expect(JSON.parse(selected.stdout).strategy).toBe("default");

    const retired = await runCli(["proposal", "drain", "--profile", "default", "--dry-run", "--format=json"], {
      stashDir,
    });
    expect(retired.status).toBe(2);
  });

  test("uses defaults.improveStrategy and reports the effective strategy/output buckets", async () => {
    const stashDir = makeStashDir();
    writeSandboxConfig({
      configVersion: "0.9.0",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      defaults: { improveStrategy: "queue-only" },
      improve: {
        strategies: {
          "queue-only": {
            processes: {
              reflect: { enabled: false },
              distill: { enabled: false },
              consolidate: { enabled: false },
              memoryInference: { enabled: false },
              graphExtraction: { enabled: false },
              extract: { enabled: false },
              validation: { enabled: false },
              triage: { enabled: true, applyMode: "queue" },
            },
          },
        },
      },
    });
    const result = await runCli(["proposal", "drain", "--dry-run", "--format=json"], { stashDir });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      strategy: "queue-only",
      applyMode: "queue",
      judgmentEngine: null,
      judgmentKind: null,
      staged: [],
    });
  });

  test("--judgment explicitly overrides a disabled strategy value; config alone never enables standalone drain", async () => {
    const stashDir = makeStashDir();
    writeSandboxConfig({
      configVersion: "0.9.0",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
      defaultWriteTarget: "stash",
      engines: { reviewer: { kind: "agent", platform: "pi" } },
      defaults: { improveStrategy: "explicit-judgment" },
      improve: {
        strategies: {
          "explicit-judgment": {
            processes: { triage: { enabled: true, judgment: { enabled: false, engine: "reviewer" } } },
          },
        },
      },
    });

    const configuredOnly = await runCli(["proposal", "drain", "--dry-run", "--format=json"], { stashDir });
    expect(configuredOnly.status).toBe(0);
    expect(JSON.parse(configuredOnly.stdout)).toMatchObject({ judgmentEngine: null, judgmentKind: null });

    const explicit = await runCli(["proposal", "drain", "--judgment", "--dry-run", "--format=json"], { stashDir });
    expect(explicit.status).toBe(0);
    expect(JSON.parse(explicit.stdout)).toMatchObject({ judgmentEngine: "reviewer", judgmentKind: "agent" });
  });

  test("a stale-target refusal is auto-rejected, not left as a generic failure (STALE, R20)", async () => {
    const stashDir = makeStashDir();
    const assetPath = path.join(stashDir, "lessons", "cli-stale.md");
    fs.writeFileSync(
      assetPath,
      "---\ndescription: Original on-disk content.\nwhen_to_use: Testing.\n---\n\nOriginal.\n",
      "utf8",
    );
    const created = createProposal(stashDir, {
      ref: "lessons/cli-stale",
      source: "extract",
      sourceRun: "run-x",
      target: { source: slugForPath(stashDir), root: stashDir },
      payload: { content: VALID_LESSON, frontmatter: { description: "cli-stale fixture" } },
    });
    // A quality judge passed it, so the drain tries to promote it.
    stageJudgedProposal(stashDir, created);
    fs.writeFileSync(
      assetPath,
      "---\ndescription: Someone else edited this.\nwhen_to_use: Testing.\n---\n\nNewer.\n",
      "utf8",
    );

    const result = await runCli(["proposal", "drain", "--promote", "-y", "--format=json"], { stashDir });
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout);
    // The stale-target category is not a merit rejection, so the drain
    // resolves it with a structured auto-reject instead of retrying forever
    // — it lands in `rejected`, not `failed` (STALE, R20).
    expect(envelope.promoted).toEqual([]);
    expect(envelope.failed).toEqual([]);
    expect(envelope.rejected).toEqual([created.id]);
    expect(getProposal(stashDir, created.id)).toMatchObject({
      status: "rejected",
      gateDecision: { outcome: "auto-rejected", reason: "stale-target" },
    });
  });
});

function seedProposal(stash: string, ref = "lessons/rg-over-grep") {
  const result = createProposal(stash, {
    ref,
    source: "reflect",
    payload: { content: VALID_LESSON },
  });
  return result;
}

describe("akm proposal list (CLI)", () => {
  test("supports --ref filtering", async () => {
    const stash = makeStashDir();
    seedProposal(stash, "lessons/rg-over-grep");
    seedProposal(stash, "lessons/docker-cleanup");
    const result = await runCli(["proposal", "list", "--ref", "lessons/docker-cleanup", "--format=json"], {
      stashDir: stash,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.totalCount).toBe(1);
    expect(parsed.proposals[0].ref).toBe(durableItemRef(stash, "lesson", "docker-cleanup"));
  });

  test("supports --type filtering (asset type derived from ref)", async () => {
    const stash = makeStashDir();
    seedProposal(stash, "lessons/rg-over-grep");
    seedProposal(stash, "knowledge/docker-cleanup");
    const onlyLessons = await runCli(["proposal", "list", "--type", "lesson", "--format=json"], { stashDir: stash });
    expect(onlyLessons.status).toBe(0);
    const parsed = JSON.parse(onlyLessons.stdout);
    expect(parsed.totalCount).toBe(1);
    expect(parsed.proposals[0].ref).toBe(durableItemRef(stash, "lesson", "rg-over-grep"));
    // No-match type yields an empty list, not the full set.
    const none = await runCli(["proposal", "list", "--type", "agent", "--format=json"], { stashDir: stash });
    expect(JSON.parse(none.stdout).totalCount).toBe(0);
  });

  test("error path: invalid --status value → UsageError exit 2 with code", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["proposal", "list", "--status=bogus", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
  });

  test("accepts --status=reverted (parser allows reverted status)", async () => {
    // Regression: parseProposalStatus must accept "reverted" so that
    // `akm proposal list --status reverted` works for archived/reverted proposals.
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["proposal", "list", "--status=reverted", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    // No proposals have been reverted in this fixture, so the list is empty.
    expect(parsed.totalCount).toBe(0);
    expect(Array.isArray(parsed.proposals)).toBe(true);
  });
});

describe("akm proposal accept/reject/diff (CLI)", () => {
  test("reject requires --reason", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["proposal", "reject", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("MISSING_REQUIRED_ARGUMENT");
  });

  test("single-id accept is NOT guarded (revertable) — proceeds without --yes", async () => {
    // WS0: the bulk-accept guard must not leak onto the single-id path.
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["proposal", "accept", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
  });
});

describe("akm proposal accept --generator bulk safety guard (WS0)", () => {
  test("bulk accept without --yes aborts in non-interactive mode (exit 2)", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["proposal", "accept", "--generator", "reflect", "--format=json"], { stashDir: stash });
    // confirmDestructive throws NON_INTERACTIVE_REQUIRES_YES (UsageError → exit 2)
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("NON_INTERACTIVE_REQUIRES_YES");
    // Proposal must NOT have been promoted.
    const list = await runCli(["proposal", "list", "--format=json"], { stashDir: stash });
    expect(JSON.parse(list.stdout).totalCount).toBe(1);
  });

  test("bulk accept with --yes proceeds and promotes matching proposals", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["proposal", "accept", "--generator", "reflect", "--yes", "--format=json"], {
      stashDir: stash,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.accepted).toBe(1);
    expect(parsed.dryRun).toBe(false);
    const list = await runCli(["proposal", "list", "--format=json"], { stashDir: stash });
    expect(JSON.parse(list.stdout).totalCount).toBe(0);
  });

  test("bulk accept --dry-run auto-passes the guard (no --yes needed)", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["proposal", "accept", "--generator", "reflect", "--dry-run", "--format=json"], {
      stashDir: stash,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.dryRun).toBe(true);
    // Nothing promoted — proposal still pending.
    const list = await runCli(["proposal", "list", "--format=json"], { stashDir: stash });
    expect(JSON.parse(list.stdout).totalCount).toBe(1);
  });
});

describe("accept/reject --generator flag (WS3)", () => {
  test("bulk accept --generator proceeds with --yes and promotes matching proposals", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["proposal", "accept", "--generator", "reflect", "--yes", "--format=json"], {
      stashDir: stash,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.accepted).toBe(1);
    // Canonical spelling emits no deprecation warning.
    expect(result.stderr).not.toContain("deprecated");
  });

  test("bulk reject --generator proceeds with --yes", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(
      ["proposal", "reject", "--generator", "reflect", "--reason", "dup", "--yes", "--format=json"],
      { stashDir: stash },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).rejected).toBe(1);
    expect(result.stderr).not.toContain("deprecated");
  });

  test("proposal accept rejects the retired --source flag (renamed to --generator in 0.9)", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["proposal", "accept", "--source", "reflect", "--yes", "--format=json"], {
      stashDir: stash,
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).code).toBe("INVALID_FLAG_VALUE");
  });

  test("proposal reject rejects the retired --source flag (renamed to --generator in 0.9)", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(
      ["proposal", "reject", "--source", "reflect", "--reason", "dup", "--yes", "--format=json"],
      { stashDir: stash },
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).code).toBe("INVALID_FLAG_VALUE");
  });
});

describe("akm proposal noun group (canonical)", () => {
  test("proposal list: lists pending proposal as JSON with totalCount", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["proposal", "list", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.totalCount).toBe(1);
    expect(parsed.proposals[0].id).toBe(created.id);
    // No deprecation warning on the canonical spelling.
    expect(result.stderr).not.toContain("deprecated");
  });

  // Owner ruling 12, canonical bare-group behavior: bare `akm proposal` used to
  // act as `akm proposal list`, and the group mirrored list's filter flags so
  // `akm proposal --status=…` worked too. Both are now a usage error — naming
  // the verb is required, and `akm proposal list` still takes the same flags.
  // Deliberately pinning the NEW behavior, including the dropped group flags:
  // the mirrored args were removed with the default body, so `--status` on the
  // bare form is no longer even declared.
  test("bare `akm proposal` is a usage error, with or without the old group filters", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    for (const argv of [["proposal"], ["proposal", "--status=reverted"]]) {
      const result = await runCli([...argv, "--format=json"], { stashDir: stash });
      expect({ argv, status: result.status }).toEqual({ argv, status: 2 });
      const parsed = JSON.parse(result.stderr.trim());
      expect(parsed.code).toBe("MISSING_REQUIRED_ARGUMENT");
      expect(parsed.error).toContain("`akm proposal` requires a subcommand");
    }
  });

  test("`akm proposal list --status` still filters (the bare form's replacement)", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);

    const all = await runCli(["proposal", "list", "--format=json"], { stashDir: stash });
    expect(all.status).toBe(0);
    const parsed = JSON.parse(all.stdout);
    expect(parsed.totalCount).toBe(1);
    expect(parsed.proposals[0].id).toBe(created.id);

    const filtered = await runCli(["proposal", "list", "--status=reverted", "--format=json"], { stashDir: stash });
    expect(filtered.status).toBe(0);
    expect(JSON.parse(filtered.stdout).totalCount).toBe(0);
  });

  test("proposal show: returns proposal + validation report", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["proposal", "show", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.proposal.id).toBe(created.id);
    expect(parsed.validation.ok).toBe(true);
    expect(result.stderr).not.toContain("deprecated");
  });

  test("proposal show: requires an id (citty rejects the missing positional)", async () => {
    // Like `proposal diff`/`proposal revert`, the required positional is enforced
    // by citty, which renders usage and exits 2, not 1 (R-032, commit 96ff2fe;
    // pinned at tests/integration/cli-errors.test.ts:383-389) — not the JSON
    // envelope path.
    const stash = makeStashDir();
    const result = await runCli(["proposal", "show", "--format=json"], { stashDir: stash });
    // Ground-truthed by probing the actual CLI output before pinning.
    expect(result.status).toBe(2);
    const json = JSON.parse(result.stderr) as { code?: string };
    expect(json.code).toBe("MISSING_REQUIRED_ARGUMENT");
  });

  test("proposal diff: shows a unified diff", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["proposal", "diff", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).unified).toContain("/dev/null");
  });

  test("proposal accept: materialises asset on disk", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["proposal", "accept", created.id, "--format=json"], { stashDir: stash });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(fs.existsSync(parsed.assetPath as string)).toBe(true);
  });

  test("proposal reject: archives proposal with reason", async () => {
    const stash = makeStashDir();
    const created = seedProposal(stash);
    const result = await runCli(["proposal", "reject", created.id, "--reason", "dup", "--yes", "--format=json"], {
      stashDir: stash,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).reason).toBe("dup");
  });

  test("proposal accept --generator bulk guard still applies under the noun group", async () => {
    const stash = makeStashDir();
    seedProposal(stash);
    const result = await runCli(["proposal", "accept", "--generator", "reflect", "--format=json"], { stashDir: stash });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).code).toBe("NON_INTERACTIVE_REQUIRES_YES");
  });
});

describe("akm proposal multi-bundle queues", () => {
  function multiBundleConfig(primary: string, secondary: string): AkmConfig {
    return {
      configVersion: "0.9.0",
      bundles: {
        primary: { path: primary, writable: true },
        secondary: { path: secondary, writable: true },
      },
      defaultBundle: "primary",
      defaultWriteTarget: "primary",
      semanticSearchMode: "off",
    };
  }

  test("lists, shows, diffs, accepts, rejects, and reverts a secondary queue through --queue", async () => {
    const primary = makeStashDir();
    const secondary = makeStashDir();
    const config = multiBundleConfig(primary, secondary);
    writeSandboxConfig(config);

    const original = `---\ndescription: Original secondary lesson\nwhen_to_use: Testing proposal targets\n---\n\nORIGINAL.\n`;
    const assetPath = path.join(secondary, "lessons", "shared.md");
    fs.writeFileSync(assetPath, original, "utf8");
    const primaryProposal = seedProposal(primary, "primary//lessons/primary-only");
    const secondaryProposal = seedProposal(secondary, "secondary//lessons/shared");

    const primaryList = await runCli(["proposal", "list", "--format=json"], { stashDir: primary });
    expect(JSON.parse(primaryList.stdout).proposals.map((proposal: { id: string }) => proposal.id)).toEqual([
      primaryProposal.id,
    ]);

    const secondaryList = await runCli(["proposal", "list", "--queue", "secondary", "--format=json"], {
      stashDir: primary,
    });
    expect(secondaryList.status).toBe(0);
    expect(JSON.parse(secondaryList.stdout).proposals.map((proposal: { id: string }) => proposal.id)).toEqual([
      secondaryProposal.id,
    ]);

    const shown = await runCli(["proposal", "show", secondaryProposal.id, "--queue", "secondary", "--format=json"], {
      stashDir: primary,
    });
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).proposal.ref).toBe("secondary//lessons/shared");

    const diff = await runCli(["proposal", "diff", secondaryProposal.id, "--queue", "secondary", "--format=json"], {
      stashDir: primary,
    });
    expect(diff.status).toBe(0);
    expect(JSON.parse(diff.stdout)).toMatchObject({ isNew: false, targetPath: assetPath });

    const accepted = await runCli(
      ["proposal", "accept", secondaryProposal.id, "--queue", "secondary", "--format=json"],
      { stashDir: primary },
    );
    expect(accepted.status).toBe(0);
    expect(fs.readFileSync(assetPath, "utf8")).toContain("Prefer rg.");
    expect(fs.existsSync(path.join(primary, "lessons", "shared.md"))).toBe(false);

    const reverted = await runCli(
      ["proposal", "revert", secondaryProposal.id, "--queue", "secondary", "--format=json"],
      { stashDir: primary },
    );
    expect(reverted.status).toBe(0);
    expect(fs.readFileSync(assetPath, "utf8")).toBe(original);

    const rejectedProposal = seedProposal(secondary, "secondary//lessons/reject-me");
    const rejected = await runCli(
      [
        "proposal",
        "reject",
        rejectedProposal.id,
        "--queue",
        "secondary",
        "--reason",
        "not needed",
        "--yes",
        "--format=json",
      ],
      { stashDir: primary },
    );
    expect(rejected.status).toBe(0);
    expect(JSON.parse(rejected.stdout).proposal.status).toBe("rejected");
  });

  test("qualified proposal refs preserve bundle identity", async () => {
    const primary = makeStashDir();
    const secondary = makeStashDir();
    writeSandboxConfig(multiBundleConfig(primary, secondary));
    const primaryProposal = seedProposal(primary, "primary//lessons/duplicate");
    const secondaryProposal = seedProposal(primary, "secondary//lessons/duplicate");

    const listed = await runCli(
      ["proposal", "list", "--queue", "primary", "--ref", "secondary//lessons/duplicate", "--format=json"],
      { stashDir: primary },
    );
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout).proposals.map((proposal: { id: string }) => proposal.id)).toEqual([
      secondaryProposal.id,
    ]);

    const shown = await runCli(
      ["proposal", "show", "primary//lessons/duplicate", "--queue", "primary", "--format=json"],
      { stashDir: primary },
    );
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout).proposal.id).toBe(primaryProposal.id);
  });

  test("accept defaults to the recorded destination and rejects a conflicting explicit target", async () => {
    const primary = makeStashDir();
    const secondary = makeStashDir();
    const config = multiBundleConfig(primary, secondary);
    writeSandboxConfig(config);
    const acceptedByBinding = seedProposal(secondary, "secondary//lessons/recorded-target");

    await akmProposalAccept({ stashDir: secondary, id: acceptedByBinding.id, config });
    expect(fs.existsSync(path.join(secondary, "lessons", "recorded-target.md"))).toBe(true);
    expect(fs.existsSync(path.join(primary, "lessons", "recorded-target.md"))).toBe(false);

    const acceptedByQueueRoot = seedProposal(secondary, "lessons/recorded-queue-root");
    const queueRootDiff = await runCli(
      ["proposal", "diff", acceptedByQueueRoot.id, "--queue", "secondary", "--format=json"],
      { stashDir: primary },
    );
    expect(queueRootDiff.status).toBe(0);
    expect(JSON.parse(queueRootDiff.stdout).targetPath).toBe(path.join(secondary, "lessons", "recorded-queue-root.md"));
    await akmProposalAccept({ stashDir: secondary, id: acceptedByQueueRoot.id, config });
    expect(fs.existsSync(path.join(secondary, "lessons", "recorded-queue-root.md"))).toBe(true);
    expect(fs.existsSync(path.join(primary, "lessons", "recorded-queue-root.md"))).toBe(false);

    const conflicting = seedProposal(secondary, "secondary//lessons/conflicting-target");
    await expect(
      akmProposalAccept({ stashDir: secondary, id: conflicting.id, target: "primary", config }),
    ).rejects.toThrow(/bound.*target.*primary/i);
    const cliConflict = await runCli(
      ["proposal", "accept", conflicting.id, "--queue", "secondary", "--target", "primary", "--format=json"],
      { stashDir: primary },
    );
    expect(cliConflict.status).toBe(2);
    expect(JSON.parse(cliConflict.stderr)).toMatchObject({ code: "INVALID_FLAG_VALUE" });
    expect(cliConflict.stderr).toMatch(/bound.*target.*primary/i);
    expect(fs.existsSync(path.join(primary, "lessons", "conflicting-target.md"))).toBe(false);
  });
});

describe("akm proposal new (CLI)", () => {
  test("--task and --file are mutually exclusive", async () => {
    const stash = makeStashDir();
    const promptFile = path.join(makeTempDir("akm-proposal-prompt-"), "prompt.md");
    fs.writeFileSync(promptFile, "author a lesson", "utf8");
    const result = await runCli(
      ["proposal", "new", "lesson", "rg-over-grep", "--task", "inline", "--file", promptFile, "--format=json"],
      { stashDir: stash },
    );
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
  });
});
