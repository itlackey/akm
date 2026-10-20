// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm proposal new --bundle <name>` queues the proposal for another configured
 * bundle. Drives the real CLI against an LLM stub on 127.0.0.1 (the way
 * proposal-new-engines.test.ts does), with two configured bundles: the working
 * bundle `work` and a second one, `other`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProposals } from "../../../src/commands/proposal/repository";
import { type CliResult, runCliCapture } from "../../_helpers/cli";
import { serveLlmStub } from "../../_helpers/engine-stubs";
import {
  type IsolatedAkmStorage,
  STASH_SKELETON_SUBDIRS,
  withIsolatedAkmStorage,
  writeSandboxConfig,
} from "../../_helpers/sandbox";

const NAME = "bundle-proof";
const CONTENT =
  "---\ndescription: Proves proposal new --bundle\nwhen_to_use: Checking the bundle flag\n---\n\nQueued for another bundle.\n";
const PROPOSAL = JSON.stringify({ ref: `skills/${NAME}`, content: CONTENT, confidence: 0.8 });

const { server: llmStub, bodies: llmBodies } = serveLlmStub({ proposal: [PROPOSAL] });
const extraDirs: string[] = [];
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

afterAll(() => {
  llmStub.stop(true);
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
    defaultWriteTarget: "work",
    engines: {
      llm: {
        kind: "llm",
        endpoint: `http://127.0.0.1:${llmStub.port}/proposal/v1/chat/completions`,
        model: "stub-model",
      },
    },
    defaults: { engine: "llm" },
  });
});

afterEach(() => {
  storage.cleanup();
  llmBodies.length = 0;
});

function proposalNew(...extra: string[]): Promise<CliResult> {
  return runCliCapture(["proposal", "new", "skill", NAME, "--task", "Author a skill", ...extra, "--format", "json"]);
}

function promptSent(): string {
  const body = llmBodies[0] as { messages: Array<{ content: string }> };
  return body.messages.map((message) => message.content).join("\n");
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
    expect(llmBodies).toHaveLength(1);
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
    expect(llmBodies).toHaveLength(0);
  });

  test("a read-only bundle is refused before any model call", async () => {
    const result = await proposalNew("--bundle", "frozen");

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("source frozen is not writable");
    expect(llmBodies).toHaveLength(0);
    expect(listProposals(readonlyDir)).toHaveLength(0);
  });
});
