// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProposals } from "../../../src/commands/proposal/repository";
import { type CliResult, runCliCapture } from "../../_helpers/cli";
import { clearHarnessCalls, fakeHarness, harnessCalls, promptOf } from "../../_helpers/engine-stubs";
import {
  type IsolatedAkmStorage,
  makeSandboxDir,
  type SandboxedDir,
  STASH_SKELETON_SUBDIRS,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

describe("proposal-new-harness", () => {
  /**
   * `akm proposal new` gets the proposal as JSON on stdout from a harness. The
   * contract suite runs every transport; one agent row stands for them here.
   * Integration: it spawns fake CLI harness binaries. Nothing leaves the machine.
   *
   * Every stub replays a scripted reply, so a row sees what reached the harness
   * and what `proposal new` did with the reply.
   */

  const NAME = "engine-proof";
  const CONTENT =
    "---\ndescription: Proves proposal new on every engine kind\nwhen_to_use: Checking an engine\n---\n\nReturn the proposal as JSON.\n";
  const PROPOSAL = JSON.stringify({ ref: `skills/${NAME}`, content: CONTENT, confidence: 0.8 });
  /** Valid JSON with no `content`: not a proposal. */
  const NOT_A_PROPOSAL = JSON.stringify({ ref: `skills/${NAME}` });
  const SCHEMA_INSTRUCTION = "Respond with ONLY a JSON value matching this JSON Schema";

  const SCENARIOS: Record<string, readonly string[]> = {
    proposal: [PROPOSAL],
    repair: [NOT_A_PROPOSAL, PROPOSAL],
    invalid: [NOT_A_PROPOSAL],
  };

  let bins: SandboxedDir;
  let storage: IsolatedAkmStorage;

  beforeAll(() => {
    bins = makeSandboxDir("akm-proposal-new-bin");
    fs.writeFileSync(path.join(bins.dir, "plain-proposal"), fakeHarness(SCENARIOS.proposal ?? []), { mode: 0o755 });
    fs.writeFileSync(path.join(bins.dir, "plain-repair"), fakeHarness(SCENARIOS.repair ?? []), { mode: 0o755 });
    fs.writeFileSync(path.join(bins.dir, "plain-invalid"), fakeHarness(SCENARIOS.invalid ?? []), { mode: 0o755 });
  });

  afterAll(() => {
    bins.cleanup();
  });

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    const harness = (platform: string, bin: string) => ({ platform, bin: path.join(bins.dir, bin) });
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: { work: { path: storage.stashDir, writable: true } },
      defaultBundle: "work",
      harnesses: {
        claude: harness("claude", "plain-proposal"),
        "claude-invalid": harness("claude", "plain-invalid"),
        "claude-repair": harness("claude", "plain-repair"),
      },
    });
  });

  afterEach(() => {
    storage.cleanup();
    clearHarnessCalls(bins.dir);
  });

  function proposalNew(engine: string): Promise<CliResult> {
    return runCliCapture([
      "proposal",
      "new",
      "skill",
      NAME,
      "--task",
      "Author a skill that proves this engine returns JSON",
      "--harness",
      engine,
      "--format",
      "json",
    ]);
  }

  /** The calls the fake harness `bin` recorded. */
  const calls = (bin: string) => harnessCalls(path.join(bins.dir, bin));

  /** `proposal new` succeeded on `engine` and queued the reply's proposal. */
  function expectProposalCreated(result: CliResult, engine: string): void {
    if (result.code !== 0) throw new Error(`proposal new --harness ${engine} exited ${result.code}: ${result.stdout}`);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, engine, ref: `work//skills/${NAME}` });
    const proposals = listProposals(storage.stashDir);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ source: "propose", ref: `work//skills/${NAME}`, status: "pending" });
    expect(proposals[0]?.confidence).toBe(0.8);
    // The queue stamps `type` and `updated` into the reply's frontmatter.
    expect(proposals[0]?.payload.content).toContain("description: Proves proposal new on every engine kind");
    expect(proposals[0]?.payload.content).toContain("Return the proposal as JSON.");
  }

  describe("proposal new returns JSON from a harness", () => {
    test("a claude harness gets the prompt, with the schema instruction, on stdin and answers in plain text", async () => {
      const result = await proposalNew("claude");

      expectProposalCreated(result, "claude");
      const [call] = calls("plain-proposal");
      expect(call?.argv).toContain("-p");
      expect(call?.argv).not.toContain("--output-format");
      expect(promptOf(call)).toContain(SCHEMA_INSTRUCTION);
    });
  });

  describe("a reply that is not a proposal gets one corrective retry", () => {
    test("a harness corrected by the retry creates the proposal", async () => {
      const result = await proposalNew("claude-repair");

      expectProposalCreated(result, "claude-repair");
      expect(calls("plain-repair")).toHaveLength(2);
      expect(promptOf(calls("plain-repair")[1])).toContain("failed validation");
    });

    test.each([
      ["claude-invalid", () => calls("plain-invalid").length],
    ])("%s: a reply still invalid after the retry fails clearly and creates nothing", async (engine, count) => {
      const result = await proposalNew(engine);

      expect(result.code).toBe(1);
      const out = JSON.parse(result.stdout) as { ok: boolean; reason: string; error: string; engine: string };
      expect(out).toMatchObject({ ok: false, reason: "parse_error", engine });
      expect(out.error).toContain(`Engine "${engine}"`);
      expect(out.error).toContain("not valid proposal JSON");
      expect(out.error).toContain('"content"');
      expect(out.error).not.toContain("interactive");
      expect(count()).toBe(2);
      expect(listProposals(storage.stashDir)).toEqual([]);
    });
  });
});

describe("proposal-new-bundle", () => {
  /**
   * `akm proposal new --bundle <name>` queues the proposal for another configured
   * bundle. Drives the real CLI against a fake harness binary (the way
   * the harness case above does), with two configured bundles: the working
   * bundle `work` and a second one, `other`.
   */

  const NAME = "bundle-proof";
  const CONTENT =
    "---\ndescription: Proves proposal new --bundle\nwhen_to_use: Checking the bundle flag\n---\n\nQueued for another bundle.\n";
  const PROPOSAL = JSON.stringify({ ref: `skills/${NAME}`, content: CONTENT, confidence: 0.8 });

  const extraDirs: string[] = [];
  let bin: string;
  /** The prompts the fake harness received, in order. */
  const promptsSent = () => harnessCalls(bin).map((call) => promptOf(call));
  let storage: IsolatedAkmStorage;
  let otherDir: string;
  let readonlyDir: string;

  function makeBundleDir(prefix: string, convention?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    extraDirs.push(dir);
    for (const sub of STASH_SKELETON_SUBDIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    if (convention) {
      fs.mkdirSync(path.join(dir, "facts", "conventions"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "facts", "conventions", "house-style.md"),
        `---\ncategory: convention\ndescription: House style\n---\n\n${convention}\n`,
      );
    }
    return dir;
  }

  beforeAll(() => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-proposal-new-bin-"));
    extraDirs.push(binDir);
    bin = path.join(binDir, "agent");
    fs.writeFileSync(bin, fakeHarness([PROPOSAL]), { mode: 0o755 });
  });

  afterAll(() => {
    for (const dir of extraDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    fs.mkdirSync(path.join(storage.stashDir, "facts", "conventions"), { recursive: true });
    fs.writeFileSync(
      path.join(storage.stashDir, "facts", "conventions", "house-style.md"),
      "---\ncategory: convention\ndescription: House style\n---\n\nWORK-BUNDLE-CONVENTION\n",
    );
    otherDir = makeBundleDir("akm-proposal-new-other-", "OTHER-BUNDLE-CONVENTION");
    readonlyDir = makeBundleDir("akm-proposal-new-ro-");
    writeSandboxConfig({
      semanticSearchMode: "off",
      bundles: {
        work: { path: storage.stashDir, writable: true },
        other: { path: otherDir, writable: true },
        frozen: { path: readonlyDir, writable: false },
      },
      defaultBundle: "work",
      harnesses: { agent: { platform: "claude", bin } },
    });
  });

  afterEach(() => {
    storage.cleanup();
    // The fake harness records each call beside itself (`agent.count`, `agent.call.<n>`).
    for (const file of fs.readdirSync(path.dirname(bin))) {
      if (file.startsWith("agent.")) fs.rmSync(path.join(path.dirname(bin), file), { force: true });
    }
  });

  function proposalNew(...extra: string[]): Promise<CliResult> {
    return runCliCapture(["proposal", "new", "skill", NAME, "--task", "Author a skill", ...extra, "--format", "json"]);
  }

  function promptSent(): string {
    return promptsSent()[0] ?? "";
  }

  describe("akm proposal new --bundle", () => {
    test("queues the proposal for the named bundle, records it as the target, and accept writes into it", async () => {
      const result = await proposalNew("--bundle", "other");

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, ref: `other//skills/${NAME}` });
      expect(listProposals(storage.stashDir)).toHaveLength(0);
      const queued = listProposals(otherDir);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        ref: `other//skills/${NAME}`,
        source: "propose",
        status: "pending",
        proposedTarget: { source: "other", root: otherDir },
      });

      const accepted = await runCliCapture([
        "proposal",
        "accept",
        queued[0]?.id ?? "",
        "--queue",
        "other",
        "--format",
        "json",
      ]);
      expect(accepted.code).toBe(0);
      expect(fs.readFileSync(path.join(otherDir, "skills", NAME, "SKILL.md"), "utf8")).toContain(
        "Queued for another bundle.",
      );
      expect(fs.existsSync(path.join(storage.stashDir, "skills", NAME))).toBe(false);
    });

    test("the generation prompt carries the target bundle's conventions, not the working bundle's", async () => {
      const result = await proposalNew("--bundle", "other");

      expect(result.code).toBe(0);
      expect(promptsSent()).toHaveLength(1);
      expect(promptSent()).toContain("OTHER-BUNDLE-CONVENTION");
      expect(promptSent()).not.toContain("WORK-BUNDLE-CONVENTION");
    });

    test("without --bundle the working bundle is the target and supplies the conventions, as before", async () => {
      const result = await proposalNew();

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, ref: `work//skills/${NAME}` });
      expect(listProposals(storage.stashDir)).toHaveLength(1);
      expect(listProposals(otherDir)).toHaveLength(0);
      expect(promptSent()).toContain("WORK-BUNDLE-CONVENTION");
      expect(promptSent()).not.toContain("OTHER-BUNDLE-CONVENTION");
    });

    test("an unknown bundle is refused before any model call", async () => {
      const result = await proposalNew("--bundle", "nope");

      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        code: "INVALID_FLAG_VALUE",
        error: expect.stringContaining('No source named "nope" is configured'),
      });
      expect(promptsSent()).toHaveLength(0);
    });

    test("a read-only bundle is refused before any model call", async () => {
      const result = await proposalNew("--bundle", "frozen");

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("source frozen is not writable");
      expect(promptsSent()).toHaveLength(0);
      expect(listProposals(readonlyDir)).toHaveLength(0);
    });
  });
});
