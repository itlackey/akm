// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Project-aware browsing (`assets.search` with a project, `assets.projectOverview`) and connection removal
 * (`config.removeConnection`) against a sandbox of two bundles: the operations agree with `akmSearch` and the config schema.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmSearch } from "../../../src/commands/read/search";
import { loadConfig, resetConfigCache } from "../../../src/core/config/config";
import { storedCredential } from "../../../src/core/config/credentials";
import { getConfigPath } from "../../../src/core/paths";
import { akmIndex } from "../../../src/indexer/indexer";
import { assets, config } from "../../../src/workspace";
import { writeSandboxConfig } from "../../_helpers/sandbox";
import { ctx, expectUsage, type Json, out, useSandbox } from "./workspace-behaviour-helpers";

useSandbox();

const doc = (project?: string) =>
  `---\ndescription: Synthetic ${project ?? "unscoped"}\n${project ? `project: ${project}\n` : ""}---\n# Doc\n\nBody.\n`;
const write = (root: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const refs = (result: Json) => result.hits.map((hit: { ref: string }) => hit.ref).sort();

async function seedProjects() {
  const stash = ctx.storage.stashDir;
  const team = path.join(ctx.storage.root, "team");
  fs.mkdirSync(path.join(ctx.storage.root, "off"), { recursive: true });
  write(stash, "knowledge/a.md", doc("alpha"));
  write(stash, "knowledge/b.md", doc("beta"));
  write(stash, "knowledge/c.md", doc());
  write(team, "knowledge/d.md", doc("alpha"));
  write(team, "memories/m.md", doc("alpha"));
  write(team, "knowledge/e.md", doc("beta"));
  writeSandboxConfig({
    bundles: {
      stash: { path: stash, writable: true },
      team: { path: team, writable: true },
      off: { path: path.join(ctx.storage.root, "off"), enabled: false },
    },
    defaultBundle: "stash",
    defaultWriteTarget: "stash",
    semanticSearchMode: "off",
    projects: {
      alpha: { from: ["stash", "team"], filters: { project: "alpha" }, prefer: { project: "alpha" } },
      beta: { from: "stash", filters: { project: ["beta", ""] } },
      gone: { from: ["nope", "off", "stash"] },
      open: {},
    },
  });
  resetConfigCache();
  await akmIndex({ stashDir: stash, full: true });
}

describe("assets.search with a project", () => {
  test("applies the project's from, filters and prefer, as akmSearch does, and leaves the Library unchanged without one", async () => {
    await seedProjects();
    const all = await out(assets.search({ q: "", limit: 50 }));
    expect(all.project).toBeUndefined();
    expect(refs(all)).toHaveLength(6);

    const alpha = await out(assets.search({ q: "", project: "alpha", limit: 50 }));
    expect(alpha.project).toMatchObject({ name: "alpha", from: ["stash", "team"], filters: { project: "alpha" } });
    expect(refs(alpha)).toEqual(["knowledge/a", "team//knowledge/d", "team//memories/m"]);
    const direct = await akmSearch({
      query: "",
      limit: 50,
      source: ["stash", "team"],
      filters: { project: "alpha" },
      prefer: { project: "alpha" },
      readOnly: true,
    });
    expect(refs(alpha)).toEqual(direct.hits.map((hit) => (hit as { ref: string }).ref).sort());

    // A filter value of "" admits the assets that lack the key.
    expect(refs(await out(assets.search({ q: "", project: "beta", limit: 50 })))).toEqual([
      "knowledge/b",
      "knowledge/c",
    ]);
  });

  test("an explicit bundle replaces from, a non-blank scope replaces filters, and an unknown project is refused", async () => {
    await seedProjects();
    const team = await out(assets.search({ q: "", project: "alpha", bundle: "team", limit: 50 }));
    expect(refs(team)).toEqual(["team//knowledge/d", "team//memories/m"]);
    // A blank scope value is omitted, so the project's filters still apply.
    const blank = await out(assets.search({ q: "", project: "alpha", scope: { channel: "" }, limit: 50 }));
    expect(refs(blank)).toHaveLength(3);
    await expectUsage(() => assets.search({ q: "", project: "nope" }), "INVALID_FLAG_VALUE");
    // "none" selects no project.
    expect((await out(assets.search({ q: "", project: "none", limit: 50 }))).project).toBeUndefined();
  });
});

describe("assets.projectOverview", () => {
  test("counts the whole index per bundle, total and eligible, and agrees with search", async () => {
    await seedProjects();
    const alpha = await out(assets.projectOverview({ project: "alpha" }));
    expect(alpha).toMatchObject({
      project: { name: "alpha", from: ["stash", "team"], filters: { project: "alpha" }, prefer: { project: "alpha" } },
      fromImplicit: false,
      preferImplicit: false,
      writeBundle: { name: "stash", implicit: true, usable: true },
    });
    expect(alpha.bundles).toMatchObject([
      {
        name: "stash",
        configured: true,
        enabled: true,
        readable: true,
        writable: true,
        total: { count: 3 },
        eligible: { count: 1 },
      },
      { name: "team", total: { count: 3 }, eligible: { count: 2, byType: { knowledge: 1, memory: 1 } } },
    ]);
    const found = await out(assets.search({ q: "", project: "alpha", limit: 200 }));
    expect(alpha.bundles.reduce((sum: number, bundle: Json) => sum + bundle.eligible.count, 0)).toBe(found.hits.length);
  });

  test("a project without from reads every local bundle; a missing or disabled bundle is reported, not counted", async () => {
    await seedProjects();
    const open = await out(assets.projectOverview({ project: "open" }));
    expect(open).toMatchObject({ fromImplicit: true, preferImplicit: true, project: { prefer: { project: "open" } } });
    expect(open.bundles.map((bundle: Json) => bundle.name)).toEqual(["stash", "team"]);
    expect(open.bundles.every((bundle: Json) => bundle.eligible.count === bundle.total.count)).toBe(true);

    const gone = await out(assets.projectOverview({ project: "gone" }));
    expect(gone.bundles).toMatchObject([
      { name: "nope", configured: false, readable: false, total: null, eligible: null },
      { name: "off", configured: true, enabled: false, readable: false, total: null, eligible: null },
      { name: "stash", readable: true, total: { count: 3 } },
    ]);
  });

  test("refuses a blank, unknown or `none` project", async () => {
    await seedProjects();
    await expectUsage(() => assets.projectOverview({ project: " " }));
    await expectUsage(() => assets.projectOverview({ project: "nope" }), "INVALID_FLAG_VALUE");
    await expectUsage(() => assets.projectOverview({ project: "none" }), "INVALID_FLAG_VALUE");
  });
});

describe("config.removeConnection", () => {
  const saved = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
  function seedConnections(extra: Record<string, unknown> = {}) {
    writeSandboxConfig({
      bundles: { stash: { path: ctx.storage.stashDir, writable: true } },
      defaultBundle: "stash",
      connections: {
        default: { endpoint: "http://127.0.0.1:1/v1", apiKey: "$SYNTH_KEY", models: { fast: "small" } },
        lab: {
          endpoint: "http://127.0.0.1:2/v1",
          models: { judge: { model: "big", temperature: 0 }, summarize: "mid" },
          top_p: 0.9,
        },
      },
      improve: { connection: "lab", processes: { reflect: { connection: "lab" }, distill: { connection: "default" } } },
      unrelated: { keep: [1] },
      ...extra,
    });
    resetConfigCache();
  }

  test("removes one connection, reports its references and the default after, and keeps everything else", async () => {
    seedConnections();
    const before = config.get();
    expect(before.defaultConnection).toBe("default");
    expect(before.connections.map((connection: Json) => [connection.name, connection.inherited])).toEqual([
      ["default", false],
      ["lab", false],
    ]);
    expect(before.connections.find((connection: Json) => connection.name === "lab")?.usedBy).toEqual([
      "improve.connection",
      "improve.processes.reflect.connection",
    ]);

    const removed = config.removeConnection({ name: "lab" });
    expect(removed).toEqual({
      saved: true,
      references: ["improve.connection", "improve.processes.reflect.connection"],
      wasDefault: false,
      defaultConnection: "default",
      stillInherited: false,
    });
    expect(saved().connections).toEqual({
      default: { endpoint: "http://127.0.0.1:1/v1", apiKey: "$SYNTH_KEY", models: { fast: "small" } },
    });
    expect(saved().unrelated).toEqual({ keep: [1] });
    expect(loadConfig().connections?.lab).toBeUndefined();
  });

  test("saveConnection replaces the entry: removed aliases and cleared options leave the file; a literal key is refused", async () => {
    seedConnections();
    const lab = JSON.parse(JSON.stringify(loadConfig().connections?.lab));
    lab.models = { fast: "lab-small", judge: "big" };
    delete lab.top_p;
    expect(config.saveConnection({ name: "lab", entry: lab })).toEqual({ saved: true });
    expect(saved().connections.lab).toEqual({
      endpoint: "http://127.0.0.1:2/v1",
      models: { fast: "lab-small", judge: "big" },
    });
    expect(saved().connections.default.apiKey).toBe("$SYNTH_KEY");
    expect(saved().unrelated).toEqual({ keep: [1] });
    expect(config.saveConnection({ name: "lab", entry: lab })).toEqual({ saved: false });
    await expectUsage(() => config.saveConnection({ name: "lab", entry: { ...lab, apiKey: "sk-literal" } }));
    await expectUsage(() => config.saveConnection({ name: " ", entry: lab }));
    // A new name is added.
    expect(config.saveConnection({ name: "extra", entry: { endpoint: "http://127.0.0.1:4/v1" } })).toEqual({
      saved: true,
    });
    expect(Object.keys(saved().connections)).toEqual(["default", "lab", "extra"]);
  });

  test("removing the default hands the default to the sole remaining connection, then to none", async () => {
    seedConnections();
    expect(config.removeConnection({ name: "default" })).toMatchObject({
      wasDefault: true,
      defaultConnection: "lab",
      references: ["improve.processes.distill.connection"],
    });
    expect(config.removeConnection({ name: "lab" })).toMatchObject({ wasDefault: true, defaultConnection: null });
    expect(saved().connections ?? {}).toEqual({});
  });

  test("refuses an unknown or blank name, and a connection only an extends base defines", async () => {
    const base = path.join(ctx.storage.root, "base.json");
    fs.writeFileSync(base, JSON.stringify({ connections: { shared: { endpoint: "http://127.0.0.1:3/v1" } } }));
    seedConnections({ extends: base });
    const shared = config.get().connections.find((connection: Json) => connection.name === "shared");
    expect([shared?.inherited, shared?.source]).toEqual([true, `extends:${base}`]);
    expect(config.get().connections.find((connection: Json) => connection.name === "lab")?.source).toBe("file");
    await expectUsage(() => config.removeConnection({ name: "nope" }));
    await expectUsage(() => config.removeConnection({ name: " " }));
    await expectUsage(() => config.removeConnection({ name: "shared" }), "TARGET_NOT_UPDATABLE");
    expect(Object.keys(saved().connections)).toEqual(["default", "lab"]);
  });
});

describe("config.saveEmbedding", () => {
  const KEY = "sk-synthetic-embedding-key-0001";
  const saved = () => JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
  function seed(embedding?: Record<string, unknown>) {
    writeSandboxConfig({
      bundles: { stash: { path: ctx.storage.stashDir, writable: true } },
      defaultBundle: "stash",
      connections: { default: { endpoint: "http://127.0.0.1:1/v1", models: { fast: "small" } } },
      semanticSearchMode: "off",
      ...(embedding ? { embedding } : {}),
    });
    resetConfigCache();
  }

  test("an endpoint is normalized as setup does, a pasted key goes to credentials.json and never config.json", () => {
    seed();
    expect(config.get().embeddingKeyEndpoint).toBeNull();
    expect(typeof config.get().localEmbeddings).toBe("boolean");
    const result = config.saveEmbedding({
      kind: "endpoint",
      endpoint: "http://127.0.0.1:11434",
      model: "embed-a",
      key: { pasted: ` ${KEY} ` },
    });
    expect(result).toEqual({ saved: true, embedding: { endpoint: "http://127.0.0.1:11434/v1", model: "embed-a" } });
    expect(saved().embedding).toEqual({ endpoint: "http://127.0.0.1:11434/v1", model: "embed-a" });
    expect(saved().semanticSearchMode).toBe("auto");
    expect(storedCredential({ service: "embedding" })).toEqual({ key: KEY, endpoint: "http://127.0.0.1:11434/v1" });
    expect(config.get().embeddingKeyEndpoint).toBe("http://127.0.0.1:11434/v1");
    expect(JSON.stringify(config.get())).not.toContain(KEY);
    expect(fs.readFileSync(getConfigPath(), "utf8")).not.toContain(KEY);
  });

  test("an env key is the block's $VAR; the same endpoint keeps it, a new endpoint drops it", () => {
    seed();
    config.saveEmbedding({
      kind: "endpoint",
      endpoint: "http://127.0.0.1:2/v1",
      model: "m",
      key: { env: "EMBED_KEY" },
    });
    expect(saved().embedding).toEqual({ endpoint: "http://127.0.0.1:2/v1", model: "m", apiKey: "$EMBED_KEY" });
    config.saveEmbedding({ kind: "endpoint", endpoint: "http://127.0.0.1:2", model: "m2" });
    expect(saved().embedding).toEqual({ endpoint: "http://127.0.0.1:2/v1", model: "m2", apiKey: "$EMBED_KEY" });
    config.saveEmbedding({ kind: "endpoint", endpoint: "http://127.0.0.1:3/v1", model: "m2" });
    expect(saved().embedding).toEqual({ endpoint: "http://127.0.0.1:3/v1", model: "m2" });
  });

  test("the default connection's model keeps the block's tuning; local removes the target and keeps the rest", () => {
    seed({ endpoint: "http://127.0.0.1:2/v1", model: "m", apiKey: "$EMBED_KEY", batchSize: 4 });
    config.saveEmbedding({ kind: "connection", model: "embed-b" });
    expect(saved().embedding).toEqual({ model: "embed-b", batchSize: 4 });
    expect(saved().semanticSearchMode).toBe("auto");
    if (config.get().localEmbeddings) {
      expect(config.saveEmbedding({ kind: "local" })).toEqual({ saved: true, embedding: { batchSize: 4 } });
      expect(saved().embedding).toEqual({ batchSize: 4 });
      seed({ model: "m" });
      expect(config.saveEmbedding({ kind: "local" })).toEqual({ saved: true, embedding: null });
      expect(saved().embedding).toBeUndefined();
    }
  });

  test("a bad answer throws before anything is written", async () => {
    seed();
    const before = fs.readFileSync(getConfigPath(), "utf8");
    await expectUsage(() =>
      config.saveEmbedding({ kind: "endpoint", endpoint: "nope", model: "m", key: { pasted: KEY } }),
    );
    await expectUsage(() => config.saveEmbedding({ kind: "endpoint", endpoint: "http://u:p@h/v1", model: "m" }));
    await expectUsage(() =>
      config.saveEmbedding({ kind: "endpoint", endpoint: "http://h/v1", model: "m", key: { env: KEY } }),
    );
    await expectUsage(() =>
      config.saveEmbedding({ kind: "endpoint", endpoint: "http://h/v1", model: "m", key: { pasted: " " } }),
    );
    await expectUsage(() => config.saveEmbedding({ kind: "connection", model: " " }));
    expect(fs.readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(storedCredential({ service: "embedding" })).toBeUndefined();
  });

  test("a model on the default connection needs a default connection", async () => {
    writeSandboxConfig({ bundles: { stash: { path: ctx.storage.stashDir, writable: true } }, defaultBundle: "stash" });
    resetConfigCache();
    await expectUsage(() => config.saveEmbedding({ kind: "connection", model: "m" }), "MISSING_REQUIRED_ARGUMENT");
  });
});
