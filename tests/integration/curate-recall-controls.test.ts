// Integration: opens real indexes and spawns the CLI to verify recall and public API parity.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type CurateOptions as ApiOptions, curate } from "../../src/api";
import { akmCurate, packCuratedHits } from "../../src/commands/read/curate";
import { akmSearch } from "../../src/commands/read/search";
import { akmShowUnified } from "../../src/commands/read/show";
import { saveConfig } from "../../src/core/config/config";
import { akmIndex } from "../../src/indexer/indexer";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, withMockedFetch } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
const CLI = path.resolve(import.meta.dir, "../../src/cli.ts");
function put(ref: string, fields: Record<string, unknown> = {}, body = "quartz deployment procedure", root?: string) {
  const file = path.join(root ?? storage.stashDir, `${ref}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `---\n${Object.entries({ description: body, ...fields })
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n")}\n---\n\n${body}\n`,
  );
  return file;
}
function cli(flags: string[] = [], query = "quartz deployment") {
  return spawnSync("bun", [CLI, "-q", "--detail", "agent", "curate", query, ...flags], {
    encoding: "utf8",
    env: { ...process.env },
  });
}
beforeEach(() => {
  storage = withIsolatedAkmStorage();
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir } },
    defaultBundle: "stash",
    registries: [],
  });
});
afterEach(() => storage.cleanup());
const states = ["active", "asserted", "superseded", "contradicted", "deprecated", "archived"] as const;
const historical = states.filter((x) => x !== "active" && x !== "asserted");
async function seed() {
  for (const state of states) put(`memories/${state}`, { beliefState: state }, `quartz deployment ${state}`);
  put("knowledge/unflagged", {}, "quartz deployment ordinary reference");
  put("memories/superseded.derived", { source: "memories/superseded" }, "quartz deployment derived old twin");
  await akmIndex({ stashDir: storage.stashDir, full: true });
}
function refs(result: Awaited<ReturnType<typeof akmCurate>>) {
  return result.items.map((x) => ("ref" in x ? x.ref : x.id)).sort();
}
for (const belief of [undefined, "current", "all", "historical"] as const) {
  test(`CLI/internal/API belief ${belief ?? "default"} and packed evidence`, async () => {
    await seed();
    const options = { belief, limit: 20 };
    const expected =
      belief === "all"
        ? [...states.map((x) => `memories/${x}`), "knowledge/unflagged", "memories/superseded.derived"]
        : belief === "historical"
          ? [...historical.map((x) => `memories/${x}`), "memories/superseded.derived"]
          : ["memories/active", "memories/asserted", "knowledge/unflagged"];
    const result = await akmCurate({ query: "quartz deployment", ...options });
    expect(refs(result)).toEqual(expected.sort());
    const flags = ["--limit", "20", ...(belief ? ["--belief", belief] : [])];
    const out = cli(flags);
    expect(out.status).toBe(0);
    expect(await curate("quartz deployment", options)).toBe(out.stdout);
    const packed = await packCuratedHits(result, 4000);
    expect(packed.items.map((x) => x.ref).sort()).toEqual(expected.sort());
    for (const item of packed.items.filter((x) => historical.includes(x.beliefState as (typeof historical)[number]))) {
      expect(item.reason).toContain("Historical context");
    }
    if (belief === "historical" || belief === "all") {
      for (const item of result.items.filter(
        (x) => "beliefState" in x && historical.includes(x.beliefState as (typeof historical)[number]),
      ))
        expect(item.reason).toContain("Historical context");
    }
  });
}
for (const key of ["user", "agent", "run", "channel"] as const) {
  test(`scope ${key} narrows selection, support and packing with CLI/API parity`, async () => {
    put(
      "knowledge/match",
      { scope: { [key]: "alice" }, xrefs: ["knowledge/wrong", "knowledge/support"] },
      "quartz deployment selected\n\n[wrong](stash//knowledge/wrong)\n[good](stash//knowledge/support)",
    );
    put("knowledge/wrong", { scope: { [key]: "bob" } }, "quartz deployment wrong scope");
    put("knowledge/support", { scope: { [key]: "alice" } }, "supplemental context only");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const result = await akmCurate({ query: "quartz deployment selected", filters: { [key]: "alice" }, limit: 1 });
    expect(refs(result)).toEqual(["knowledge/match"]);
    expect(JSON.stringify(result)).not.toContain('"ref":"knowledge/wrong"');
    expect(
      result.items[0] && "supportRefs" in result.items[0] ? result.items[0].supportRefs?.map((x) => x.ref) : [],
    ).toEqual(["knowledge/support"]);
    expect((await packCuratedHits(result, 4000)).items.map((x) => x.ref)).toEqual(["knowledge/match"]);
    expect(await curate("quartz deployment", { filters: { [key]: "alice" } })).toBe(
      cli(["--filter", `${key}=alice`]).stdout,
    );
    expect(refs(await akmCurate({ query: "quartz deployment", filters: { [key]: "nobody" } }))).toEqual([]);
  });
}
test("compound scope, source/type combinations and duplicate source identities", async () => {
  const other = path.join(storage.root, "other");
  const scope = { user: "alice", agent: "worker", run: "r2", channel: "ops" };
  put("memories/same", { scope }, "quartz deployment default source wrong answer");
  put(
    "memories/same",
    { scope, xrefs: ["stash//knowledge/external", "other//knowledge/reference"] },
    "quartz deployment selected source exact answer",
    other,
  );
  put("knowledge/external", { scope }, "external source only support");
  put("knowledge/reference", { scope }, "quartz deployment reference", other);
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir }, other: { path: other } },
    defaultBundle: "stash",
    registries: [],
  });
  await akmIndex({ stashDir: storage.stashDir, full: true });
  for (const type of ["memory", "knowledge", "any"]) {
    const opts = { filters: scope, source: "other", type };
    const result = await akmCurate({ query: "quartz deployment", ...opts });
    const packed = await packCuratedHits(result, 4000);
    expect(JSON.stringify(result.items)).not.toContain('"ref":"knowledge/external"');
    if (type === "memory") {
      const item = result.items[0];
      expect(item && "supportRefs" in item ? item.supportRefs : undefined).toBeUndefined();
    }
    expect(JSON.stringify(packed)).not.toContain("default source wrong answer");
    expect(packed.items.length).toBe(type === "any" ? 2 : 1);
    const out = cli([
      "--from",
      "other",
      "--type",
      type,
      ...Object.entries(scope).flatMap(([k, v]) => ["--filter", `${k}=${v}`]),
    ]);
    expect(out.status).toBe(0);
    expect(await curate("quartz deployment", opts)).toBe(out.stdout);
  }
});
test("stale outgoing/incoming links are filtered in current; all labels historical context", async () => {
  put(
    "knowledge/main",
    { xrefs: ["memories/old", "knowledge/support"] },
    "quartz deployment selected\n\n[old](stash//memories/old)\n[good](stash//knowledge/support)",
  );
  put("knowledge/support", {}, "extra supporting explanation");
  put("memories/old", { beliefState: "superseded" }, "historical record\n[main](stash//knowledge/main)");
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const current = await akmCurate({ query: "quartz deployment selected", limit: 1 });
  expect(JSON.stringify(current.items[0])).not.toContain('"ref":"memories/old"');
  const all = await akmCurate({ query: "quartz deployment selected", limit: 1, belief: "all" });
  const support = all.items[0] && "supportRefs" in all.items[0] ? all.items[0].supportRefs : [];
  expect(support?.find((x) => x.ref === "memories/old")?.reason).toContain("Historical context");
  expect((await akmShowUnified({ ref: "memories/old" })).content).toContain("historical record");
});
test("packing rechecks changed scope/belief and missing content instead of widening", async () => {
  const file = put("knowledge/main", { scope: { user: "alice" } });
  await akmIndex({ stashDir: storage.stashDir, full: true });
  const result = await akmCurate({ query: "quartz deployment", filters: { user: "alice" } });
  expect(result.items).toHaveLength(1);
  put("knowledge/main", { scope: { user: "bob" } });
  expect((await packCuratedHits(result, 4000)).items).toEqual([]);
  put("knowledge/main"); // Removing the scope must not retain its old indexed value.
  expect((await packCuratedHits(result, 4000)).items).toEqual([]);
  put("knowledge/main", { scope: { user: "alice" }, beliefState: "superseded" });
  expect((await packCuratedHits(result, 4000)).items).toEqual([]);
  fs.rmSync(file);
  expect((await packCuratedHits(result, 4000)).items).toEqual([]);
});
for (const enabled of [false, true]) {
  test(`reranking ${enabled}: only eligible candidates and derived surfaces reach reranker`, async () => {
    const scope = { user: "alice" };
    put("memories/base", { scope }, "quartz deployment eligible parent");
    put("memories/base.derived", { source: "memories/base", scope: { user: "bob" } }, "POISON-DERIVED-SURFACE");
    put("knowledge/other", { scope }, "quartz deployment eligible second");
    put("memories/old", { scope, beliefState: "deprecated" }, "quartz deployment POISON-HISTORICAL");
    saveConfig({
      semanticSearchMode: "off",
      bundles: { stash: { path: storage.stashDir } },
      defaultBundle: "stash",
      registries: [],
      search: { curateRerank: { enabled, endpoint: "http://localhost:9/rerank" } },
    });
    await akmIndex({ stashDir: storage.stashDir, full: true });
    let documents: string[] = [];
    const result = await withMockedFetch(async () => akmCurate({ query: "quartz deployment", filters: scope }), (async (
      _url: unknown,
      init: RequestInit,
    ) => {
      documents = JSON.parse(String(init.body)).documents;
      return new Response(
        JSON.stringify({ results: documents.map((_, index) => ({ index, relevance_score: index })) }),
      );
    }) as typeof fetch);
    expect(result.items).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("POISON");
    expect(documents.join(" ")).not.toContain("POISON");
    expect(documents.length).toBe(enabled ? 2 : 0);
  });
}
for (const [flags, opts] of [
  [["--belief", "invalid"], { belief: "invalid" }],
  [["--filter", "project=bad"], { filters: { project: "bad" } }],
  [["--filter", "user="], { filters: { user: "" } }],
  [["--from", "missing"], { source: "missing" }],
] as const) {
  test(`invalid controls: ${flags.join(" ")}`, async () => {
    put("knowledge/main");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const out = cli([...flags]);
    expect(out.status).toBe(2);
    const err = await curate("quartz deployment", opts as ApiOptions).catch((e: Error & { code: string }) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(JSON.parse(out.stderr).error);
  });
}
test("missing configured source gives empty evidence, not another bundle", async () => {
  put("knowledge/main");
  saveConfig({
    semanticSearchMode: "off",
    bundles: { stash: { path: storage.stashDir }, missing: { path: path.join(storage.root, "absent") } },
    defaultBundle: "stash",
    registries: [],
  });
  await akmIndex({ stashDir: storage.stashDir, full: true });
  expect(refs(await akmCurate({ query: "quartz deployment", source: "missing" }))).toEqual([]);
});

test("search default current, explicit all/historical, browse and prefix share the policy", async () => {
  await seed();
  for (const query of ["quartz deployment", "", "memories/"]) {
    const defaultResult = await akmSearch({ query, limit: 20 });
    const current = await akmSearch({ query, limit: 20, belief: "current" });
    expect(defaultResult.hits.map((x) => ("ref" in x ? x.ref : x.id))).toEqual(
      current.hits.map((x) => ("ref" in x ? x.ref : x.id)),
    );
    expect(
      defaultResult.hits.some(
        (x) => "beliefState" in x && historical.includes(x.beliefState as (typeof historical)[number]),
      ),
    ).toBe(false);
    expect((await akmSearch({ query, limit: 20, belief: "all" })).hits.length).toBeGreaterThan(current.hits.length);
    expect(
      (await akmSearch({ query, limit: 20, belief: "historical" })).hits.every(
        (x) => "beliefState" in x && historical.includes(x.beliefState as (typeof historical)[number]),
      ),
    ).toBe(true);
  }
});

test("registry/all source and free-form type controls keep CLI/API parity without local widening", async () => {
  put("knowledge/main", { scope: { user: "alice" } });
  await akmIndex({ stashDir: storage.stashDir, full: true });
  for (const source of ["registry", "all"]) {
    for (const type of ["knowledge", "unknown-adapter-type"]) {
      const options = { source, type, filters: { user: "alice" } };
      const out = cli(["--from", source, "--type", type, "--filter", "user=alice"]);
      expect(out.status).toBe(0);
      expect(await curate("quartz deployment", options)).toBe(out.stdout);
      const items = JSON.parse(out.stdout).items;
      expect(items.length).toBe(source === "all" && type === "knowledge" ? 1 : 0);
    }
  }
});
