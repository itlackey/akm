import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmSearch, parseScopeFilterFlags, parseSearchSource } from "../src/commands/read/search";
import { resetConfigCache, saveConfig } from "../src/core/config/config";
import { akmIndex } from "../src/indexer/indexer";
import { applyPrefer, type FusedCandidate, PREFER_WEIGHT, reciprocalRankFusion } from "../src/indexer/search/ranking";
import { writeMemory } from "./_helpers/assets";
import { runCliCapture } from "./_helpers/cli";
import {
  type Cleanup,
  makeSandboxDir,
  type SandboxedDir,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  sandboxXdgStateHome,
  withBundle,
} from "./_helpers/sandbox";

describe("search-from-multi", () => {
  /**
   * A repeated `--from` searches several named bundles as one set (#1460): ranked once, OR across the
   * bundles, `--filter` and the rest still AND on top. A single `--from` is unchanged.
   */

  let stashDir = "";
  let cleanup: Cleanup = () => {};
  const extras: Array<{ dir: string; cleanup: Cleanup }> = [];

  function writeNote(root: string, name: string, team: string): void {
    const file = path.join(root, "memories", `${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\nteam: ${team}\n---\n\nwidget ${name} note\n`, "utf8");
  }

  beforeEach(async () => {
    const dataResult = sandboxXdgDataHome();
    const cacheResult = sandboxXdgCacheHome(dataResult.cleanup);
    const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
    const stashResult = sandboxStashDir(cfgResult.cleanup);
    stashDir = stashResult.dir;
    cleanup = stashResult.cleanup;
    writeNote(stashDir, "home-note", "a");
    const bundles: Record<string, { path: string }> = {};
    for (const [name, team] of [
      ["one", "a"],
      ["two", "b"],
      ["three", "a"],
    ] as const) {
      const extra = makeSandboxDir(`akm-from-${name}`);
      extras.push(extra);
      writeNote(extra.dir, `${name}-note`, team);
      bundles[name] = { path: extra.dir };
    }
    saveConfig({ semanticSearchMode: "off", bundles });
    await akmIndex({ stashDir, full: true });
  });

  afterEach(() => {
    for (const extra of extras.splice(0)) extra.cleanup();
    cleanup();
  });

  const names = async (input: Partial<Parameters<typeof akmSearch>[0]>) =>
    (
      (await akmSearch({ query: "widget", skipLogging: true, ...input })).results.map((h) =>
        "name" in h ? h.name : "",
      ) as string[]
    ).sort();

  describe("repeated --from", () => {
    test("searches the union of the named bundles and reports them", async () => {
      const result = await akmSearch({ query: "widget", source: ["one", "two"], skipLogging: true });
      expect(result.results.map((h) => ("name" in h ? h.name : "")).sort()).toEqual(["one-note", "two-note"]);
      expect(result.bundles).toEqual(["one", "two"]);
    });

    test("a single --from is unchanged and reports no bundles", async () => {
      expect(await names({ source: "three" })).toEqual(["three-note"]);
      expect(await names({ source: ["three"] })).toEqual(["three-note"]);
      expect((await akmSearch({ query: "widget", source: "three", skipLogging: true })).bundles).toBeUndefined();
    });

    test("--filter still ANDs on top", async () => {
      expect(await names({ source: ["one", "two", "three"], filters: { team: ["a"] } })).toEqual([
        "one-note",
        "three-note",
      ]);
    });

    test("an unknown bundle name is rejected", async () => {
      await expect(akmSearch({ query: "widget", source: ["one", "nope"], skipLogging: true })).rejects.toThrow(
        /Unknown source name/,
      );
    });
  });

  describe("parseSearchSource with several values", () => {
    test("keeps bundle names, dedupes, and collapses one value", () => {
      expect(parseSearchSource(["a", "b", "a"])).toEqual(["a", "b"]);
      expect(parseSearchSource(["a", "a"])).toBe("a");
      expect(parseSearchSource([])).toBe("local");
    });

    test("a keyword cannot be mixed with bundle names", () => {
      expect(() => parseSearchSource(["local", "team"])).toThrow(/cannot be combined/);
      expect(() => parseSearchSource(["team", "all"])).toThrow(/cannot be combined/);
    });
  });
});

describe("search-source-filter", () => {
  /**
   * Regression test for `akm search --from <name>` leak bug.
   *
   * The FTS+vector index spans every configured source. Before this fix,
   * `akm search "query" --from library` would still return hits from
   * other sources because `searchDatabase` never filtered scored items by
   * the narrowed source list — the narrowing only affected graph-context
   * loading and the per-hit ref formatting.
   *
   * The fix gates a `restrictToSources` flag on the named-source code path
   * and drops scored items whose filePath does not live under any of the
   * provided sources.
   *
   * Migrated from per-test spawnSync("bun", [CLI, ...]) to the in-process
   * harness (tests/_helpers/cli.ts). Each runCli call re-pins the test's
   * isolated XDG/stash env and resets the config cache before driving the CLI
   * in-process, then restores in finally — so the indexed stash written by
   * akmIndex is read back faithfully without subprocess startup cost.
   */

  const disposers: SandboxedDir[] = [];

  function makeTempDir(prefix: string): string {
    const d = makeSandboxDir(prefix);
    disposers.push(d);
    return d.dir;
  }

  function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  let envCleanup: Cleanup = () => {};

  beforeEach(() => {
    // Fresh isolated XDG dirs + stash per test so the indexed DB / config live
    // in tempdirs. Chained so a single cleanup() undoes all of them.
    const cacheResult = sandboxXdgCacheHome();
    const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
    const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
    const stateResult = sandboxXdgStateHome(dataResult.cleanup);
    const stashResult = sandboxStashDir(stateResult.cleanup);
    envCleanup = stashResult.cleanup;
  });

  afterEach(() => {
    envCleanup();
    envCleanup = () => {};
    for (const d of disposers.splice(0)) d.cleanup();
  });

  /**
   * Drive the CLI in-process against a specific stash dir. Re-pins AKM_BUNDLE_DIR
   * for the call and resets the config cache so the run re-reads against the
   * narrowed stash, mirroring what the spawned subprocess got via its env.
   */
  async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
    return withBundle(stashDir, async () => {
      resetConfigCache();
      const res = await runCliCapture(args);
      return { stdout: res.stdout, stderr: res.stderr, status: res.code };
    });
  }

  describe("akm search --from <name> filters hits to that source", () => {
    test("named --from returns only hits whose files live under that source", async () => {
      const primary = makeTempDir("akm-src-filter-primary-");
      const library = makeTempDir("akm-src-filter-library-");
      for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
        fs.mkdirSync(path.join(primary, sub), { recursive: true });
        fs.mkdirSync(path.join(library, sub), { recursive: true });
      }

      // Both sources have a skill matching the query "shared-keyword".
      writeFile(
        path.join(primary, "skills", "primary-skill", "SKILL.md"),
        "---\ndescription: shared-keyword in the primary stash\ntags:\n  - shared-keyword\n---\n# Primary\n",
      );
      writeFile(
        path.join(library, "skills", "library-skill", "SKILL.md"),
        "---\ndescription: shared-keyword in the library stash\ntags:\n  - shared-keyword\n---\n# Library\n",
      );

      await withBundle(primary, async () => {
        saveConfig({
          semanticSearchMode: "off",
          bundles: {
            primary: { path: primary, writable: true },
            library: { path: library },
          },
          defaultBundle: "primary",
        });
        await akmIndex({ stashDir: primary, full: true });

        // Baseline: no --from filter. Both sources should contribute hits.
        const baseline = await runCli(["search", "shared-keyword", "--format=json"], primary);
        expect(baseline.status).toBe(0);
        const baselineHits = (JSON.parse(baseline.stdout).results as Array<{ name: string; ref: string }>) ?? [];
        const baselineNames = baselineHits.map((h) => h.name);
        expect(baselineNames).toContain("primary-skill");
        expect(baselineNames).toContain("library-skill");

        // Narrowed: --from library should ONLY return hits from the library
        // source. Before this fix, primary-skill would also appear because the
        // FTS index is global across sources and the search command did not
        // post-filter by the narrowed source list.
        const narrowed = await runCli(["search", "shared-keyword", "--from", "library", "--format=json"], primary);
        expect(narrowed.status).toBe(0);
        const narrowedHits = (JSON.parse(narrowed.stdout).results as Array<{ name: string; ref: string }>) ?? [];
        const narrowedNames = narrowedHits.map((h) => h.name);
        expect(narrowedNames).toContain("library-skill");
        expect(narrowedNames).not.toContain("primary-skill");

        // And vice versa — `--from primary` returns only the primary hit.
        // Regression for a related bug: `resolveSourceEntries` injects the primary
        // stash into `sources[0]` before iterating the config sources. The dedupe
        // loop used to skip the matching config entry, so the primary stash entry
        // never received its config name and `--from <primary-name>` matched
        // zero entries. addSource now enriches the existing entry with config
        // metadata when the path is already in the source list.
        const narrowedPrimary = await runCli(
          ["search", "shared-keyword", "--from", "primary", "--format=json"],
          primary,
        );
        expect(narrowedPrimary.status).toBe(0);
        const narrowedPrimaryHits =
          (JSON.parse(narrowedPrimary.stdout).results as Array<{ name: string; ref: string }>) ?? [];
        const narrowedPrimaryNames = narrowedPrimaryHits.map((h) => h.name);
        expect(narrowedPrimaryNames).toContain("primary-skill");
        expect(narrowedPrimaryNames).not.toContain("library-skill");
      });
    });
  });
});

describe("search-prefer", () => {
  /**
   * `--prefer`: a scope preference that boosts matching hits (×PREFER_WEIGHT on the fused score,
   * a stable reorder when browsing) and never drops or admits a hit.
   */

  describe("applyPrefer", () => {
    const ref = (id: number) => ({ id, itemRef: `stash//knowledge/n${id}` });
    const fused = reciprocalRankFusion([[ref(1), ref(2), ref(3), ref(4)], []]);

    test("multiplies only preferred scores by PREFER_WEIGHT and reorders", () => {
      const out = applyPrefer(fused, new Set(["stash//knowledge/n3"]));
      expect(out.map((c: FusedCandidate) => c.itemRef.slice(-2))).toEqual(["n1", "n3", "n2", "n4"]);
      expect(out[1]?.score).toBeCloseTo((fused[2]?.score as number) * PREFER_WEIGHT, 12);
      expect(out[0]?.score).toBe(fused[0]?.score as number);
    });

    test("an empty preferred set changes nothing", () => {
      expect(applyPrefer(fused, new Set())).toEqual(fused);
    });
  });

  const tempDirs: string[] = [];
  let envCleanup: Cleanup = () => {};

  beforeEach(() => {
    const cacheResult = sandboxXdgCacheHome();
    const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
    const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
    envCleanup = sandboxStashDir(dataResult.cleanup).cleanup;
  });

  afterEach(() => {
    envCleanup();
    envCleanup = () => {};
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Six memories that all match "gateway", ranked by how often they say it; each has its own scope. */
  async function indexStash(): Promise<string> {
    const stash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-search-prefer-"));
    tempDirs.push(stash);
    const scopes = [
      { scope_user: "u1", scope_channel: "ops" },
      { scope_user: "u2", scope_channel: "dev" },
      { scope_user: "u3", scope_channel: "ops" },
      { scope_user: "u4", scope_channel: "dev" },
      { scope_user: "u5", scope_channel: "ops" },
      { scope_user: "u6", scope_channel: "dev" },
    ];
    scopes.forEach((scope, i) => {
      writeMemory(stash, `m${i + 1}`, scope, `${"gateway ".repeat(6 - i)}${"filler ".repeat(i * 4)}`);
    });
    await withBundle(stash, async () => {
      resetConfigCache();
      saveConfig({ semanticSearchMode: "off" });
      await akmIndex({ stashDir: stash, full: true });
    });
    return stash;
  }

  async function names(stash: string, input: Partial<Parameters<typeof akmSearch>[0]>): Promise<string[]> {
    return withBundle(stash, async () => {
      resetConfigCache();
      const result = await akmSearch({ query: "gateway", ...input });
      return result.results.map((hit) => ("name" in hit ? String(hit.name) : ""));
    });
  }

  const prefer = (...tokens: string[]) => parseScopeFilterFlags(tokens, "--prefer");

  describe("akmSearch prefer", () => {
    test("without prefer the result is the plain ranking", async () => {
      const stash = await indexStash();
      expect(await names(stash, { prefer: undefined })).toEqual(await names(stash, {}));
    });

    test("a matching hit passes the hit above it and nothing is dropped", async () => {
      const stash = await indexStash();
      const base = await names(stash, {});
      expect(base).toHaveLength(6);
      const user = `u${Number(base[2]?.slice(1))}`;
      const boosted = await names(stash, { prefer: prefer(`user=${user}`) });
      expect(boosted).toEqual([base[0], base[2], base[1], ...base.slice(3)] as string[]);
    });

    test("a repeated key boosts any of its values", async () => {
      const stash = await indexStash();
      const base = await names(stash, {});
      const u = (i: number) => `user=u${Number(base[i]?.slice(1))}`;
      const boosted = await names(stash, { prefer: prefer(u(2), u(4)) });
      expect(boosted).toEqual([base[0], base[2], base[1], base[4], base[3], base[5]] as string[]);
    });

    test("different keys must all match", async () => {
      const stash = await indexStash();
      const base = await names(stash, {});
      const n = Number(base[2]?.slice(1));
      const channel = n % 2 === 1 ? "ops" : "dev";
      const other = channel === "ops" ? "dev" : "ops";
      const both = await names(stash, { prefer: prefer(`user=u${n}`, `channel=${channel}`) });
      expect(both[1]).toBe(base[2] as string);
      const mismatch = await names(stash, { prefer: prefer(`user=u${n}`, `channel=${other}`) });
      expect(mismatch).toEqual(base);
    });

    test("filter still limits, and prefer reorders only what filter leaves", async () => {
      const stash = await indexStash();
      const filters = parseScopeFilterFlags(["channel=ops"], "--filter");
      const base = await names(stash, { filters });
      expect(base).toHaveLength(3);
      const user = `u${Number(base[1]?.slice(1))}`;
      const boosted = await names(stash, { filters, prefer: prefer(`user=${user}`) });
      expect(boosted).toEqual([base[1], base[0], base[2]] as string[]);
    });

    test("browsing puts matches first and keeps the listing order otherwise", async () => {
      const stash = await indexStash();
      const base = await names(stash, { query: "" });
      expect(base).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
      const boosted = await names(stash, { query: "", prefer: prefer("user=u5", "user=u3") });
      expect(boosted).toEqual(["m3", "m5", "m1", "m2", "m4", "m6"]);
      const limited = await names(stash, { query: "", limit: 2, prefer: prefer("user=u6") });
      expect(limited).toEqual(["m6", "m1"]);
    });
  });
});

describe("search-include-proposed-cli", () => {
  /**
   * `akm search --include-proposed` CLI integration test (#284 GAP-HIGH 9).
   *
   * Drives the CLI against an indexed stash that contains both a
   * `quality: stable` and a `quality: proposed` skill, and asserts that:
   *   - default search excludes the proposed entry,
   *   - `--include-proposed` retains it in the hits list.
   *
   * Migrated from per-test spawnSync("bun", [CLI, ...]) to the in-process
   * harness (tests/_helpers/cli.ts). Each runCli call re-pins AKM_BUNDLE_DIR for
   * the indexed stash and resets the config cache before the in-process run,
   * restoring env in finally — so the freshly indexed stash is read back without
   * subprocess startup cost.
   */

  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  async function runCli(args: string[], stashDir: string): Promise<{ stdout: string; stderr: string; status: number }> {
    return withBundle(stashDir, async () => {
      resetConfigCache();
      const res = await runCliCapture(args);
      return { stdout: res.stdout, stderr: res.stderr, status: res.code };
    });
  }

  let envCleanup: Cleanup = () => {};

  beforeEach(() => {
    const cacheResult = sandboxXdgCacheHome();
    const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
    const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
    const stashResult = sandboxStashDir(dataResult.cleanup);
    envCleanup = stashResult.cleanup;
  });

  afterEach(() => {
    envCleanup();
    envCleanup = () => {};
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("akm search --include-proposed (CLI)", () => {
    test("default excludes proposed entries; --include-proposed keeps them", async () => {
      const stash = makeTempDir("akm-search-proposed-stash-");
      for (const sub of ["skills", "commands", "agents", "knowledge", "scripts"]) {
        fs.mkdirSync(path.join(stash, sub), { recursive: true });
      }

      // Curated entry
      writeFile(
        path.join(stash, "skills", "stable-deploy", "SKILL.md"),
        "---\ndescription: deploy widgets uniformly\ntags:\n  - deploy\nquality: curated\n---\n# Stable deploy\n",
      );
      // Proposed entry
      writeFile(
        path.join(stash, "skills", "proposed-deploy", "SKILL.md"),
        "---\ndescription: deploy widgets experimentally\ntags:\n  - deploy\nquality: proposed\n---\n# Proposed deploy\n",
      );

      await withBundle(stash, async () => {
        saveConfig({ semanticSearchMode: "off" });
        await akmIndex({ stashDir: stash, full: true });
      });

      const baseline = await runCli(["search", "deploy", "--format=json"], stash);
      expect(baseline.status).toBe(0);
      const baselineJson = JSON.parse(baseline.stdout);
      const baselineNames = (baselineJson.results as Array<{ name: string }>).map((h) => h.name);
      expect(baselineNames).toContain("stable-deploy");
      expect(baselineNames).not.toContain("proposed-deploy");

      const withProposed = await runCli(["search", "deploy", "--include-proposed", "--format=json"], stash);
      expect(withProposed.status).toBe(0);
      const withProposedJson = JSON.parse(withProposed.stdout);
      const withProposedNames = (withProposedJson.results as Array<{ name: string }>).map((h) => h.name);
      expect(withProposedNames).toContain("stable-deploy");
      expect(withProposedNames).toContain("proposed-deploy");
    });
  });
});

describe("search-memory-family", () => {
  /** Search returns one result per memory family: a `.derived` twin is dropped when its parent is a hit. */

  const tempDirs: string[] = [];
  let envCleanup: Cleanup = () => {};

  beforeEach(() => {
    const cacheResult = sandboxXdgCacheHome();
    const cfgResult = sandboxXdgConfigHome(cacheResult.cleanup);
    const dataResult = sandboxXdgDataHome(cfgResult.cleanup);
    envCleanup = sandboxStashDir(dataResult.cleanup).cleanup;
  });

  afterEach(() => {
    envCleanup();
    envCleanup = () => {};
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const twin = (parent: string) => ({ inferred: true, source: `memories/${parent}` });

  async function index(build: (stash: string) => void): Promise<string> {
    const stash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-search-family-"));
    tempDirs.push(stash);
    build(stash);
    await withBundle(stash, async () => {
      resetConfigCache();
      saveConfig({ semanticSearchMode: "off" });
      await akmIndex({ stashDir: stash, full: true });
    });
    return stash;
  }

  async function search(stash: string, input: Partial<Parameters<typeof akmSearch>[0]>) {
    return withBundle(stash, async () => {
      resetConfigCache();
      const result = await akmSearch({ query: "gateway", ...input });
      return result.results.map((hit) => ("name" in hit ? String(hit.name) : ""));
    });
  }

  describe("akmSearch memory families", () => {
    test("parent and twin both match: only the parent, and the freed slot backfills", async () => {
      const stash = await index((s) => {
        writeMemory(s, "alpha", {}, "gateway gateway gateway timeout notes");
        writeMemory(s, "alpha.derived", twin("alpha"), "gateway gateway lesson about timeouts");
        writeMemory(s, "beta", {}, "gateway retry notes");
        writeMemory(s, "gamma", {}, "gateway auth notes");
      });
      const all = await search(stash, { limit: 10 });
      expect(all).not.toContain("alpha.derived");
      expect(all).toContain("alpha");
      expect(all).toHaveLength(3);
      const two = await search(stash, { limit: 2 });
      expect(two).toHaveLength(2);
      expect(two).not.toContain("alpha.derived");
    });

    test("a parent ranked below its twin takes the twin's place and keeps expandTo", async () => {
      const stash = await index((s) => {
        writeMemory(s, "alpha", {}, `gateway ${"filler ".repeat(40)}`);
        writeMemory(s, "alpha.derived", twin("alpha"), "gateway gateway gateway gateway");
        writeMemory(s, "beta", {}, "gateway gateway gateway");
        writeMemory(s, "gamma", {}, "gateway gateway");
      });
      const hits = await withBundle(stash, async () => {
        resetConfigCache();
        return (await akmSearch({ query: "gateway", limit: 10 })).results as Array<{ name: string; expandTo?: string }>;
      });
      expect(hits.map((h) => h.name)).toEqual(["beta", "alpha", "gamma"]);
      expect(hits[1]?.expandTo).toContain("alpha.derived");
    });

    test("two twins of one parent do not collapse into each other while the parent is not a hit", async () => {
      const stash = await index((s) => {
        writeMemory(s, "alpha", {}, "unrelated words only");
        writeMemory(s, "alpha.derived", twin("alpha"), "gateway gateway current lesson");
        writeMemory(s, "alpha-old.derived", twin("alpha"), "gateway old lesson");
      });
      expect(await search(stash, {})).toEqual(["alpha.derived", "alpha-old.derived"]);
    });

    test("an explicit belief all asks for every record: parent and twin both returned", async () => {
      const stash = await index((s) => {
        writeMemory(s, "alpha", {}, "gateway gateway notes");
        writeMemory(s, "alpha.derived", twin("alpha"), "gateway lesson");
      });
      expect((await search(stash, { belief: "all" })).sort()).toEqual(["alpha", "alpha.derived"]);
    });

    test("twin alone matching is kept", async () => {
      const stash = await index((s) => {
        writeMemory(s, "alpha", {}, "unrelated words only");
        writeMemory(s, "alpha.derived", twin("alpha"), "gateway lesson about timeouts");
      });
      expect(await search(stash, {})).toEqual(["alpha.derived"]);
    });
  });
});
