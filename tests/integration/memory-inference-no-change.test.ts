// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Memory inference: an explicit, cached "no change" decision (#1208).
 *
 * Unlike `memory-inference.test.ts`, these tests inject only the chat transport
 * (`_setChatCompletionForTests`) and run the real prompt/parse path, the real
 * cache validator and the real pass, so a reply on the wire is classified the
 * way production classifies it: a valid child, a successful no-change decision,
 * or a failure that must neither be cached nor counted as restraint.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../src/core/config/config";
import { _setWarnSinkForTests } from "../../src/core/warn";
import {
  collectPendingMemories,
  countPendingMemoriesNeedingDecision,
  runMemoryInferencePass,
} from "../../src/indexer/passes/memory-inference";
import type { SearchSource } from "../../src/indexer/search/search-source";
import { _setChatCompletionForTests, LlmCallError } from "../../src/llm/client";
import { closeDatabase, openIndexDatabase } from "../../src/storage/repositories/index-connection";
import {
  computeBodyHash,
  getLlmCacheEntry,
  upsertLlmCacheEntry,
} from "../../src/storage/repositories/index-llm-cache-repository";
import { withEnv } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

const NO_CHANGE_REPLY = JSON.stringify({
  noChange: true,
  title: "",
  description: "",
  content: "",
  tags: [],
  searchHints: [],
});

const CHILD_REPLY = JSON.stringify({
  noChange: false,
  title: "Retry backoff caps at 30s",
  description: "The HTTP client retries three times with a 30s backoff cap.",
  content: "The client retries 3 times. Backoff doubles from 1s and caps at 30s (config key `http.retryCap`).",
  tags: ["http", "retry", "backoff"],
  searchHints: ["http retry cap", "backoff 30s", "http.retryCap"],
});

const TOOL_COUNT_NOTE = "Tool calls this session: Read 12, Edit 4, Bash 9.";
const CHECKPOINT_NOTE = "Checkpoint: finished step 3 of 5, continuing.";
const ADEQUATE_NOTE = "The staging deploy key is rotated on the 1st of each month.";
const SUBSTANTIVE_NOTE =
  "Investigated flaky uploads. The HTTP client retries 3 times with doubling backoff starting at 1s; " +
  "the cap is 30s via http.retryCap. Raising it to 60s fixed the nightly import timeouts in staging.";

let tmpStash = "";
let chatCalls: string[] = [];
let reply: (userPrompt: string) => string | Promise<string> = () => NO_CHANGE_REPLY;
let warnings: string[] = [];

beforeEach(() => {
  tmpStash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-memory-infer-nochange-"));
  fs.mkdirSync(path.join(tmpStash, "memories"), { recursive: true });
  chatCalls = [];
  warnings = [];
  reply = () => NO_CHANGE_REPLY;
  overrideSeam(_setChatCompletionForTests, async (_config, messages) => {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    chatCalls.push(user);
    return reply(user);
  });
  overrideSeam(_setWarnSinkForTests, (level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  fs.rmSync(tmpStash, { recursive: true, force: true });
});

function writeMemory(name: string, body: string): string {
  const file = path.join(tmpStash, "memories", `${name}.md`);
  fs.writeFileSync(file, `---\ndescription: ${name}\n---\n\n${body}\n`, "utf8");
  return file;
}

function childPath(name: string): string {
  return path.join(tmpStash, "memories", `${name}.derived.md`);
}

function config(): AkmConfig {
  return {
    semanticSearchMode: "off",
    connections: { index: { endpoint: "http://127.0.0.1:1/v1/chat/completions", models: { fast: "scripted" } } },
    index: { connection: "index" },
  };
}

function sources(): SearchSource[] {
  return [{ path: tmpStash, isDefault: true }];
}

async function withDb<T>(fn: (db: ReturnType<typeof openIndexDatabase>) => Promise<T>): Promise<T> {
  const db = openIndexDatabase(path.join(tmpStash, "index.db"));
  try {
    return await fn(db);
  } finally {
    closeDatabase(db);
  }
}

describe("a successful no-change decision", () => {
  test.each([
    ["a tool-count note", TOOL_COUNT_NOTE],
    ["a checkpoint-only note", CHECKPOINT_NOTE],
    ["an already adequate short note", ADEQUATE_NOTE],
  ])("%s yields no child, no parent mutation and no failure count", async (_label, body) => {
    const parent = writeMemory("note", body);
    const before = fs.readFileSync(parent, "utf8");
    await withDb(async (db) => {
      const result = await runMemoryInferencePass({ config: config(), sources: sources(), db });
      expect(result).toMatchObject({
        considered: 1,
        noChange: 1,
        writtenFacts: 0,
        splitParents: 0,
        skippedNoFacts: 0,
        unaccounted: 0,
        htmlErrorCount: 0,
        scopeSynced: 0,
        writtenPaths: [],
      });
    });
    expect(chatCalls).toHaveLength(1);
    expect(fs.existsSync(childPath("note"))).toBe(false);
    // Not stamped: `inferenceProcessed` would hide every later edit of the note.
    expect(fs.readFileSync(parent, "utf8")).toBe(before);
    expect(parseFrontmatter(before).data.inferenceProcessed).toBeUndefined();
  });

  test("a second run on unchanged input makes zero model calls and leaves the parent untouched", async () => {
    const parent = writeMemory("note", TOOL_COUNT_NOTE);
    await withDb(async (db) => {
      await runMemoryInferencePass({ config: config(), sources: sources(), db });
      const afterFirst = fs.readFileSync(parent, "utf8");
      const mtime = fs.statSync(parent).mtimeMs;
      chatCalls = [];

      const second = await runMemoryInferencePass({ config: config(), sources: sources(), db });

      expect(chatCalls).toHaveLength(0);
      expect(second).toMatchObject({ considered: 1, cacheHits: 1, noChange: 1, skippedNoFacts: 0, writtenFacts: 0 });
      expect(second.writtenPaths).toEqual([]);
      expect(fs.readFileSync(parent, "utf8")).toBe(afterFirst);
      expect(fs.statSync(parent).mtimeMs).toBe(mtime);
      expect(fs.existsSync(childPath("note"))).toBe(false);
    });
  });

  test("a cached no-change needs neither a model call nor a materialized credential", async () => {
    writeMemory("note", TOOL_COUNT_NOTE);
    const keyed: AkmConfig = {
      semanticSearchMode: "off",
      connections: {
        index: {
          endpoint: "http://127.0.0.1:1/v1/chat/completions",
          models: { fast: "scripted" },
          apiKey: "$AKM_NOCHANGE_REQUIRED_KEY",
        },
      },
      index: { connection: "index" },
    };
    await withDb(async (db) => {
      // First run has the credential and records the decision.
      await withEnv({ AKM_NOCHANGE_REQUIRED_KEY: "k" }, () =>
        runMemoryInferencePass({ config: keyed, sources: sources(), db }),
      );
      chatCalls = [];
      // The credential is gone: only a cache-only batch may still succeed.
      const second = await withEnv({ AKM_NOCHANGE_REQUIRED_KEY: undefined }, () =>
        runMemoryInferencePass({ config: keyed, sources: sources(), db }),
      );
      expect(second).toMatchObject({ cacheHits: 1, noChange: 1 });
      expect(chatCalls).toHaveLength(0);
    });
  });

  test("a substantive edit makes the note eligible again; --re-enrich refreshes the decision", async () => {
    const parent = writeMemory("note", CHECKPOINT_NOTE);
    await withDb(async (db) => {
      await runMemoryInferencePass({ config: config(), sources: sources(), db });
      expect(chatCalls).toHaveLength(1);

      // Same input, explicit refresh: the cache is bypassed.
      await runMemoryInferencePass({ config: config(), sources: sources(), db, reEnrich: true });
      expect(chatCalls).toHaveLength(2);

      // Edited effective input: a miss, and a model that now finds something to keep.
      fs.writeFileSync(parent, `---\ndescription: note\n---\n\n${SUBSTANTIVE_NOTE}\n`, "utf8");
      reply = () => CHILD_REPLY;
      const edited = await runMemoryInferencePass({ config: config(), sources: sources(), db });

      expect(chatCalls).toHaveLength(3);
      expect(edited).toMatchObject({ cacheHits: 0, noChange: 0, splitParents: 1, writtenFacts: 1 });
      expect(fs.existsSync(childPath("note"))).toBe(true);
      expect(parseFrontmatter(fs.readFileSync(parent, "utf8")).data.inferenceProcessed).toBe(true);
    });
  });

  test("positive controls still produce children while restraint stays per note", async () => {
    writeMemory("count", TOOL_COUNT_NOTE);
    writeMemory("fact", SUBSTANTIVE_NOTE);
    reply = (prompt) => (prompt.includes("http.retryCap") ? CHILD_REPLY : NO_CHANGE_REPLY);
    await withDb(async (db) => {
      const result = await runMemoryInferencePass({ config: config(), sources: sources(), db });
      expect(result).toMatchObject({ considered: 2, noChange: 1, splitParents: 1, writtenFacts: 1, skippedNoFacts: 0 });
    });
    expect(fs.existsSync(childPath("fact"))).toBe(true);
    expect(fs.existsSync(childPath("count"))).toBe(false);
  });

  test("the decision is cached under the pass's cache variant with the effective input identity", async () => {
    const parent = writeMemory("note", TOOL_COUNT_NOTE);
    await withDb(async (db) => {
      await runMemoryInferencePass({ config: config(), sources: sources(), db });
      const input = collectPendingMemories(tmpStash)[0]?.effectiveInput ?? "";
      const entry = getLlmCacheEntry(db, parent, computeBodyHash(input), "memory-inference-v5");
      expect(JSON.parse(entry?.resultJson ?? "null")).toMatchObject({ noChange: true });
    });
  });

  test("without a cache the pass still reports restraint but the parent stays pending", async () => {
    const parent = writeMemory("note", TOOL_COUNT_NOTE);
    const first = await runMemoryInferencePass({ config: config(), sources: sources() });
    const second = await runMemoryInferencePass({ config: config(), sources: sources() });
    expect(first).toMatchObject({ noChange: 1, skippedNoFacts: 0 });
    expect(second).toMatchObject({ noChange: 1, skippedNoFacts: 0 });
    expect(chatCalls).toHaveLength(2);
    expect(parseFrontmatter(fs.readFileSync(parent, "utf8")).data.inferenceProcessed).toBeUndefined();
  });

  test("an existing derived child wins over a cached no-change and heals the parent", async () => {
    const parent = writeMemory("note", TOOL_COUNT_NOTE);
    await withDb(async (db) => {
      await runMemoryInferencePass({ config: config(), sources: sources(), db });
      fs.writeFileSync(childPath("note"), "---\ninferred: true\n---\n\nexternal\n", "utf8");
      chatCalls = [];
      const result = await runMemoryInferencePass({ config: config(), sources: sources(), db });
      expect(result).toMatchObject({ skippedChildExists: 1, noChange: 0 });
      expect(chatCalls).toHaveLength(0);
      expect(parseFrontmatter(fs.readFileSync(parent, "utf8")).data.inferenceProcessed).toBe(true);
    });
  });
});

describe("failures are never no-change", () => {
  const failures: Array<[string, () => string | Promise<string>]> = [
    ["a non-JSON reply", () => "I think this note needs no changes."],
    ["an HTML page", () => "<html><body>nginx</body></html>"],
    ["an empty reply", () => ""],
    ["an empty object", () => "{}"],
    ["a string noChange", () => JSON.stringify({ noChange: "true" })],
    ["noChange false with empty fields", () => JSON.stringify({ noChange: false, title: "", content: "" })],
    [
      "a transport failure",
      () => {
        throw new Error("connect ECONNREFUSED");
      },
    ],
    [
      "a provider HTML error",
      () => {
        throw new LlmCallError("provider returned an HTML document", "provider_html_error");
      },
    ],
    [
      "a timeout",
      () => {
        throw new LlmCallError("request timed out", "timeout");
      },
    ],
  ];

  test.each(failures)("%s is not cached, not counted, and is retried on the next run", async (_label, bad) => {
    const parent = writeMemory("note", CHECKPOINT_NOTE);
    const before = fs.readFileSync(parent, "utf8");
    await withDb(async (db) => {
      reply = bad;
      const failed = await runMemoryInferencePass({ config: config(), sources: sources(), db });
      expect(failed).toMatchObject({ considered: 1, noChange: 0, skippedNoFacts: 1, writtenFacts: 0 });
      expect(fs.readFileSync(parent, "utf8")).toBe(before);
      const input = collectPendingMemories(tmpStash)[0]?.effectiveInput ?? "";
      expect(getLlmCacheEntry(db, parent, computeBodyHash(input), "memory-inference-v5")).toBeUndefined();

      // The retry is a real model call, and a good reply is then honoured.
      reply = () => NO_CHANGE_REPLY;
      chatCalls = [];
      const retried = await runMemoryInferencePass({ config: config(), sources: sources(), db });
      expect(chatCalls).toHaveLength(1);
      expect(retried).toMatchObject({ noChange: 1, skippedNoFacts: 0 });
    });
  });

  test("an aborted batch dispatches nothing and records no decision", async () => {
    const parent = writeMemory("note", CHECKPOINT_NOTE);
    const controller = new AbortController();
    controller.abort();
    await withDb(async (db) => {
      const result = await runMemoryInferencePass({
        config: config(),
        sources: sources(),
        db,
        signal: controller.signal,
      });
      expect(result).toMatchObject({ skippedAborted: 1, noChange: 0, skippedNoFacts: 0 });
      expect(chatCalls).toHaveLength(0);
      const input = collectPendingMemories(tmpStash)[0]?.effectiveInput ?? "";
      expect(getLlmCacheEntry(db, parent, computeBodyHash(input), "memory-inference-v5")).toBeUndefined();
    });
  });

  test("an invalid HTML reply is counted as an HTML error, not as restraint", async () => {
    writeMemory("note", CHECKPOINT_NOTE);
    reply = () => {
      throw new LlmCallError("provider returned an HTML document", "provider_html_error");
    };
    const result = await runMemoryInferencePass({ config: config(), sources: sources() });
    expect(result).toMatchObject({ htmlErrorCount: 1, noChange: 0, skippedNoFacts: 1 });
    expect(warnings.join("\n")).toContain("HTML");
  });
});

describe("old cache data", () => {
  test("a previous-namespace entry is a disposable miss", async () => {
    const parent = writeMemory("note", CHECKPOINT_NOTE);
    await withDb(async (db) => {
      const input = collectPendingMemories(tmpStash)[0]?.effectiveInput ?? "";
      upsertLlmCacheEntry(
        db,
        parent,
        computeBodyHash(input),
        JSON.stringify({ noChange: true }),
        "memory-inference-v3",
      );
      const result = await runMemoryInferencePass({ config: config(), sources: sources(), db });
      expect(chatCalls).toHaveLength(1);
      expect(result.cacheHits).toBe(0);
    });
  });

  test("an unrecognised entry under the current namespace falls through to a model call", async () => {
    const parent = writeMemory("note", CHECKPOINT_NOTE);
    await withDb(async (db) => {
      const input = collectPendingMemories(tmpStash)[0]?.effectiveInput ?? "";
      for (const junk of ["{}", '{"noChange":"yes"}', "[1]", "not json"]) {
        upsertLlmCacheEntry(db, parent, computeBodyHash(input), junk, "memory-inference-v5");
        chatCalls = [];
        const result = await runMemoryInferencePass({ config: config(), sources: sources(), db });
        expect(chatCalls).toHaveLength(1);
        expect(result.cacheHits).toBe(0);
      }
    });
  });
});

describe("the minPendingCount gate count (#1219)", () => {
  const inputFor = (file: string) => {
    const record = collectPendingMemories(tmpStash).find((record) => record.filePath === file);
    if (!record) throw new Error("Missing pending fixture");
    return record.effectiveInput;
  };
  const decide = (db: Parameters<typeof upsertLlmCacheEntry>[0], file: string) =>
    upsertLlmCacheEntry(
      db,
      file,
      computeBodyHash(inputFor(file)),
      JSON.stringify({ noChange: true }),
      "memory-inference-v5",
    );

  test("excludes a parent whose current body has a cached no-change decision", async () => {
    const decided = writeMemory("decided", TOOL_COUNT_NOTE);
    writeMemory("fresh", CHECKPOINT_NOTE);
    await withDb(async (db) => {
      decide(db, decided);
      expect(countPendingMemoriesNeedingDecision(tmpStash, db)).toBe(1);
      // Without a database every pending parent counts.
      expect(countPendingMemoriesNeedingDecision(tmpStash)).toBe(2);
    });
  });

  test("counts a parent again once its body is edited", async () => {
    const parent = writeMemory("note", TOOL_COUNT_NOTE);
    await withDb(async (db) => {
      decide(db, parent);
      expect(countPendingMemoriesNeedingDecision(tmpStash, db)).toBe(0);
      writeMemory("note", SUBSTANTIVE_NOTE);
      expect(countPendingMemoriesNeedingDecision(tmpStash, db)).toBe(1);
    });
  });

  test("counts a parent that has no cache row, a stale namespace, or a cached child draft", async () => {
    const stale = writeMemory("stale", TOOL_COUNT_NOTE);
    const drafted = writeMemory("drafted", ADEQUATE_NOTE);
    writeMemory("none", CHECKPOINT_NOTE);
    await withDb(async (db) => {
      upsertLlmCacheEntry(
        db,
        stale,
        computeBodyHash(inputFor(stale)),
        JSON.stringify({ noChange: true }),
        "memory-inference-v3",
      );
      upsertLlmCacheEntry(db, drafted, computeBodyHash(inputFor(drafted)), CHILD_REPLY, "memory-inference-v5");
      expect(countPendingMemoriesNeedingDecision(tmpStash, db)).toBe(3);
    });
  });
});

describe("the prompt", () => {
  test("offers the no-change decision and still asks for a child otherwise", async () => {
    writeMemory("note", CHECKPOINT_NOTE);
    await runMemoryInferencePass({ config: config(), sources: sources() });
    const prompt = chatCalls[0] ?? "";
    expect(prompt).toContain("noChange");
    expect(prompt).toContain("derived memory");
    expect(prompt.slice(prompt.indexOf("\n\nBody:\n") + "\n\nBody:\n".length)).toBe(CHECKPOINT_NOTE);
  });
});
