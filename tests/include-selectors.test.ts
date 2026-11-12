// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { curate } from "../src/api";
import { akmCurate } from "../src/commands/read/curate";
import { akmSearch } from "../src/commands/read/search";
import { loadConfig, resetConfigCache, saveConfig } from "../src/core/config/config";
import { dropUnusableProjects } from "../src/core/config/schema/projects";
import { normalizeInclude } from "../src/core/include";
import { akmIndex } from "../src/indexer/indexer";
import { projectOverview, search as workspaceSearch } from "../src/workspace/assets";
import { runCliCapture } from "./_helpers/cli";
import { withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

let iso: ReturnType<typeof withIsolatedAkmStorage>;
const QUERY = "widgetflux";
const names = (result: Awaited<ReturnType<typeof akmSearch>>) => result.hits.map((hit) => hit.name).sort();

beforeEach(async () => {
  iso = withIsolatedAkmStorage();
  const assets = [
    ["knowledge/live.md", "curated", "alpha"],
    ["knowledge/draft.md", "proposed", "alpha"],
    ["knowledge/other.md", "proposed", "other"],
    ["knowledge/unrelated.md", "proposed", "alpha"],
    ["sessions/claude/capture.md", "curated", "alpha"],
    ["sessions/claude/draft-capture.md", "proposed", "alpha"],
    ["memories/hidden.md", "curated", "alpha"],
  ];
  for (const [file, quality, project] of assets) {
    const dest = path.join(iso.stashDir, file!);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const token = file!.includes("unrelated") ? "unrelatedquux" : QUERY;
    fs.writeFileSync(
      dest,
      `---\ndescription: Configure ${token} proxy deployment ${file}\nquality: ${quality}\nproject: ${project}\n---\nConfigure ${token} proxy deployment ${file}.\n`,
    );
  }
  writeSandboxConfig({
    semanticSearchMode: "off",
    search: { defaultExcludeTypes: ["session", "memory"] },
    projects: {
      alpha: {
        paths: [iso.stashDir],
        filters: { project: "alpha" },
        include: { quality: "proposed", type: "session" },
      },
      empty: { include: {} },
    },
  });
  await akmIndex({ stashDir: iso.stashDir, full: true });
});

afterEach(() => iso.cleanup());

test("includes relax only the named default exclusions on scored and browse paths", async () => {
  for (const query of [QUERY, ""]) {
    const baseline = names(await akmSearch({ query }));
    expect(baseline).toEqual(["live"]);
    const quality = names(await akmSearch({ query, include: { quality: "proposed" } }));
    expect(quality).toContain("draft");
    expect(quality).not.toContain("claude/capture");
    expect(quality).not.toContain("hidden");
    const sessions = await akmSearch({ query, include: { type: "session" } });
    expect(sessions.hits.some((hit) => hit.type === "session")).toBe(true);
    expect(names(sessions)).not.toContain("hidden");
    expect(names(sessions)).not.toContain("draft");
    expect(sessions.hits.filter((hit) => hit.type === "session")).toHaveLength(1);
    const both = await akmSearch({ query, include: { quality: "proposed", type: "session" } });
    expect(both.hits.filter((hit) => hit.type === "session")).toHaveLength(2);
    const legacy = await akmSearch({ query, include: { quality: "proposed" }, includeSessions: true });
    expect(names(legacy)).toContain("hidden");
  }
});

test("includes preserve explicit type, filters, source boundaries and query matching", async () => {
  const include = { quality: "proposed" as const, type: ["session", "memory"] };
  const result = await akmSearch({ query: QUERY, include, filters: { project: "alpha" }, type: "knowledge" });
  expect(names(result)).toEqual(["draft", "live"]);
  await expect(akmSearch({ query: QUERY, source: "missing-bundle", include })).rejects.toThrow();
  const curated = await akmCurate({
    query: QUERY,
    include,
    filters: { project: "alpha" },
    type: "knowledge",
    limit: 20,
  });
  expect(curated.items.map((hit) => hit.name).sort()).toEqual(["draft", "live"]);
});

test("CLI search and curate parse repeated selectors and retain selected project filters", async () => {
  for (const verb of ["search", "curate"]) {
    const result = await runCliCapture([
      verb,
      QUERY,
      "--project",
      "alpha",
      "--include",
      "quality=proposed",
      "--include",
      "type=memory",
      "--limit",
      "20",
      "--format",
      "json",
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const hits = parsed.hits ?? parsed.items;
    expect(hits.map((hit: { name: string }) => hit.name).sort()).toEqual(["draft", "hidden", "live"]);
    expect(parsed.project.include).toEqual({ quality: ["proposed"], type: ["memory"] });
    expect(parsed.project.filters).toEqual({ project: "alpha" });
  }
}, 20_000);

test("API and workspace inherit project includes, replace a kind whole, and preserve empty overrides", async () => {
  const inherited = JSON.parse(await curate(QUERY, { project: "alpha", limit: 20 }));
  expect(inherited.items.some((hit: { name: string }) => hit.name === "draft")).toBe(true);
  expect(inherited.items.some((hit: { type: string }) => hit.type === "session")).toBe(true);
  expect(inherited.items.some((hit: { name: string }) => hit.name === "other")).toBe(false);
  const cleared = JSON.parse(await curate(QUERY, { project: "alpha", include: {}, limit: 20 }));
  expect(cleared.items.map((hit: { name: string }) => hit.name)).toEqual(["live"]);
  expect(cleared.project.include).toEqual({});
  const replaced = JSON.parse(await curate(QUERY, { project: "alpha", include: { quality: "proposed" }, limit: 20 }));
  expect(replaced.items.map((hit: { name: string }) => hit.name).sort()).toEqual(["draft", "live"]);
  expect(JSON.parse(await curate(QUERY, { cwd: iso.stashDir, limit: 20 })).project.name).toBe("alpha");
  expect(names(await workspaceSearch({ q: QUERY, project: "alpha", include: {} }))).toEqual(["live"]);
  expect(names(await workspaceSearch({ q: QUERY, project: "alpha" }))).toContain("draft");
  expect(
    projectOverview({ project: "alpha" }).bundles.flatMap((bundle) => Object.keys(bundle.eligible?.byType ?? {})),
  ).toContain("session");
});

test("malformed include values fail strictly and config warns without dropping project filters", async () => {
  for (const include of [{ quality: "curated" }, { type: "" }, { project: "other" }, { type: [] }]) {
    expect(() => normalizeInclude(include as never)).toThrow("Invalid --include");
    await expect(curate(QUERY, { include: include as never })).rejects.toThrow("Invalid --include");
  }
  const warnings: string[] = [];
  const raw = dropUnusableProjects(
    { projects: { alpha: { include: { quality: "curated" }, filters: { project: "alpha" } } } },
    undefined,
    (_key, message) => warnings.push(message),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("projects.alpha.include");
  expect(raw.projects).toEqual({ alpha: { filters: { project: "alpha" } } });
  for (const verb of ["search", "curate"]) {
    for (const include of ["quality=curated", "type=bogus", "color=red"]) {
      const bad = await runCliCapture([verb, QUERY, "--include", include, "--format", "json"]);
      expect(bad.code, include).toBe(2);
      const error = JSON.parse(bad.stderr.trim());
      expect(error.hint).toContain("quality=proposed, type=<");
      expect(error.hint).toContain("session");
    }
  }
  expect(() => normalizeInclude({ type: "bogus" } as never)).toThrow("Unsupported --include type value");
  resetConfigCache();
  expect(loadConfig().projects?.empty?.include).toEqual({});
}, 20_000);

test("include never bypasses a selected named source", async () => {
  const foreign = path.join(iso.stashDir, "..", "foreign");
  fs.mkdirSync(path.join(foreign, "knowledge"), { recursive: true });
  fs.writeFileSync(
    path.join(foreign, "knowledge", "foreign.md"),
    `---\ndescription: ${QUERY} foreign deployment\nquality: proposed\n---\nForeign ${QUERY} deployment instructions.\n`,
  );
  writeSandboxConfig({
    semanticSearchMode: "off",
    defaultBundle: "stash",
    bundles: { stash: { path: iso.stashDir }, foreign: { path: foreign } },
  });
  resetConfigCache();
  await akmIndex({ stashDir: iso.stashDir, full: true });
  const include = { quality: "proposed" as const, type: "session" };
  expect(names(await akmSearch({ query: QUERY, include }))).toContain("foreign");
  expect(names(await akmSearch({ query: QUERY, source: "stash", include }))).not.toContain("foreign");
});

test("project includes preserve unknown config keys across writes without passing them into retrieval", async () => {
  const config = loadConfig();
  saveConfig({
    ...config,
    projects: {
      ...config.projects,
      alpha: {
        ...config.projects?.alpha,
        include: { quality: "proposed", futureOption: { enabled: true } },
      },
    },
  });
  resetConfigCache();
  const loaded = loadConfig();
  expect(loaded.projects?.alpha?.include).toEqual({ quality: "proposed", futureOption: { enabled: true } });
  saveConfig(loaded);
  resetConfigCache();
  expect(loadConfig().projects?.alpha?.include).toEqual({ quality: "proposed", futureOption: { enabled: true } });
  const result = JSON.parse(await curate(QUERY, { project: "alpha", limit: 20 }));
  expect(result.items.map((hit: { name: string }) => hit.name).sort()).toEqual(["draft", "live"]);
  expect(result.project.include).toEqual({ quality: "proposed" });
});

test("type= accepts a custom type the config excludes by default, and still rejects an unconfigured one", () => {
  writeSandboxConfig({ semanticSearchMode: "off", search: { defaultExcludeTypes: ["session", "runbook"] } });
  expect(normalizeInclude({ type: "runbook" })).toEqual({ type: "runbook" });
  expect(normalizeInclude({ type: ["session", "runbook"] })).toEqual({ type: ["session", "runbook"] });
  expect(() => normalizeInclude({ type: "bogus" } as never)).toThrow("Unsupported --include type value");
  try {
    normalizeInclude({ type: "bogus" } as never);
  } catch (error) {
    expect((error as { hint(): string }).hint()).toContain("runbook");
  }
});
