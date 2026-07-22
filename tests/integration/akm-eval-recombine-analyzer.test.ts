import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeRecombineCandidates,
  isRecombineJunkEntity,
  isRecombineJunkTag,
  type RecombineAnalyzerEntry,
  readCurrentRecombineEntries,
} from "../../scripts/akm-eval/src/recombine-analyzer";
import { resolveDataDir } from "../../scripts/akm-eval/src/sources/paths";
import fixture from "../fixtures/akm-eval/recombine-analyzer.json";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const WRAPPER = path.join(REPO_ROOT, "scripts", "akm-eval", "bin", "akm-eval-recombine-analyze");
const cleanups: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-eval-recombine-"));
  cleanups.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function analyzerFixture(): RecombineAnalyzerEntry[] {
  return structuredClone(fixture.entries) as RecombineAnalyzerEntry[];
}

function digestTree(root: string): Array<{ path: string; size: number; mtimeMs: number; sha256: string }> {
  const rows: Array<{ path: string; size: number; mtimeMs: number; sha256: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const stat = fs.statSync(absolute);
      rows.push({
        path: path.relative(root, absolute),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"),
      });
    }
  };
  walk(root);
  return rows;
}

function makeEntry(
  id: number,
  ref: string,
  tags: string[],
  entities: string[],
  overrides: Partial<RecombineAnalyzerEntry> = {},
): RecombineAnalyzerEntry {
  const name = ref.split("//memories/")[1] ?? ref;
  return {
    id,
    ref,
    bundle: ref.split("//")[0] ?? "fixture",
    sourceRoot: "/fixture/cap",
    name,
    tags,
    entities,
    provenance: {
      xrefs: [],
      sources: [],
      sourceRefs: [`sessions/opencode/source-${id}`],
      evidenceSources: [],
    },
    project: name.split("/")[0],
    fileSize: 1000,
    ...overrides,
  };
}

interface FixtureProvenance {
  xrefs?: string[];
  sources?: string[];
  sourceRefs?: string[];
  evidenceSources?: string[];
}

function withProvenance(entry: RecombineAnalyzerEntry, provenance: FixtureProvenance): RecombineAnalyzerEntry {
  return {
    ...entry,
    provenance: {
      xrefs: provenance.xrefs ?? [],
      sources: provenance.sources ?? [],
      sourceRefs: provenance.sourceRefs ?? [],
      evidenceSources: provenance.evidenceSources ?? [],
    },
  };
}

describe("akm-eval recombine analyzer deterministic fixture", () => {
  test("isolates bundle/source scopes, clusters tags/entities, and filters junk and telemetry", () => {
    const report = analyzeRecombineCandidates(analyzerFixture(), {
      minClusterSize: 3,
      maxClusterSize: 4,
      maxClusters: 20,
      relatedness: "both",
    });

    expect(report.summary.excludedSessionTelemetry).toBe(1);
    expect(report.summary.excludedDerived).toBe(1);
    expect(report.clusters.some((cluster) => cluster.signature === "tag:20260722")).toBe(false);
    expect(report.clusters.some((cluster) => cluster.signature === "tag:the")).toBe(false);
    expect(report.clusters.some((cluster) => cluster.signature === "entity:session_checkpoint")).toBe(false);
    expect(report.clusters.some((cluster) => cluster.signature.includes("/srv/private"))).toBe(false);
    expect(report.clusters.some((cluster) => cluster.signature === "tag:tiny")).toBe(false);
    expect(report.clusters.some((cluster) => cluster.signature === "tag:broad")).toBe(false);

    const isolated = report.clusters.filter((cluster) => cluster.signature === "tag:isolated");
    expect(isolated).toHaveLength(2);
    expect(isolated.map((cluster) => cluster.scope.bundle)).toEqual(["community", "team"]);
    expect(isolated.map((cluster) => cluster.memberRefs.length)).toEqual([3, 3]);
    expect(isolated.flatMap((cluster) => cluster.memberRefs).some((ref) => ref.includes("foreign-"))).toBe(false);
    expect(new Set(isolated.map((cluster) => cluster.scope.sourceFingerprint)).size).toBe(2);

    const signatures = report.clusters.map((cluster) => cluster.signature);
    expect(signatures).toContain("entity:guardian");
    expect(signatures).toContain("tag:auth");
    expect(signatures).not.toContain("tag:common");
    expect(report.clusters.flatMap((cluster) => cluster.memberRefs)).toContain("team//memories/project-a/auth-a");
    expect(report.clusters.flatMap((cluster) => cluster.memberRefs).every((ref) => ref.includes("//memories/"))).toBe(
      true,
    );
  });

  test("reports member-supported recurrence, diversity, risk, and LLM estimates without body content", () => {
    const report = analyzeRecombineCandidates(analyzerFixture(), {
      minClusterSize: 3,
      maxClusterSize: 4,
      maxClusters: 20,
      relatedness: "both",
    });
    const auth = report.clusters.find((cluster) => cluster.signature === "tag:auth");
    const concentrated = report.clusters.find(
      (cluster) => cluster.signature === "tag:isolated" && cluster.scope.bundle === "community",
    );

    expect(auth?.recurrence.observationCount).toBe(4);
    expect(auth?.recurrence.supportingMemberCount).toBe(4);
    expect(auth?.recurrence.supportingMemberCoverage).toBe(1);
    expect(auth?.diversity.sourceContextCount).toBe(3);
    expect(auth?.diversity.projectCount).toBe(3);
    expect(auth?.recurrence.independentContextCount).toBe(3);
    expect(auth?.generalizabilityRisk.concretePathSignals).toBeGreaterThan(0);
    expect(auth?.generalizabilityRisk.concreteIdentifierSignals).toBeGreaterThan(0);
    expect(concentrated?.diversity.projectConcentration).toBe(1);
    expect(concentrated?.generalizabilityRisk.signals).toContain("single-project-concentration");
    expect(concentrated?.generalizabilityRisk.signals).toContain("insufficient-source-diversity");

    expect(report.estimatedLlm.estimatedCalls).toBe(report.summary.selectedClusterCount);
    expect(report.estimatedLlm.selectedClusterCap).toBe(20);
    expect(report.estimatedLlm.estimatedTotalTokens).toBeGreaterThan(0);
    expect(JSON.stringify(report.estimatedLlm)).not.toContain("UpperBound");
    expect(report.decision.reason.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain("body content");
  });

  test("one member with many provenance identifiers does not fake recurrence or source diversity", () => {
    const entries = [
      withProvenance(makeEntry(1, "team//memories/a/one", ["recurrence"], [], { project: undefined }), {
        xrefs: ["sessions/opencode/one", "team//sessions/opencode/one"],
        sources: ["https://private.example/source"],
        sourceRefs: ["knowledge/source-a", "team//knowledge/source-b"],
        evidenceSources: ["team//facts/evidence-a"],
      }),
      withProvenance(makeEntry(2, "team//memories/b/two", ["recurrence"], [], { project: undefined }), {}),
      withProvenance(makeEntry(3, "team//memories/c/three", ["recurrence"], [], { project: undefined }), {}),
    ];

    const cluster = analyzeRecombineCandidates(entries, { minClusterSize: 3, maxClusters: 1 }).clusters[0];

    expect(cluster?.recurrence.supportingMemberCount).toBe(1);
    expect(cluster?.recurrence.supportingMemberCoverage).toBeCloseTo(1 / 3);
    expect(cluster?.recurrence.independentContextCount).toBeNull();
    expect(cluster?.recurrence.strength).toBe("unknown");
    expect(cluster?.diversity.sourceContextCount).toBeNull();
    expect(cluster?.diversity.provenanceCoverage).toEqual({
      xrefs: 1 / 3,
      sources: 0,
      sourceRefs: 1 / 3,
      evidenceSources: 1 / 3,
    });
    expect(cluster?.generalizabilityRisk.level).toBe("unknown");
    expect(cluster?.generalizabilityRisk.signals).toContain("generalizability-evidence-unknown");
    expect(JSON.stringify(cluster)).not.toContain("private.example");
  });

  test("associative xrefs are linkage-only and cannot drive recurrence or observe decisions", () => {
    const entries = [1, 2, 3].map((id) =>
      withProvenance(makeEntry(id, `team//memories/p-${id}/member-${id}`, ["recurrence"], [], { project: undefined }), {
        xrefs: [`sessions/opencode/session-${id}`],
      }),
    );

    const report = analyzeRecombineCandidates(entries, { minClusterSize: 3, maxClusters: 1 });
    const cluster = report.clusters[0];

    expect(cluster?.diversity.provenanceCoverage.xrefs).toBe(1);
    expect(cluster?.recurrence.supportingMemberCount).toBe(0);
    expect(cluster?.recurrence.supportingMemberCoverage).toBe(0);
    expect(cluster?.recurrence.independentContextCount).toBeNull();
    expect(cluster?.recurrence.strength).toBe("unknown");
    expect(cluster?.diversity.sourceContextCount).toBeNull();
    expect(report.decision.observePassWorthwhile).toBe(false);
  });

  test("typed source refs from independently supporting members can drive recurrence", () => {
    const entries = [1, 2, 3].map((id) =>
      withProvenance(makeEntry(id, `team//memories/p-${id}/member-${id}`, ["recurrence"], [], { project: undefined }), {
        sourceRefs: [`sessions/opencode/session-${id}`],
      }),
    );

    const report = analyzeRecombineCandidates(entries, { minClusterSize: 3, maxClusters: 1 });
    const cluster = report.clusters[0];

    expect(cluster?.recurrence.supportingMemberCount).toBe(3);
    expect(cluster?.recurrence.supportingMemberCoverage).toBe(1);
    expect(cluster?.recurrence.independentContextCount).toBe(3);
    expect(cluster?.recurrence.strength).toBe("strong");
    expect(cluster?.diversity.sourceContextCount).toBe(3);
    expect(report.decision.observePassWorthwhile).toBe(true);
  });

  test("absent context evidence reports unknown generalizability risk rather than low risk", () => {
    const entries = [1, 2, 3].map((id) =>
      withProvenance(makeEntry(id, `team//memories/member-${id}`, ["topic"], [], { project: undefined }), {}),
    );

    const cluster = analyzeRecombineCandidates(entries, { minClusterSize: 3, maxClusters: 1 }).clusters[0];

    expect(cluster?.generalizabilityRisk.level).toBe("unknown");
    expect(cluster?.generalizabilityRisk.signals).toContain("generalizability-evidence-unknown");
  });

  test("filters relative paths, package paths, URLs, and old structural junk consistently", () => {
    for (const junk of [
      "src/foo.ts",
      "packages/core/package.json",
      "@scope/pkg",
      "https://example.test/docs/api",
      "../secrets/file.txt",
      "foo\\bar.ts",
      "20260722",
      "v1.2.3",
      "002c624c",
      "the",
    ]) {
      expect(isRecombineJunkTag(junk)).toBe(true);
      expect(isRecombineJunkEntity(junk)).toBe(true);
    }
    for (const useful of ["auth", "print-md", "opencode", "guardian"]) {
      expect(isRecombineJunkTag(useful)).toBe(false);
      expect(isRecombineJunkEntity(useful)).toBe(false);
    }
  });

  test("selection reserves tight tag slots while entities lead and neither kind starves", () => {
    const entries: RecombineAnalyzerEntry[] = [];
    let id = 1;
    for (const signal of ["entity-a", "entity-b", "entity-c", "entity-d"]) {
      for (let member = 0; member < 3; member++) {
        entries.push(makeEntry(id, `team//memories/p-${signal}/${signal}-${member}`, [], [signal]));
        id += 1;
      }
    }
    for (const signal of ["tag-a", "tag-b", "tag-c"]) {
      for (let member = 0; member < 3; member++) {
        entries.push(makeEntry(id, `team//memories/p-${signal}/${signal}-${member}`, [signal], []));
        id += 1;
      }
    }
    for (let member = 0; member < 21; member++) {
      entries.push(makeEntry(id, `team//memories/p-broad/broad-${member}`, ["broad"], []));
      id += 1;
    }

    const report = analyzeRecombineCandidates(entries, {
      minClusterSize: 3,
      maxClusters: 5,
      relatedness: "both",
    });
    const selected = report.clusters.filter((cluster) => cluster.selected).map((cluster) => cluster.signature);

    expect(selected).toEqual(["entity:entity-a", "entity:entity-b", "tag:tag-a", "tag:tag-b", "tag:tag-c"]);
    expect(selected).not.toContain("tag:broad");
  });

  test("cap selection fairly represents bundle/source scopes before taking second clusters", () => {
    const entries: RecombineAnalyzerEntry[] = [];
    let id = 1;
    for (const scope of ["a", "b", "c", "d", "e"]) {
      for (let member = 0; member < 3; member++) {
        entries.push(
          makeEntry(id++, `${scope}//memories/project/entity-${member}`, [], [`entity-${scope}`], {
            bundle: scope,
            sourceRoot: `/fixture/${scope}`,
          }),
        );
      }
      for (let member = 0; member < 3; member++) {
        entries.push(
          makeEntry(id++, `${scope}//memories/project/tag-${member}`, [`tag-${scope}`], [], {
            bundle: scope,
            sourceRoot: `/fixture/${scope}`,
          }),
        );
      }
    }

    const selected = analyzeRecombineCandidates(entries, { minClusterSize: 3, maxClusters: 5 }).clusters.filter(
      (cluster) => cluster.selected,
    );

    expect(new Set(selected.map((cluster) => `${cluster.scope.bundle}/${cluster.scope.sourceFingerprint}`)).size).toBe(
      5,
    );
    expect(selected.map((cluster) => cluster.signature)).toEqual([
      "entity:entity-a",
      "entity:entity-b",
      "tag:tag-c",
      "tag:tag-d",
      "tag:tag-e",
    ]);
  });

  test("scope-first selection covers asymmetric A-E scopes before satisfying kind preferences", () => {
    const entries: RecombineAnalyzerEntry[] = [];
    let id = 1;
    for (const scope of ["a", "b", "c"]) {
      for (let member = 0; member < 3; member++) {
        entries.push(
          makeEntry(id++, `${scope}//memories/project/entity-${member}`, [], [`entity-${scope}`], {
            bundle: scope,
            sourceRoot: `/fixture/${scope}`,
          }),
        );
      }
    }
    for (const scope of ["a", "d", "e"]) {
      for (let member = 0; member < 3; member++) {
        entries.push(
          makeEntry(id++, `${scope}//memories/project/tag-${member}`, [`tag-${scope}`], [], {
            bundle: scope,
            sourceRoot: `/fixture/${scope}`,
          }),
        );
      }
    }

    const selected = analyzeRecombineCandidates(entries, { minClusterSize: 3, maxClusters: 5 }).clusters.filter(
      (cluster) => cluster.selected,
    );

    expect(new Set(selected.map((cluster) => cluster.scope.bundle))).toEqual(new Set(["a", "b", "c", "d", "e"]));
    expect(selected.map((cluster) => cluster.signature)).toEqual([
      "entity:entity-a",
      "entity:entity-b",
      "entity:entity-c",
      "tag:tag-d",
      "tag:tag-e",
    ]);
  });

  test("ordering and member-set fingerprints are stable across input order", () => {
    const entries = analyzerFixture();
    const options = { minClusterSize: 3, maxClusterSize: 4, maxClusters: 20, relatedness: "both" } as const;
    const first = analyzeRecombineCandidates(entries, options);
    const second = analyzeRecombineCandidates(
      entries
        .reverse()
        .map((entry) => ({ ...entry, tags: [...entry.tags].reverse(), entities: [...entry.entities].reverse() })),
      options,
    );

    expect(second.clusters).toEqual(first.clusters);
    expect(first.clusters.every((cluster) => /^sha256:[a-f0-9]{16}$/.test(cluster.fingerprint))).toBe(true);
    expect(first.clusters.every((cluster) => [...cluster.memberRefs].sort().join() === cluster.memberRefs.join())).toBe(
      true,
    );
  });

  test("member-set fingerprints survive absolute source-root relocation", () => {
    const entries = [1, 2, 3].map((id) =>
      makeEntry(id, `team//memories/project/member-${id}`, ["relocatable"], [], { sourceRoot: "/old/root" }),
    );
    const relocated = entries.map((entry) => ({ ...entry, sourceRoot: "/new/root" }));
    const before = analyzeRecombineCandidates(entries, { minClusterSize: 3, maxClusters: 1 }).clusters[0];
    const after = analyzeRecombineCandidates(relocated, { minClusterSize: 3, maxClusters: 1 }).clusters[0];

    expect(after?.fingerprint).toBe(before?.fingerprint);
    expect(after?.scope.sourceFingerprint).not.toBe(before?.scope.sourceFingerprint);
  });

  test("duplicate canonical member refs are rejected instead of inflating recurrence", () => {
    const entries = [1, 2, 3].map((id) => makeEntry(id, `team//memories/project/member-${id}`, ["duplicate"], []));
    const duplicate = entries[0];
    if (!duplicate) throw new Error("fixture entry missing");
    entries.push({ ...duplicate, id: 99 });

    expect(() => analyzeRecombineCandidates(entries, { minClusterSize: 3 })).toThrow("duplicate canonical item ref");
  });
});

describe("akm-eval data path parity", () => {
  const resolveForPlatform = resolveDataDir as (
    env: Record<string, string | undefined>,
    platform: NodeJS.Platform,
  ) => string;

  test("mirrors production Windows defaults and requires an explicit usable home", () => {
    expect(resolveForPlatform({ LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, "win32")).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\akm\\data",
    );
    expect(resolveForPlatform({ USERPROFILE: "C:\\Users\\Ada" }, "win32")).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\akm\\data",
    );
    expect(() => resolveForPlatform({}, "win32")).toThrow("AKM_DATA_DIR");
  });
});

interface DbFixture {
  root: string;
  dataDir: string;
  stashDir: string;
  indexDb: string;
  stateDb: string;
}

function buildDbFixture(): DbFixture {
  const root = tempDir();
  const dataDir = path.join(root, "data");
  const stashDir = path.join(root, "stash");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(stashDir, "memories", "project-a"), { recursive: true });
  const indexDb = path.join(dataDir, "index.db");
  const stateDb = path.join(dataDir, "state.db");
  const index = new Database(indexDb);
  index.exec(`
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY,
      entry_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      stash_dir TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      search_text TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      item_ref TEXT,
      bundle_id TEXT,
      concept_id TEXT
    );
    CREATE TABLE graph_files (
      stash_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      PRIMARY KEY (stash_root, file_path, body_hash)
    );
    CREATE TABLE graph_file_entities (
      stash_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      entity_order INTEGER NOT NULL,
      entity_norm TEXT NOT NULL
    );
  `);
  for (let id = 1; id <= 3; id++) {
    const name = `project-a/auth-${id}`;
    const filePath = path.join(stashDir, "memories", `${name}.md`);
    fs.writeFileSync(filePath, `SENSITIVE_BODY_CANARY_${id}\n`, "utf8");
    index
      .prepare(
        `INSERT INTO entries
         (id, entry_key, file_path, stash_dir, entry_json, search_text, entry_type, item_ref, bundle_id, concept_id)
         VALUES (?, ?, ?, ?, ?, ?, 'memory', ?, 'team', ?)`,
      )
      .run(
        id,
        `ignored-entry-key-${id}`,
        filePath,
        stashDir,
        JSON.stringify({
          name,
          type: "memory",
          tags: ["auth"],
          sourceRefs: [`sessions/opencode/session-${id}`],
          cwd: `/work/project-${id}`,
          fileSize: 1000 + id,
          description: `SENSITIVE_DESCRIPTION_CANARY_${id}`,
        }),
        `SENSITIVE_SEARCH_TEXT_CANARY_${id}`,
        `team//memories/${name}`,
        `memories/${name}`,
      );
    index.prepare("INSERT INTO graph_files VALUES (?, ?, ?)").run(stashDir, filePath, `hash-${id}`);
    index
      .prepare("INSERT INTO graph_file_entities VALUES (?, ?, ?, 0, 'guardian')")
      .run(stashDir, filePath, `hash-${id}`);
  }
  index
    .prepare(
      `INSERT INTO entries
       (id, entry_key, file_path, stash_dir, entry_json, search_text, entry_type, item_ref, bundle_id, concept_id)
       VALUES (99, 'ignored-entry-key-99', '/missing', ?, ?, '', 'memory', NULL, NULL, NULL)`,
    )
    .run(stashDir, JSON.stringify({ name: "legacy-only", type: "memory", tags: ["auth"] }));
  index.close();

  const state = new Database(stateDb);
  state.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY, event_type TEXT NOT NULL, metadata_json TEXT NOT NULL);
    CREATE TABLE proposals (id TEXT PRIMARY KEY, ref TEXT NOT NULL, source TEXT NOT NULL);
    INSERT INTO events VALUES (1, 'existing_event', '{}');
    INSERT INTO proposals VALUES ('existing-proposal', 'lessons/existing', 'reflect');
  `);
  state.close();
  return { root, dataDir, stashDir, indexDb, stateDb };
}

function rowCounts(dbPath: string): { events: number; proposals: number } {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      events: (db.query("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count,
      proposals: (db.query("SELECT COUNT(*) AS count FROM proposals").get() as { count: number }).count,
    };
  } finally {
    db.close();
  }
}

function breakGraphSchema(indexDb: string, mode: "missing-table" | "incompatible-column"): void {
  const db = new Database(indexDb);
  if (mode === "missing-table") {
    db.exec("DROP TABLE graph_file_entities");
  } else {
    db.exec(`
      DROP TABLE graph_file_entities;
      CREATE TABLE graph_file_entities (
        stash_root TEXT NOT NULL,
        file_path TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        entity_order INTEGER NOT NULL,
        wrong_entity_column TEXT NOT NULL
      );
    `);
  }
  db.close();
}

describe("akm-eval recombine analyzer CLI read-only boundary", () => {
  test("refuses a pre-canonical index instead of rebuilding refs from legacy entry_key", () => {
    const root = tempDir();
    const indexDb = path.join(root, "index.db");
    const db = new Database(indexDb);
    db.exec(`
      CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        entry_key TEXT NOT NULL,
        stash_dir TEXT NOT NULL,
        file_path TEXT NOT NULL,
        entry_json TEXT NOT NULL,
        entry_type TEXT NOT NULL
      );
      INSERT INTO entries VALUES
        (1, 'ignored-entry-key', '/stash', '/stash/memories/a.md', '{"name":"a","type":"memory","tags":["auth"]}', 'memory');
    `);
    db.close();
    const before = digestTree(root);

    const result = Bun.spawnSync([WRAPPER, "--index-db", indexDb, "--format", "json"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("current canonical-ref columns");
    expect(digestTree(root)).toEqual(before);
  });

  test("default execution writes only stdout and does not modify DBs, assets, events, or proposals", () => {
    const fixtureDb = buildDbFixture();
    const beforeTree = digestTree(fixtureDb.root);
    const beforeRows = rowCounts(fixtureDb.stateDb);
    const result = Bun.spawnSync([WRAPPER, "--format", "json", "--min-cluster-size", "3"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        AKM_DATA_DIR: fixtureDb.dataDir,
        AKM_STASH_DIR: fixtureDb.stashDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).not.toContain("SENSITIVE_BODY_CANARY");
    expect(result.stdout.toString()).not.toContain("SENSITIVE_DESCRIPTION_CANARY");
    expect(result.stdout.toString()).not.toContain("SENSITIVE_SEARCH_TEXT_CANARY");
    const report = JSON.parse(result.stdout.toString()) as {
      clusters: Array<{ memberRefs: string[] }>;
      summary: { skippedMissingCanonicalRef: number };
    };
    expect(report.clusters[0]?.memberRefs).toEqual([
      "team//memories/project-a/auth-1",
      "team//memories/project-a/auth-2",
      "team//memories/project-a/auth-3",
    ]);
    expect(report.summary.skippedMissingCanonicalRef).toBe(1);
    expect(digestTree(fixtureDb.root)).toEqual(beforeTree);
    expect(rowCounts(fixtureDb.stateDb)).toEqual(beforeRows);
  });

  for (const graphFailure of ["missing-table", "incompatible-column"] as const) {
    test(`graph mode fails explicitly on ${graphFailure} graph schema without modifying inputs`, () => {
      const fixtureDb = buildDbFixture();
      breakGraphSchema(fixtureDb.indexDb, graphFailure);
      const beforeTree = digestTree(fixtureDb.root);
      const beforeRows = rowCounts(fixtureDb.stateDb);
      const result = Bun.spawnSync(
        [WRAPPER, "--index-db", fixtureDb.indexDb, "--relatedness", "graph", "--format", "json"],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, AKM_DATA_DIR: fixtureDb.dataDir },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      expect(result.exitCode).toBe(2);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain("graph relatedness unavailable");
      expect(result.stderr.toString()).toContain("akm index");
      expect(digestTree(fixtureDb.root)).toEqual(beforeTree);
      expect(rowCounts(fixtureDb.stateDb)).toEqual(beforeRows);
    });

    test(`blended mode reports degraded graph state and tag fallback on ${graphFailure}`, () => {
      const fixtureDb = buildDbFixture();
      breakGraphSchema(fixtureDb.indexDb, graphFailure);
      const beforeTree = digestTree(fixtureDb.root);
      const beforeRows = rowCounts(fixtureDb.stateDb);
      const result = Bun.spawnSync(
        [WRAPPER, "--index-db", fixtureDb.indexDb, "--relatedness", "both", "--format", "json"],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, AKM_DATA_DIR: fixtureDb.dataDir },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      const report = JSON.parse(result.stdout.toString()) as {
        graph: { availability: string; degradedReason: string | null };
        clusters: Array<{ signature: string; memberRefs: string[] }>;
      };
      expect(report.graph.availability).toBe("degraded");
      expect(report.graph.degradedReason).toContain("graph schema/query unavailable");
      expect(report.clusters).toContainEqual(
        expect.objectContaining({
          signature: "tag:auth",
          memberRefs: [
            "team//memories/project-a/auth-1",
            "team//memories/project-a/auth-2",
            "team//memories/project-a/auth-3",
          ],
        }),
      );
      expect(digestTree(fixtureDb.root)).toEqual(beforeTree);
      expect(rowCounts(fixtureDb.stateDb)).toEqual(beforeRows);
    });
  }

  test("duplicate canonical refs in the index are rejected without modifying inputs", () => {
    const fixtureDb = buildDbFixture();
    const db = new Database(fixtureDb.indexDb);
    const row = db.query("SELECT * FROM entries WHERE id = 1").get() as Record<string, unknown>;
    db.prepare(
      `INSERT INTO entries
       (id, entry_key, file_path, stash_dir, entry_json, search_text, entry_type, item_ref, bundle_id, concept_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      100,
      "duplicate-entry-key",
      String(row.file_path),
      String(row.stash_dir),
      String(row.entry_json),
      String(row.search_text),
      String(row.entry_type),
      String(row.item_ref),
      String(row.bundle_id),
      String(row.concept_id),
    );
    db.close();
    const before = digestTree(fixtureDb.root);

    expect(() => readCurrentRecombineEntries(fixtureDb.indexDb)).toThrow("duplicate canonical item ref");
    expect(digestTree(fixtureDb.root)).toEqual(before);
  });

  for (const collision of ["index-exact", "state-exact", "index-symlink", "state-hardlink"] as const) {
    test(`rejects --out ${collision} input collisions before writing`, () => {
      const fixtureDb = buildDbFixture();
      let out = fixtureDb.indexDb;
      if (collision === "state-exact") out = fixtureDb.stateDb;
      if (collision === "index-symlink") {
        out = path.join(fixtureDb.root, "index-link");
        fs.symlinkSync(fixtureDb.indexDb, out);
      }
      if (collision === "state-hardlink") {
        out = path.join(fixtureDb.root, "state-hardlink");
        fs.linkSync(fixtureDb.stateDb, out);
      }
      const before = digestTree(fixtureDb.root);
      const result = Bun.spawnSync([WRAPPER, "--index-db", fixtureDb.indexDb, "--format", "json", "--out", out], {
        cwd: REPO_ROOT,
        env: { ...process.env, AKM_DATA_DIR: fixtureDb.dataDir },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(2);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain("input database");
      expect(digestTree(fixtureDb.root)).toEqual(before);
    });
  }

  test("--out does not clobber an existing non-input file", () => {
    const fixtureDb = buildDbFixture();
    const out = path.join(fixtureDb.root, "existing-report.json");
    fs.writeFileSync(out, "KEEP_ME", "utf8");
    const before = digestTree(fixtureDb.root);
    const result = Bun.spawnSync([WRAPPER, "--index-db", fixtureDb.indexDb, "--format", "json", "--out", out], {
      cwd: REPO_ROOT,
      env: { ...process.env, AKM_DATA_DIR: fixtureDb.dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("already exists");
    expect(fs.readFileSync(out, "utf8")).toBe("KEEP_ME");
    expect(digestTree(fixtureDb.root)).toEqual(before);
  });

  test("--out writes exactly the explicitly requested report and leaves databases unchanged", () => {
    const fixtureDb = buildDbFixture();
    const reportPath = path.join(fixtureDb.root, "explicit-report.json");
    const beforePaths = digestTree(fixtureDb.root).map((entry) => entry.path);
    const beforeIndex = createHash("sha256").update(fs.readFileSync(fixtureDb.indexDb)).digest("hex");
    const beforeState = createHash("sha256").update(fs.readFileSync(fixtureDb.stateDb)).digest("hex");
    const result = Bun.spawnSync([WRAPPER, "--format", "json", "--out", reportPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, AKM_DATA_DIR: fixtureDb.dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().length).toBeGreaterThan(0);
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8"))).toEqual(JSON.parse(result.stdout.toString()));
    expect(digestTree(fixtureDb.root).map((entry) => entry.path)).toEqual(
      [...beforePaths, "explicit-report.json"].sort(),
    );
    expect(createHash("sha256").update(fs.readFileSync(fixtureDb.indexDb)).digest("hex")).toBe(beforeIndex);
    expect(createHash("sha256").update(fs.readFileSync(fixtureDb.stateDb)).digest("hex")).toBe(beforeState);
    expect(rowCounts(fixtureDb.stateDb)).toEqual({ events: 1, proposals: 1 });
  });

  test("help identifies the command as read-only and documents stdout/--out behavior", () => {
    const result = Bun.spawnSync([WRAPPER, "--help"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
    const stdout = result.stdout.toString();
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("read-only");
    expect(stdout).toContain("stdout");
    expect(stdout).toContain("--out");
    expect(stdout).not.toContain("proposal");
  });
});
