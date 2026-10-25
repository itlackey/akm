// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The connections / harnesses / work table: one row per configured connection
 * and harness, and per kind of work the connection or harness and model it
 * resolves to. The work rows come from the resolvers the calls use, so these
 * tests configure the way a user does and read what a call would pick.
 */

import { describe, expect, test } from "bun:test";
import {
  type ConnectionRow,
  type HarnessRow,
  type ProcessName,
  type ProcessRow,
  targetRows,
} from "../../src/commands/targets";
import type { AkmConfig } from "../../src/core/config/config";
import { writeCredential } from "../../src/core/config/credentials";
import { renderTargetsTable } from "../../src/output/text/targets-table";

const cfg = (partial: Partial<AkmConfig> = {}): AkmConfig => ({ semanticSearchMode: "off", ...partial });
const MODELS = { fast: "small", balanced: "mid", reasoning: "big" };
const onPath =
  (...bins: string[]) =>
  (bin: string) =>
    bins.includes(bin) ? `/usr/bin/${bin}` : undefined;

const rows = (config: AkmConfig, extra: Partial<Parameters<typeof targetRows>[0]> = {}) =>
  targetRows({ config, which: onPath(), env: {}, ...extra });
const connection = (all: ReturnType<typeof rows>, name: string) =>
  all.find((r): r is ConnectionRow => r.type === "connection" && r.name === name);
const harness = (all: ReturnType<typeof rows>, name: string) =>
  all.find((r): r is HarnessRow => r.type === "harness" && r.name === name);
const work = (all: ReturnType<typeof rows>, name: ProcessName) =>
  all.find((r): r is ProcessRow => r.type === "process" && r.process === name) as ProcessRow;

describe("connection rows", () => {
  test("one row per connection with its endpoint, the default marked", () => {
    const all = rows(
      cfg({
        connections: {
          default: { endpoint: "http://localhost:11434/v1", models: MODELS },
          cloud: { endpoint: "https://api.example.test/v1", models: MODELS },
        },
      }),
    );
    expect(connection(all, "default")).toEqual({
      type: "connection",
      name: "default",
      default: true,
      endpoint: "http://localhost:11434/v1",
      key: "none",
    });
    expect(connection(all, "cloud")?.default).toBe(false);
  });

  test("a lone connection is the default whatever it is called", () => {
    const all = rows(cfg({ connections: { lab: { endpoint: "http://lab/v1", models: MODELS } } }));
    expect(connection(all, "lab")?.default).toBe(true);
  });

  test("the key is reported as held, never its value: a $VAR set or not, an entry in credentials.json, or none", () => {
    writeCredential({ connection: "stored" }, "the-stored-secret", "http://c/v1");
    const all = rows(
      cfg({
        connections: {
          set: { endpoint: "http://a/v1", apiKey: "$A_KEY", models: MODELS },
          unset: { endpoint: "http://b/v1", apiKey: "$B_KEY", models: MODELS },
          stored: { endpoint: "http://c/v1", models: MODELS },
          bare: { endpoint: "http://d/v1", models: MODELS },
        },
      }),
      { env: { A_KEY: "the-env-secret" } },
    );
    expect(["set", "unset", "stored", "bare"].map((name) => connection(all, name)?.key)).toEqual([
      "env-set",
      "env-unset",
      "credentials",
      "none",
    ]);
    const serialized = JSON.stringify(all);
    expect(serialized).not.toContain("the-env-secret");
    expect(serialized).not.toContain("the-stored-secret");
    expect(serialized).not.toContain("A_KEY");
    expect(serialized).not.toContain("B_KEY");
  });

  test("an endpoint that carries a credential is shown without it", () => {
    const all = rows(
      cfg({ connections: { lab: { endpoint: "https://user:pass@host.example.test/v1?token=abc", models: MODELS } } }),
    );
    const endpoint = connection(all, "lab")?.endpoint ?? "";
    expect(endpoint).not.toContain("pass");
    expect(endpoint).not.toContain("abc");
  });

  test("reachability appears only when the caller supplies it", () => {
    const config = cfg({
      connections: { a: { endpoint: "http://a/v1", models: MODELS }, b: { endpoint: "http://b/v1", models: MODELS } },
    });
    const all = rows(config, {
      reachability: new Map([
        ["a", { reachable: true }],
        ["b", { reachable: false, error: "connection refused" }],
      ]),
    });
    expect(connection(all, "a")).toMatchObject({ reachable: true });
    expect(connection(all, "b")).toMatchObject({ reachable: false, error: "connection refused" });
    expect(connection(rows(config), "a")).not.toHaveProperty("reachable");
  });
});

describe("harness rows", () => {
  test("a harness is installed when its binary is found; the default is marked; a second install is its own row", () => {
    const all = rows(
      cfg({
        harnesses: {
          default: { platform: "claude" },
          codex: {},
          "claude-work": { platform: "claude", bin: "/opt/claude-work/bin/claude" },
        },
      }),
      { which: onPath("claude", "/opt/claude-work/bin/claude") },
    );
    expect(harness(all, "default")).toEqual({
      type: "harness",
      name: "default",
      default: true,
      platform: "claude",
      bin: "claude",
      installed: true,
    });
    expect(harness(all, "codex")).toMatchObject({ platform: "codex", installed: false, default: false });
    expect(harness(all, "claude-work")).toMatchObject({
      platform: "claude",
      bin: "/opt/claude-work/bin/claude",
      installed: true,
    });
  });

  test("a harness set to modelWork: false says so on its row and in the table, and model work has nowhere to run", () => {
    const all = rows(cfg({ harnesses: { gemini: { modelWork: false } } }), { which: onPath("gemini") });
    expect(harness(all, "gemini")).toMatchObject({ installed: true, modelWork: false });
    expect(work(all, "improve")).toMatchObject({ kind: null, target: null });
    expect(work(all, "agents")).toMatchObject({ kind: "harness", target: "gemini" });
    const table = renderTargetsTable(all).join("\n");
    expect(table).toContain("MODEL CALLS");
    expect(table).toMatch(/gemini\s+yes\s+gemini\s+yes\s+off/);
    // A config with no such harness has no such column.
    expect(renderTargetsTable(rows(cfg({ harnesses: { claude: {} } }))).join("\n")).not.toContain("MODEL CALLS");
  });

  test("the version a caller read appears on the row", () => {
    const all = rows(cfg({ harnesses: { claude: {} } }), {
      which: onPath("claude"),
      versions: new Map([["claude", "2.1.0 (Claude Code)"]]),
    });
    expect(harness(all, "claude")?.version).toBe("2.1.0 (Claude Code)");
  });
});

describe("work rows", () => {
  test("with a connection and a harness: model work runs on the connection at the alias each kind asks for, agent work on the harness", () => {
    const all = rows(
      cfg({
        connections: { default: { endpoint: "http://localhost:11434/v1", models: MODELS } },
        harnesses: { claude: {} },
      }),
    );
    expect(work(all, "improve")).toMatchObject({ kind: "connection", target: "default", model: "small" });
    expect(work(all, "judges")).toMatchObject({ kind: "connection", target: "default", model: "mid" });
    expect(work(all, "extract")).toMatchObject({ kind: "connection", target: "default", model: "small" });
    expect(work(all, "enrich")).toMatchObject({ kind: "connection", target: "default", model: "small" });
    expect(work(all, "index")).toMatchObject({ kind: "connection", target: "default", model: "small" });
    expect(work(all, "agents")).toMatchObject({ kind: "harness", target: "claude" });
  });

  test("with a connection alone, agent work runs over it", () => {
    const all = rows(cfg({ connections: { default: { endpoint: "http://x/v1", models: MODELS } } }));
    expect(work(all, "agents")).toMatchObject({ kind: "connection", target: "default", model: "mid" });
  });

  test("with a harness alone, model work goes through it", () => {
    const all = rows(cfg({ harnesses: { claude: {} } }));
    expect(work(all, "improve")).toMatchObject({ kind: "harness", target: "claude" });
    expect(work(all, "judges")).toMatchObject({ kind: "harness", target: "claude" });
  });

  test("with neither, nothing runs and nothing is wrong", () => {
    const all = rows(cfg());
    const names: ProcessName[] = [
      "improve",
      "judges",
      "agents",
      "extract",
      "enrich",
      "index",
      "embedding",
      "curate-rerank",
    ];
    for (const name of names) {
      expect(work(all, name)).toEqual({ type: "process", process: name, kind: null, target: null, model: null });
    }
  });

  test("a process pinned to another connection resolves there, and the row names what resolves elsewhere", () => {
    const all = rows(
      cfg({
        connections: {
          default: { endpoint: "http://a/v1", models: MODELS },
          cloud: { endpoint: "https://b/v1", models: { fast: "c-small", balanced: "c-mid", reasoning: "c-big" } },
        },
        improve: { processes: { distill: { connection: "cloud" } } },
      }),
    );
    expect(work(all, "improve")).toMatchObject({
      target: "default",
      model: "small",
      overrides: [{ name: "distill", target: "cloud", model: "c-small" }],
    });
  });

  test("the text table says where a pinned part runs and on which model", () => {
    const all = rows(
      cfg({
        connections: {
          default: { endpoint: "http://a/v1", models: MODELS },
          cloud: { endpoint: "https://b/v1", models: { fast: "c-small", balanced: "c-mid", reasoning: "c-big" } },
        },
        improve: { processes: { distill: { connection: "cloud" } } },
      }),
    );
    expect(renderTargetsTable(all).join("\n")).toContain("distill → cloud (c-small)");
  });

  test("the quality gate and the triage judgment may judge elsewhere", () => {
    const all = rows(
      cfg({
        connections: {
          default: { endpoint: "http://a/v1", models: MODELS },
          cloud: { endpoint: "https://b/v1", models: { fast: "c-small", balanced: "c-mid", reasoning: "c-big" } },
        },
        improve: { qualityGate: { connection: "cloud" }, processes: { triage: { connection: "cloud" } } },
      }),
    );
    expect(work(all, "judges")).toMatchObject({
      target: "default",
      model: "mid",
      overrides: [
        { name: "triage judgment", target: "cloud", model: "c-mid" },
        { name: "quality gate", target: "cloud", model: "c-mid" },
      ],
    });
  });

  test("a model asked for by name is the model, an alias is looked up", () => {
    const all = rows(
      cfg({
        connections: { default: { endpoint: "http://a/v1", models: MODELS } },
        index: { memory: { model: "exact-model" } } as never,
      }),
    );
    expect(work(all, "index")).toMatchObject({ model: "exact-model" });
  });

  test("a connection that lists no models is a problem to report, not a row that quietly does not run", () => {
    const all = rows(cfg({ connections: { default: { endpoint: "http://a/v1" } } }));
    expect(work(all, "improve").problem).toContain("lists no models");
    expect(work(all, "improve").kind).toBeNull();
  });

  test("embeddings: off with semantic search, the built-in embedder, a model the connection serves, or an endpoint of its own", () => {
    const base = { connections: { default: { endpoint: "http://a/v1", models: MODELS } } };
    expect(work(rows(cfg({ ...base })), "embedding").kind).toBeNull();
    expect(work(rows(cfg({ ...base, semanticSearchMode: "auto" })), "embedding")).toMatchObject({
      kind: "local",
      target: "built-in",
    });
    expect(
      work(rows(cfg({ ...base, semanticSearchMode: "auto", embedding: { model: "nomic-embed-text" } })), "embedding"),
    ).toMatchObject({ kind: "connection", target: "default", model: "nomic-embed-text" });
    expect(
      work(
        rows(
          cfg({
            ...base,
            semanticSearchMode: "auto",
            embedding: { endpoint: "https://u:p@emb.example.test/v1", model: "e5" },
          }),
        ),
        "embedding",
      ),
    ).toMatchObject({ kind: "endpoint", target: "https://emb.example.test/v1", model: "e5" });
  });

  test("curate rerank runs on its own endpoint when enabled", () => {
    const off = rows(cfg({ search: { curateRerank: { endpoint: "http://r/rerank" } } }));
    expect(work(off, "curate-rerank").kind).toBeNull();
    const on = rows(cfg({ search: { curateRerank: { enabled: true, endpoint: "http://r/rerank", model: "rr" } } }));
    expect(work(on, "curate-rerank")).toMatchObject({ kind: "endpoint", target: "http://r/rerank", model: "rr" });
  });
});
