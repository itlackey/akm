import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { akmLint } from "../../src/commands/lint";
import { akmProposalAccept } from "../../src/commands/proposal/proposal";
import { createProposal, isProposalSkipped } from "../../src/commands/proposal/repository";
import { resolveSupersedesForWrite, writeMarkdownAsset } from "../../src/commands/read/knowledge";
import { akmSearch } from "../../src/commands/read/search";
import { showLocal } from "../../src/commands/read/show";
import { loadConfig, resetConfigCache } from "../../src/core/config/config";
import { readEvents } from "../../src/core/events";
import { getDbPath } from "../../src/core/paths";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { akmIndex } from "../../src/indexer/indexer";
import { resolveSourceEntries } from "../../src/indexer/search/search-source";
import { closeDatabase, openExistingDatabase } from "../../src/storage/repositories/index-connection";
import { upsertEmbedding } from "../../src/storage/repositories/index-vec-repository";
import { createWorkflowAsset, getWorkflowTemplate } from "../../src/workflows/authoring/authoring";
import { getNextWorkflowStep, listWorkflowRuns } from "../../src/workflows/runtime/runs";
import { loadWorkflowAsset } from "../../src/workflows/runtime/workflow-asset-loader";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

function write(root: string, rel: string, content: string): void {
  const destination = path.join(root, rel);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, "utf8");
}

function concept(type: string, title: string, body: string): string {
  return `---\ntype: ${type}\ntitle: ${title}\n---\n\n${body}\n`;
}

describe("OKF first-class conformance", () => {
  let storage: IsolatedAkmStorage;
  let okfRoot: string;
  let noIndexRoot: string;

  function configure(adversarialAdapter: "akm" | "okf"): void {
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "local",
      bundles: {
        local: {
          path: storage.stashDir,
          writable: true,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
        adversarial: {
          path: okfRoot,
          writable: true,
          components: { main: { root: ".", adapter: adversarialAdapter, writable: true } },
        },
        noindex: { path: noIndexRoot, writable: false },
      },
    });
  }

  beforeEach(() => {
    storage = withIsolatedAkmStorage();
    okfRoot = path.join(storage.root, "okf-adversarial");
    noIndexRoot = path.join(storage.root, "okf-no-index");

    write(okfRoot, "index.md", "---\nokf_version: 9.9\n---\n\n# Adversarial bundle\n");
    write(okfRoot, "log.md", "# Update Log\n");
    write(okfRoot, "sub/index.md", "# Subdirectory\n");
    write(okfRoot, "duplicate-a.md", concept("Vendor Duplicate", "Same Title", "First concept."));
    write(okfRoot, "sub/duplicate-b.md", concept("Vendor Duplicate", "Same Title", "Second concept."));
    write(okfRoot, ".hidden/hidden.md", concept("Hidden Concept", "Hidden Concept", "Hidden body."));
    write(okfRoot, "bin/bin-doc.md", concept("Bin Concept", "Bin Concept", "Bin body."));
    write(
      okfRoot,
      "unknown.md",
      `${concept(
        "Some Vendor Thing",
        "Vendor Item",
        "# Overview\n\nOverview body.\n\n## Details and Usage\n\nFragment body.\n\n[Root](/target.md)\n[Relative](./relative.md)\n[Dangling](/missing.md)\n[Reference style][vendor-reference]",
      ).replace(
        "title: Vendor Item\n",
        "title: Vendor Item\naliases: [opaque-alias]\nsearchHints: [opaque-hint]\nusage: [opaque-usage]\n",
      )}\n[vendor-reference]: /ref-target.md\n`,
    );
    write(okfRoot, "target.md", concept("Known", "Root Target", "Target body."));
    write(okfRoot, "relative.md", concept("Known", "Relative Target", "Relative body."));
    write(okfRoot, "ref-target.md", concept("Known", "Reference Target", "Reference target body."));

    write(noIndexRoot, "vendor.md", concept("Some Vendor Thing", "No Index Vendor", "No-index marker."));

    configure("okf");
  });

  afterEach(() => storage.cleanup());

  test("preserves every path identity, open type, normalized field, and generic show behavior", async () => {
    const sources = resolveSourceEntries();
    expect(sources.find((source) => source.registryId === "adversarial")?.adapterId).toBe("okf");
    expect(sources.find((source) => source.registryId === "noindex")?.adapterId).toBeUndefined();

    await akmIndex({ stashDir: storage.stashDir, full: true });

    expect(resolveSourceEntries().find((source) => source.registryId === "noindex")?.adapterId).toBe("okf");
    expect(loadConfig().bundles?.noindex?.components?.main?.adapter).toBe("okf");

    const db = openExistingDatabase(getDbPath());
    try {
      const rows = db
        .prepare(
          "SELECT item_ref AS itemRef, type, adapter_id AS adapterId, document_json AS documentJson " +
            "FROM entries WHERE bundle_id = 'adversarial' ORDER BY item_ref",
        )
        .all() as Array<{ itemRef: string; type: string; adapterId: string; documentJson: string }>;
      expect(rows.map((row) => row.itemRef)).toEqual([
        "adversarial//.hidden/hidden",
        "adversarial//bin/bin-doc",
        "adversarial//duplicate-a",
        "adversarial//ref-target",
        "adversarial//relative",
        "adversarial//sub/duplicate-b",
        "adversarial//target",
        "adversarial//unknown",
      ]);
      expect(rows.every((row) => row.adapterId === "okf")).toBe(true);
      expect(rows.filter((row) => row.type === "Vendor Duplicate")).toHaveLength(2);
      expect(rows.find((row) => row.itemRef.endsWith("//unknown"))?.type).toBe("Some Vendor Thing");

      const unknown = JSON.parse(rows.find((row) => row.itemRef.endsWith("//unknown"))!.documentJson) as {
        content?: string;
        links?: string[];
        aliases?: string[];
        searchHints?: string[];
        usage?: string[];
        documentJson?: Record<string, unknown>;
      };
      expect(unknown.content).toContain("Fragment body.");
      expect(unknown.links).toEqual(["target", "relative", "missing", "ref-target"]);
      expect(unknown.aliases).toBeUndefined();
      expect(unknown.searchHints).toBeUndefined();
      expect(unknown.usage).toBeUndefined();
      expect(unknown.documentJson).toMatchObject({
        aliases: ["opaque-alias"],
        searchHints: ["opaque-hint"],
        usage: ["opaque-usage"],
      });

      const noIndex = db
        .prepare("SELECT item_ref AS itemRef, type, adapter_id AS adapterId FROM entries WHERE bundle_id = ?")
        .get("noindex") as { itemRef: string; type: string; adapterId: string };
      expect(noIndex).toEqual({
        itemRef: "noindex//vendor",
        type: "Some Vendor Thing",
        adapterId: "okf",
      });
    } finally {
      closeDatabase(db);
    }

    const shown = await showLocal({ ref: "adversarial//unknown" });
    expect(shown).toMatchObject({
      ref: "adversarial//unknown",
      type: "Some Vendor Thing",
      name: "Vendor Item",
    });
    expect(shown.content).toContain("Overview body.");
    expect(shown.content).not.toContain("type: Some Vendor Thing");

    const search = await akmSearch({ query: "Fragment body", skipLogging: true });
    const hit = search.hits.find(
      (candidate) => "path" in candidate && candidate.path === path.join(okfRoot, "unknown.md"),
    );
    // The query only matches this entry's body ("Fragment body." lives under
    // "## Details and Usage", not in name/description/tags/hints), so the
    // units search path's per-unit ranking (index-redesign-contract.md B3)
    // correctly picks that fragment unit as the entry's best-scoring match and
    // anchors the ref to it — a real capability gain over the pre-B5 index,
    // which had no unit coverage for non-`akm` adapters at all (`okf` never
    // calls `setMarkdownFragmentContent`, so its content only ever reached
    // `entries_fts`'s single per-entry column, never a fragment). The anchor
    // is a genuinely resolvable ref, the same `akm-fragment-<n>-<hash>` id
    // `showLocal({ ref: "...#details-and-usage" })` below reaches by its
    // heading-slug alias (`splitMarkdownFragments`, `core/asset/markdown-fragments.ts`).
    expect(hit && "ref" in hit ? hit.ref : undefined).toMatch(/^adversarial\/\/unknown#akm-fragment-\d+-[0-9a-f]+$/);

    const fragment = await showLocal({ ref: "adversarial//unknown#details-and-usage" });
    expect(fragment.content).toContain("## Details and Usage");
    expect(fragment.content).toContain("Fragment body.");
    expect(fragment.content).not.toContain("Overview body.");
    expect(fragment.ref).toBe("adversarial//unknown");

    const lint = await akmLint({ dir: okfRoot });
    expect(lint.ok).toBe(true);
    // akm 0.9.0 lint/adapter-dispatch wiring — GAP CLOSURE: `unknown.md`'s
    // `[Dangling](/missing.md)` link (seeded above) was ALWAYS a broken OKF
    // link, but the pre-dispatch `akm lint` ran a CLI-only `missing-type`-only
    // re-implementation for OKF bundles that never checked links at all —
    // `okfAdapter.validate()`'s own `missing-ref` check (`okf-adapter.ts`) was
    // unreachable dead code. `akm lint` now runs the real adapter, so this
    // finding — genuinely present in the fixture the whole time — is reported
    // (non-blocking, per §5's OKF leniency: consumers tolerate broken links).
    expect(lint.flagged).toEqual([
      {
        file: "unknown.md",
        issue: "missing-ref",
        detail: "warning: OKF link target not found: missing (non-blocking, consumers tolerate broken links)",
        fixed: false,
      },
    ]);

    await expect(
      writeMarkdownAsset({
        type: "memory",
        content: "A correction.",
        name: "correction",
        fallbackPrefix: "memory",
        target: "adversarial",
      }),
    ).rejects.toThrow(/adapter "okf".*does not support AKM asset writes/i);
    expect(fs.existsSync(path.join(okfRoot, "memories", "correction.md"))).toBe(false);

    const proposal = createProposal(storage.stashDir, {
      ref: "lessons/blocked-proposal",
      target: { source: "adversarial", root: okfRoot },
      source: "propose",
      force: true,
      payload: {
        content:
          "---\ndescription: Proposal content must not publish\nwhen_to_use: Testing consumer-only OKF writes\n---\n\nBlocked.\n",
      },
    });
    if (isProposalSkipped(proposal)) throw new Error("unexpected proposal skip");
    await expect(
      akmProposalAccept({ stashDir: storage.stashDir, id: proposal.id, target: "adversarial" }),
    ).rejects.toThrow(/adapter "okf".*does not support AKM asset writes/i);
    expect(fs.existsSync(path.join(okfRoot, "lessons", "blocked-proposal.md"))).toBe(false);

    const native = await writeMarkdownAsset({
      type: "memory",
      content: "# Native memory\n\nNative body.",
      name: "native-memory",
      fallbackPrefix: "memory",
      target: "local",
    });
    expect(parseType(native.path)).toBe("memory");

    const warnings: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    try {
      const reserved = await writeMarkdownAsset({
        type: "memory",
        content: "Reserved.",
        name: "index",
        fallbackPrefix: "memory",
        target: "local",
      });
      expect(parseType(reserved.path)).toBe("memory");
      expect(warnings.some((w) => w.includes("index"))).toBe(true);
    } finally {
      _setWarnSinkForTests(undefined);
    }
    expect(fs.existsSync(path.join(storage.stashDir, "memories", "index.md"))).toBe(true);
  });

  test("an adapter change invalidates incremental freshness and updates the canonical row in place", async () => {
    write(okfRoot, "knowledge/switch.md", concept("knowledge", "Switch", "Adapter switch body."));
    configure("akm");
    resetConfigCache();

    await akmIndex({ stashDir: storage.stashDir, full: true });

    const readSwitchRow = () => {
      const db = openExistingDatabase(getDbPath());
      try {
        return db
          .prepare(
            "SELECT id, item_ref AS itemRef, adapter_id AS adapterId FROM entries " +
              "WHERE item_ref = 'adversarial//knowledge/switch' ORDER BY id",
          )
          .all() as Array<{ id: number; itemRef: string; adapterId: string }>;
      } finally {
        closeDatabase(db);
      }
    };

    const initial = readSwitchRow();
    expect(initial).toEqual([{ id: expect.any(Number), itemRef: "adversarial//knowledge/switch", adapterId: "akm" }]);
    const initialId = initial[0]?.id;
    expect(initialId).toBeNumber();

    configure("okf");
    resetConfigCache();
    const result = await akmIndex({ stashDir: storage.stashDir });

    expect(result.mode).toBe("incremental");
    expect(readSwitchRow()).toEqual([
      { id: initialId as number, itemRef: "adversarial//knowledge/switch", adapterId: "okf" },
    ]);
  });

  test("an adapter change prunes directories omitted by the new walk policy", async () => {
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const db = openExistingDatabase(getDbPath());
    const staleRows = (
      db
        .prepare(
          "SELECT id, file_path AS filePath FROM entries " +
            "WHERE item_ref IN ('adversarial//.hidden/hidden', 'adversarial//bin/bin-doc') ORDER BY item_ref",
        )
        .all() as Array<{ id: number; filePath: string }>
    ).map((row) => ({ ...row, dirPath: path.dirname(row.filePath) }));
    expect(staleRows).toHaveLength(2);
    for (const row of staleRows)
      upsertEmbedding(
        db,
        row.id,
        new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
      );
    closeDatabase(db);

    configure("akm");
    resetConfigCache();
    await akmIndex({ stashDir: storage.stashDir });

    const switched = openExistingDatabase(getDbPath());
    try {
      const ids = staleRows.map((row) => row.id);
      const placeholders = ids.map(() => "?").join(",");
      expect(
        switched.prepare(`SELECT COUNT(*) AS count FROM entries WHERE id IN (${placeholders})`).get(...ids),
      ).toEqual({
        count: 0,
      });
      expect(
        switched.prepare(`SELECT COUNT(*) AS count FROM embeddings WHERE id IN (${placeholders})`).get(...ids),
      ).toEqual({ count: 0 });
      expect(
        switched.prepare(`SELECT COUNT(*) AS count FROM entries_vec WHERE id IN (${placeholders})`).get(...ids),
      ).toEqual({
        count: 0,
      });
    } finally {
      closeDatabase(switched);
    }

    configure("okf");
    resetConfigCache();
    await akmIndex({ stashDir: storage.stashDir });

    const restored = openExistingDatabase(getDbPath());
    try {
      const refs = restored
        .prepare(
          "SELECT item_ref AS itemRef FROM entries " +
            "WHERE item_ref IN ('adversarial//.hidden/hidden', 'adversarial//bin/bin-doc') ORDER BY item_ref",
        )
        .all() as Array<{ itemRef: string }>;
      expect(refs.map((row) => row.itemRef)).toEqual(["adversarial//.hidden/hidden", "adversarial//bin/bin-doc"]);
    } finally {
      closeDatabase(restored);
    }
  });

  test("adapter reconciliation hands an overlapping directory to the remaining source", async () => {
    const nestedRoot = path.join(storage.stashDir, ".hidden");
    write(storage.stashDir, ".hidden/overlap.md", concept("knowledge", "Overlap", "Overlap body."));
    const configureOverlap = (parentAdapter: "akm" | "okf") => {
      writeSandboxConfig({
        semanticSearchMode: "off",
        defaultBundle: "parent",
        bundles: {
          parent: {
            path: storage.stashDir,
            components: { main: { root: ".", adapter: parentAdapter, writable: true } },
          },
          nested: {
            path: nestedRoot,
            components: { main: { root: ".", adapter: "okf", writable: false } },
          },
        },
      });
      resetConfigCache();
    };

    configureOverlap("okf");
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const initialDb = openExistingDatabase(getDbPath());
    let initialId = 0;
    try {
      const initial = initialDb
        .prepare("SELECT id, item_ref AS itemRef, bundle_id AS bundleId FROM entries WHERE file_path = ?")
        .get(path.join(nestedRoot, "overlap.md")) as { id: number; itemRef: string; bundleId: string };
      expect(initial).toEqual({
        id: expect.any(Number),
        itemRef: "parent//.hidden/overlap",
        bundleId: "parent",
      });
      initialId = initial.id;
    } finally {
      closeDatabase(initialDb);
    }

    configureOverlap("akm");
    await akmIndex({ stashDir: storage.stashDir });

    const db = openExistingDatabase(getDbPath());
    try {
      const rows = db
        .prepare("SELECT id, item_ref AS itemRef, bundle_id AS bundleId FROM entries WHERE file_path = ?")
        .all(path.join(nestedRoot, "overlap.md")) as Array<{ id: number; itemRef: string; bundleId: string }>;
      expect(rows).toEqual([{ id: expect.any(Number), itemRef: "nested//overlap", bundleId: "nested" }]);
      expect(rows[0]?.id).not.toBe(initialId);
    } finally {
      closeDatabase(db);
    }

    await akmIndex({ stashDir: storage.stashDir });
    const stableDb = openExistingDatabase(getDbPath());
    try {
      const stableRefs = stableDb
        .prepare("SELECT item_ref AS itemRef FROM entries WHERE file_path = ?")
        .all(path.join(nestedRoot, "overlap.md")) as Array<{ itemRef: string }>;
      expect(stableRefs).toEqual([{ itemRef: "nested//overlap" }]);
    } finally {
      closeDatabase(stableDb);
    }

    configureOverlap("okf");
    await akmIndex({ stashDir: storage.stashDir });
    const reversedDb = openExistingDatabase(getDbPath());
    try {
      const reversedRows = reversedDb
        .prepare("SELECT item_ref AS itemRef, bundle_id AS bundleId FROM entries WHERE file_path = ?")
        .all(path.join(nestedRoot, "overlap.md")) as Array<{ itemRef: string; bundleId: string }>;
      expect(reversedRows).toEqual([{ itemRef: "parent//.hidden/overlap", bundleId: "parent" }]);
    } finally {
      closeDatabase(reversedDb);
    }
  });

  test("adapter reconciliation is order-independent when the removing source is scanned last", async () => {
    const nestedRoot = path.join(storage.stashDir, ".container");
    const sharedDir = path.join(nestedRoot, ".hidden");
    const filePath = path.join(sharedDir, "overlap.md");
    write(storage.stashDir, ".container/.hidden/overlap.md", concept("knowledge", "Overlap", "Overlap body."));
    const configureOverlap = (parentAdapter: "akm" | "okf", nestedAdapter: "akm" | "okf") => {
      writeSandboxConfig({
        semanticSearchMode: "off",
        defaultBundle: "parent",
        bundles: {
          parent: {
            path: storage.stashDir,
            components: { main: { root: ".", adapter: parentAdapter, writable: true } },
          },
          nested: {
            path: nestedRoot,
            components: { main: { root: ".", adapter: nestedAdapter, writable: false } },
          },
        },
      });
      resetConfigCache();
    };

    configureOverlap("akm", "okf");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    configureOverlap("okf", "akm");
    await akmIndex({ stashDir: storage.stashDir });

    const db = openExistingDatabase(getDbPath());
    try {
      const rows = db
        .prepare("SELECT item_ref AS itemRef, bundle_id AS bundleId FROM entries WHERE file_path = ?")
        .all(filePath) as Array<{ itemRef: string; bundleId: string }>;
      expect(rows).toEqual([{ itemRef: "parent//.container/.hidden/overlap", bundleId: "parent" }]);
    } finally {
      closeDatabase(db);
    }
  });

  test("an incomplete Git walk cannot prune rows during incremental or full indexing", async () => {
    const blockedPath = path.join(okfRoot, "partial", "blocked.md");
    write(okfRoot, "partial/blocked.md", concept("knowledge", "Blocked", "Blocked body."));
    write(okfRoot, "partial/good.md", concept("knowledge", "Good", "Good body."));
    expect(spawnSync("git", ["init"], { cwd: okfRoot }).status).toBe(0);
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const originalStatSync = fs.statSync;
    const statSpy = spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
      if (path.resolve(String(target)) === path.resolve(blockedPath)) throw new Error("simulated stat failure");
      return originalStatSync(target, options as never);
    }) as typeof fs.statSync);
    try {
      await akmIndex({ stashDir: storage.stashDir });
      await akmIndex({ stashDir: storage.stashDir, full: true });
    } finally {
      statSpy.mockRestore();
    }

    const db = openExistingDatabase(getDbPath());
    try {
      const refs = db
        .prepare(
          "SELECT item_ref AS itemRef FROM entries WHERE item_ref LIKE 'adversarial//partial/%' ORDER BY item_ref",
        )
        .all() as Array<{ itemRef: string }>;
      expect(refs.map((row) => row.itemRef)).toEqual(["adversarial//partial/blocked", "adversarial//partial/good"]);
    } finally {
      closeDatabase(db);
    }
  });

  test("an unavailable configured secondary source preserves rows and freshness", async () => {
    await akmIndex({ stashDir: storage.stashDir, full: true });
    const beforeDb = openExistingDatabase(getDbPath());
    let builtAt = "";
    try {
      builtAt = (beforeDb.prepare("SELECT value FROM index_meta WHERE key = 'builtAt'").get() as { value: string })
        .value;
    } finally {
      closeDatabase(beforeDb);
    }

    const aside = `${okfRoot}.aside`;
    fs.renameSync(okfRoot, aside);
    try {
      resetConfigCache();
      // `adversarial` stays a CONFIGURED bundle throughout (only its content
      // root vanished), so reconcile's own walk-completeness guard —
      // never `removeStaleSourceOwners`, which only fires when a bundle
      // leaves `config.bundles` entirely — is what preserves its rows here:
      // `walkStashFlatWithStatus` reports that root incomplete, so its
      // gone-path sweep is skipped and `scanComplete` is false.
      const result = await akmIndex({ stashDir: storage.stashDir });
      expect(result.scanComplete).toBe(false);
    } finally {
      fs.renameSync(aside, okfRoot);
    }

    const afterDb = openExistingDatabase(getDbPath());
    try {
      const row = afterDb
        .prepare("SELECT item_ref AS itemRef FROM entries WHERE item_ref = 'adversarial//target'")
        .get() as { itemRef: string } | null;
      expect(row).toEqual({ itemRef: "adversarial//target" });
      expect(
        (afterDb.prepare("SELECT value FROM index_meta WHERE key = 'builtAt'").get() as { value: string }).value,
      ).toBe(builtAt);
    } finally {
      closeDatabase(afterDb);
    }
  });

  test("an unknown configured adapter cannot wipe a previously indexed component", async () => {
    await akmIndex({ stashDir: storage.stashDir, full: true });
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "local",
      bundles: {
        local: {
          path: storage.stashDir,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
        adversarial: {
          path: okfRoot,
          components: { main: { root: ".", adapter: "no-such-adapter", writable: false } },
        },
      },
    });
    resetConfigCache();

    // #909: an unrecognised adapter is rejected when the config loads, naming
    // the accepted values -- so the index never starts, never mind wipes.
    await expect(akmIndex({ stashDir: storage.stashDir, full: true })).rejects.toThrow(
      /unrecognized adapter "no-such-adapter"; expected one of: .*\bakm\b/,
    );

    const db = openExistingDatabase(getDbPath());
    try {
      expect(
        db.prepare("SELECT item_ref AS itemRef FROM entries WHERE item_ref = 'adversarial//target'").get(),
      ).toEqual({ itemRef: "adversarial//target" });
    } finally {
      closeDatabase(db);
    }
  });

  test("OKF lint dispatches to the real okf adapter validate() and keeps findings non-fatal by default", async () => {
    write(okfRoot, "missing-type.md", "---\ntitle: Missing Type\n---\n\nBody.\n");
    write(okfRoot, "uppercase-missing-type.MD", "---\ntitle: Uppercase Missing Type\n---\n\nBody.\n");
    write(okfRoot, "INDEX.MD", "# Reserved structural file\n");

    const result = await akmLint({ dir: okfRoot });

    expect(result.ok).toBe(true);
    // akm 0.9.0 lint/adapter-dispatch wiring: `akm lint` now runs the OKF
    // bundle through the real `okfAdapter.validate()` (spec §5) instead of a
    // CLI-only re-implementation — the detail text below is the adapter's own
    // (`okf-adapter.ts`'s `missing-type` message), not a re-recorded
    // duplicate of it. This is the same fix that makes `missing-ref` reachable
    // at all for OKF bundles (see the dedicated gap-closure test below).
    expect(result.flagged).toContainEqual({
      file: "missing-type.md",
      issue: "missing-type",
      detail: "info: no frontmatter `type`; defaults to `knowledge` (OKF leniency, non-blocking)",
      fixed: false,
    });
    expect(result.flagged).toContainEqual({
      file: "uppercase-missing-type.MD",
      issue: "missing-type",
      detail: "info: no frontmatter `type`; defaults to `knowledge` (OKF leniency, non-blocking)",
      fixed: false,
    });
    expect(result.flagged.some((issue) => issue.file === "INDEX.MD")).toBe(false);
    expect(result.flagged.some((issue) => issue.issue === "missing-name-or-type")).toBe(false);

    // `typeFilter`/`fix` are akm-sweep-only options; a non-akm adapter dispatch
    // (like the old `lintOkfBundle` it replaces) always validates the whole
    // bundle and never writes.
    const filtered = await akmLint({ dir: okfRoot, typeFilter: "memories", fix: true });
    expect(filtered.flagged).toContainEqual({
      file: "missing-type.md",
      issue: "missing-type",
      detail: "info: no frontmatter `type`; defaults to `knowledge` (OKF leniency, non-blocking)",
      fixed: false,
    });
    expect(fs.existsSync(path.join(okfRoot, "missing-type.md"))).toBe(true);
  });

  test("configured adapter ownership wins over filesystem probing during lint", async () => {
    write(okfRoot, "knowledge/native.md", concept("knowledge", "Native", "Native body."));
    configure("akm");
    resetConfigCache();

    const result = await akmLint({ dir: okfRoot });

    expect(result.flagged.some((issue) => issue.issue === "missing-updated")).toBe(true);
    expect(result.flagged.some((issue) => issue.issue === "missing-type")).toBe(false);
  });

  test("native lint --fix does not delete an uppercase Markdown memory", async () => {
    const basePath = path.join(okfRoot, "memories", "case-sensitive.MD");
    write(okfRoot, "memories/case-sensitive.MD", "---\ninferenceProcessed: true\nupdated: 2026-07-25\n---\nshort\n");
    write(okfRoot, "memories/case-sensitive.derived.md", concept("memory", "Derived", "Derived body."));
    configure("akm");
    resetConfigCache();

    await akmLint({ dir: okfRoot, fix: true });

    expect(fs.existsSync(basePath)).toBe(true);
  });

  test("non-default bundles named local and stash keep qualified round-trip refs", async () => {
    const localRoot = path.join(storage.root, "bundle-local");
    const stashRoot = path.join(storage.root, "bundle-stash");
    write(storage.stashDir, "shared.md", concept("knowledge", "Primary Shared", "Primary identity marker."));
    write(localRoot, "shared.md", concept("knowledge", "Local Shared", "Local identity marker."));
    write(stashRoot, "shared.md", concept("knowledge", "Stash Shared", "Stash identity marker."));
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "primary",
      bundles: {
        primary: {
          path: storage.stashDir,
          components: { main: { root: ".", adapter: "okf", writable: true } },
        },
        local: { path: localRoot, components: { main: { root: ".", adapter: "okf", writable: false } } },
        stash: { path: stashRoot, components: { main: { root: ".", adapter: "okf", writable: false } } },
      },
    });
    resetConfigCache();
    await akmIndex({ stashDir: storage.stashDir, full: true });

    const search = await akmSearch({ query: "identity marker", skipLogging: true });
    const refsByPath = new Map(
      search.hits.flatMap((hit) => ("path" in hit && "ref" in hit ? [[hit.path, hit.ref] as const] : [])),
    );
    // As above: "Primary identity marker." is body content, not part of the
    // name/description, so the winning unit is the (sole, heading-less) body
    // fragment and the ref anchors to it — see the comment on the "Fragment
    // body" search assertion earlier in this file for why this is a real
    // capability gain, not a regression.
    expect(refsByPath.get(path.join(storage.stashDir, "shared.md"))).toMatch(/^shared#akm-fragment-\d+-[0-9a-f]+$/);
    expect(refsByPath.get(path.join(localRoot, "shared.md"))).toMatch(/^local\/\/shared#akm-fragment-\d+-[0-9a-f]+$/);
    expect(refsByPath.get(path.join(stashRoot, "shared.md"))).toMatch(/^stash\/\/shared#akm-fragment-\d+-[0-9a-f]+$/);

    expect((await showLocal({ ref: "local//shared" })).content).toContain("Local identity marker.");
    expect((await showLocal({ ref: "stash//shared" })).content).toContain("Stash identity marker.");
  });

  test("OKF concepts cannot be executed as native workflows", async () => {
    write(okfRoot, "workflows/foreign.md", getWorkflowTemplate());

    await expect(loadWorkflowAsset("adversarial//workflows/foreign")).rejects.toThrow(
      /adapter "okf".*does not support native workflow execution/i,
    );
  });

  test("the native akm-workflow adapter remains executable", async () => {
    const workflowRoot = path.join(storage.root, "native-workflow-bundle");
    write(workflowRoot, "deploy.md", getWorkflowTemplate());
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "native",
      defaultWriteTarget: "native",
      engines: {
        "test-agent": { kind: "agent", platform: "opencode-sdk" },
        "test-llm": {
          kind: "llm",
          endpoint: "http://localhost:1/v1/chat/completions",
          model: "test-model",
        },
      },
      defaults: { engine: "test-agent", llmEngine: "test-llm" },
      workflow: { judgeEngine: "test-llm" },
      bundles: {
        local: { path: storage.stashDir },
        native: {
          path: workflowRoot,
          components: { main: { root: ".", adapter: "akm-workflow", writable: true } },
        },
      },
    });
    resetConfigCache();

    const loaded = await loadWorkflowAsset("native//deploy");
    expect(loaded.path).toBe(path.join(workflowRoot, "deploy.md"));
    expect(loaded.ref).toBe("native//deploy");
    expect(loaded.steps.length).toBeGreaterThan(0);

    const created = createWorkflowAsset({ name: "authored" });
    expect(created.ref).toBe("authored");
    expect(created.path).toBe(path.join(workflowRoot, "authored.md"));
    expect((await loadWorkflowAsset(created.ref)).path).toBe(created.path);
    await akmIndex({ stashDir: workflowRoot, full: true });
    expect((await showLocal({ ref: created.ref })).path).toBe(created.path);
    const started = await getNextWorkflowStep(created.ref);
    expect(started.run.workflowRef).toBe("native//authored");
    expect((await listWorkflowRuns({ workflowRef: created.ref })).runs).toHaveLength(1);
    await expect(getNextWorkflowStep("native//authored")).resolves.toMatchObject({
      run: { id: started.run.id, workflowRef: "native//authored" },
    });
    expect(
      readEvents({ type: "workflow_started" }).events.find(
        (event) => (event.metadata as { runId?: string } | undefined)?.runId === started.run.id,
      )?.ref,
    ).toBe("native//authored");
    await expect(listWorkflowRuns({ workflowRef: " " })).rejects.toMatchObject({ code: "INVALID_FLAG_VALUE" });
    await expect(listWorkflowRuns({ workflowRef: "native//" })).rejects.toThrow(/Invalid ref/);

    const nested = createWorkflowAsset({ name: "knowledge/nested" });
    expect(nested.ref).toBe("knowledge/nested");
    expect((await loadWorkflowAsset(nested.ref)).path).toBe(nested.path);
    const release = createWorkflowAsset({ name: "release1" });
    await expect(getNextWorkflowStep(release.ref)).resolves.toMatchObject({ autoStarted: true });

    fs.unlinkSync(created.path);
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "local",
      defaultWriteTarget: "local",
      engines: {
        "test-agent": { kind: "agent", platform: "opencode-sdk" },
        "test-llm": {
          kind: "llm",
          endpoint: "http://localhost:1/v1/chat/completions",
          model: "test-model",
        },
      },
      defaults: { engine: "test-agent", llmEngine: "test-llm" },
      workflow: { judgeEngine: "test-llm" },
      bundles: { local: { path: storage.stashDir, writable: true } },
    });
    resetConfigCache();
    expect((await getNextWorkflowStep("native//authored")).run.workflowRef).toBe("native//authored");
    expect((await listWorkflowRuns({ workflowRef: "native//authored" })).runs).toHaveLength(1);
    // Ref -> run-id resolution, asserted through the surviving surface: the
    // CLI resolves the ref itself and must land on the run we started.
    const status = await runCliCapture(["workflow", "status", "native//authored"]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain(started.run.id);
  });

  test.skipIf(process.platform === "win32")(
    "standalone workflow lookup contains symlinks and handles extension case deterministically",
    async () => {
      const workflowRoot = path.join(storage.root, "standalone-workflow-safety");
      const outside = path.join(storage.root, "outside-workflow.md");
      write(workflowRoot, "upper.MD", getWorkflowTemplate());
      write(workflowRoot, "duplicate.md", getWorkflowTemplate());
      write(workflowRoot, "duplicate.MD", getWorkflowTemplate());
      write(storage.root, "outside-workflow.md", getWorkflowTemplate());
      fs.symlinkSync(outside, path.join(workflowRoot, "escape.md"));
      writeSandboxConfig({
        semanticSearchMode: "off",
        defaultBundle: "native",
        defaultWriteTarget: "native",
        bundles: {
          native: {
            path: workflowRoot,
            components: { main: { root: ".", adapter: "akm-workflow", writable: true } },
          },
        },
      });
      resetConfigCache();

      expect((await loadWorkflowAsset("native//upper")).path).toBe(path.join(workflowRoot, "upper.MD"));
      await expect(loadWorkflowAsset("native//escape")).rejects.toMatchObject({ code: "ASSET_NOT_FOUND" });
      await expect(loadWorkflowAsset("native//duplicate")).rejects.toMatchObject({
        code: "RESOURCE_ALREADY_EXISTS",
      });
      // SRC BUG (reported, not fixed — src is frozen for this port):
      // `createWorkflowAsset`'s cross-name-collision guard
      // (`findExistingWorkflowPaths`, pre-unification) was deleted in the
      // workflow-format-unification refactor along with the (correctly
      // removed) cross-FORMAT `.md` vs `.yaml`/`.yml` shadowing check it was
      // bundled with — but no narrower same-extension-different-case guard
      // was preserved for the now markdown-only surface. `createWorkflowAsset`
      // resolves its target path with an exact-case `fs.existsSync` and no
      // longer probes for a same-canonical-name file differing only in
      // extension case, so creating "upper" here (when "upper.MD" already
      // exists in the same directory) no longer throws — it silently writes
      // a second file ("upper.md") that `loadWorkflowAsset`'s case-insensitive
      // lookup can then resolve ambiguously. Left as the real, unweakened
      // intended behavior; it fails today on this gap.
      expect(() => createWorkflowAsset({ name: "upper" })).toThrow(/already exists as/i);
    },
  );

  test("a short ref resolves to its non-default standalone owner", async () => {
    const workflowRoot = path.join(storage.root, "non-default-standalone-workflows");
    write(workflowRoot, "deploy.md", getWorkflowTemplate());
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "local",
      engines: {
        "test-agent": { kind: "agent", platform: "opencode-sdk" },
        "test-llm": {
          kind: "llm",
          endpoint: "http://localhost:1/v1/chat/completions",
          model: "test-model",
        },
      },
      defaults: { engine: "test-agent", llmEngine: "test-llm" },
      workflow: { judgeEngine: "test-llm" },
      bundles: {
        local: {
          path: storage.stashDir,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
        native: {
          path: workflowRoot,
          components: { main: { root: ".", adapter: "akm-workflow", writable: true } },
        },
      },
    });
    resetConfigCache();

    expect((await loadWorkflowAsset("deploy")).ref).toBe("native//deploy");
    const started = await getNextWorkflowStep("deploy");
    expect(started.run.workflowRef).toBe("native//deploy");
    expect((await listWorkflowRuns({ workflowRef: "deploy" })).runs.map((run) => run.id)).toEqual([started.run.id]);
  });

  test("a short workflow ref cannot bypass its first OKF owner", async () => {
    write(okfRoot, "workflows/same.md", getWorkflowTemplate());
    write(storage.stashDir, "workflows/same.md", getWorkflowTemplate());
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "adversarial",
      bundles: {
        adversarial: {
          path: okfRoot,
          components: { main: { root: ".", adapter: "okf", writable: true } },
        },
        local: {
          path: storage.stashDir,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
      },
    });

    await withEnv({ AKM_BUNDLE_DIR: undefined }, async () => {
      resetConfigCache();
      await expect(loadWorkflowAsset("workflows/same")).rejects.toThrow(
        /adapter "okf".*does not support native workflow execution/i,
      );
      expect((await loadWorkflowAsset("local//workflows/same")).path).toBe(
        path.join(storage.stashDir, "workflows", "same.md"),
      );
    });
  });

  test("a bare standalone ref cannot bypass an earlier root-level OKF concept", async () => {
    const workflowRoot = path.join(storage.root, "bare-standalone-owner");
    write(okfRoot, "same.md", "---\ntype: knowledge\n---\n\nNot executable.\n");
    write(okfRoot, "index.md", "# Structural index\n");
    write(workflowRoot, "same.md", getWorkflowTemplate());
    write(workflowRoot, "index.md", getWorkflowTemplate());
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "adversarial",
      bundles: {
        adversarial: {
          path: okfRoot,
          components: { main: { root: ".", adapter: "okf", writable: true } },
        },
        native: {
          path: workflowRoot,
          components: { main: { root: ".", adapter: "akm-workflow", writable: true } },
        },
      },
    });
    resetConfigCache();

    await expect(loadWorkflowAsset("same")).rejects.toThrow(
      /adapter "okf".*does not support native workflow execution/i,
    );
    expect((await loadWorkflowAsset("native//same")).ref).toBe("native//same");
    expect((await loadWorkflowAsset("index")).ref).toBe("native//index");
  });

  test("workflow authoring rejects a default OKF component before touching disk", async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "adversarial",
      bundles: {
        adversarial: {
          path: okfRoot,
          writable: true,
          components: { main: { root: ".", adapter: "okf", writable: true } },
        },
      },
    });

    await withEnv({ AKM_BUNDLE_DIR: undefined }, async () => {
      resetConfigCache();
      expect(() => createWorkflowAsset({ name: "blocked" })).toThrow(
        /adapter "okf".*does not support AKM asset writes/i,
      );
      // workflow-format-unification (spec §3): `createWorkflowAsset` now
      // rejects a ".yaml"/".yml" name UNCONDITIONALLY (workflows are
      // markdown-only) — that check runs before the write-target/adapter is
      // even resolved, so it fires regardless of which adapter owns the
      // configured write target. The write-rejection block above (a plain
      // ".md" name against the OKF adapter) stays byte-equivalent; this
      // second sub-check now pins the (adapter-independent) markdown-only
      // rejection instead of the no-longer-reachable OKF-write-target path.
      expect(() => createWorkflowAsset({ name: "blocked.yaml" })).toThrow(/markdown-only/i);
      expect(fs.existsSync(path.join(okfRoot, "workflows"))).toBe(false);
    });
  });

  test("workflow authoring rejects an OKF defaultWriteTarget", () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "local",
      defaultWriteTarget: "adversarial",
      bundles: {
        local: {
          path: storage.stashDir,
          writable: true,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
        adversarial: {
          path: okfRoot,
          writable: true,
          components: { main: { root: ".", adapter: "okf", writable: true } },
        },
      },
    });
    resetConfigCache();

    expect(() => createWorkflowAsset({ name: "blocked-default-target" })).toThrow(
      /adapter "okf".*does not support AKM asset writes/i,
    );
    expect(fs.existsSync(path.join(okfRoot, "workflows", "blocked-default-target.md"))).toBe(false);
    expect(fs.existsSync(path.join(storage.stashDir, "workflows", "blocked-default-target.md"))).toBe(false);
  });

  test("an implicit OKF working stash rejects native writes", async () => {
    writeSandboxConfig({ semanticSearchMode: "off" });
    await withEnv({ AKM_BUNDLE_DIR: okfRoot }, async () => {
      resetConfigCache();
      await expect(
        writeMarkdownAsset({
          type: "memory",
          content: "Native write must fail.",
          name: "blocked-implicit",
          fallbackPrefix: "memory",
        }),
      ).rejects.toThrow(/adapter "okf".*does not support AKM asset writes/i);
    });
    expect(fs.existsSync(path.join(okfRoot, "memories", "blocked-implicit.md"))).toBe(false);
  });

  test("supersedes never rewrites a read-only OKF working stash", async () => {
    const teamRoot = path.join(storage.root, "team-write-target");
    fs.mkdirSync(teamRoot, { recursive: true });
    const oldPath = path.join(okfRoot, "memories", "old.md");
    write(okfRoot, "memories/old.md", concept("memory", "Old", "Vendor-owned body."));
    const before = fs.readFileSync(oldPath, "utf8");
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "vendor",
      defaultWriteTarget: "team",
      bundles: {
        vendor: {
          path: okfRoot,
          components: { main: { root: ".", adapter: "okf", writable: false } },
        },
        team: { path: teamRoot, components: { main: { root: ".", adapter: "akm", writable: true } } },
      },
    });

    await withEnv({ AKM_BUNDLE_DIR: okfRoot }, async () => {
      resetConfigCache();
      const supersedes = resolveSupersedesForWrite(["vendor//memories/old"], "team");
      expect(supersedes[0]?.writable).toBe(false);
      await writeMarkdownAsset({
        type: "memory",
        content: "Replacement body.",
        name: "replacement",
        fallbackPrefix: "memory",
        target: "team",
        supersedes,
      });
    });

    expect(fs.readFileSync(oldPath, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(teamRoot, "memories", "replacement.md"))).toBe(true);
  });

  test("a nested default component root owns writes, indexing, show, and lint", async () => {
    const packageRoot = path.join(storage.root, "nested-package");
    const componentRoot = path.join(packageRoot, "catalog");
    fs.mkdirSync(componentRoot, { recursive: true });
    writeSandboxConfig({
      defaultBundle: "nested",
      bundles: {
        nested: {
          path: packageRoot,
          writable: true,
          components: { main: { root: "catalog", adapter: "akm", writable: true } },
        },
      },
    });

    await withEnv({ AKM_BUNDLE_DIR: undefined }, async () => {
      resetConfigCache();
      const written = await writeMarkdownAsset({
        type: "memory",
        content: "---\nupdated: 2026-07-25\n---\n\nNested component body.",
        name: "nested-root",
        fallbackPrefix: "memory",
      });

      expect(written.path).toBe(path.join(componentRoot, "memories", "nested-root.md"));
      expect(written.stashDir).toBe(componentRoot);
      expect(fs.existsSync(path.join(packageRoot, "memories", "nested-root.md"))).toBe(false);
      expect(resolveSourceEntries()).toEqual([
        expect.objectContaining({ path: componentRoot, registryId: "nested", adapterId: "akm" }),
      ]);

      await akmIndex({ stashDir: componentRoot, full: true });
      const shown = await showLocal({ ref: "nested//memories/nested-root" });
      expect(shown.content).toContain("Nested component body.");
      expect((await akmLint()).flagged).toEqual([]);
    });
  });
});

function parseType(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  return match?.[1]?.match(/^type:\s*(.+)$/m)?.[1];
}

// ── OKF v0.2 fixture bundle — reads alongside the v0.1 fixture (D1) ──────────
//
// `tests/fixtures/bundles/okf-sample-v2/` exercises the v0.2 trust/provenance
// (`generated`/`verified`/`sources`) and lifecycle (`status`/`stale_after`)
// frontmatter families, plus a root `okf_version`. It must index end-to-end
// exactly like the frozen v0.1 `okf-sample` fixture (byte-identical, untouched
// by this change) — both bundles are OKF, just different spec minor versions.
describe("OKF v0.2 fixture bundle indexes end-to-end alongside the v0.1 fixture", () => {
  let v2Storage: IsolatedAkmStorage;
  const V2_FIXTURE_ROOT = path.join(import.meta.dir, "../fixtures/bundles/okf-sample-v2");

  beforeEach(() => {
    v2Storage = withIsolatedAkmStorage();
    writeSandboxConfig({
      semanticSearchMode: "off",
      defaultBundle: "local",
      bundles: {
        local: {
          path: v2Storage.stashDir,
          writable: true,
          components: { main: { root: ".", adapter: "akm", writable: true } },
        },
        "okf-v2": {
          path: V2_FIXTURE_ROOT,
          writable: true,
          components: { main: { root: ".", adapter: "okf", writable: true } },
        },
      },
    });
  });

  afterEach(() => v2Storage.cleanup());

  test("every non-reserved concept indexes with adapterId=okf; reserved index.md/log.md are excluded", async () => {
    await akmIndex({ stashDir: v2Storage.stashDir, full: true });

    const db = openExistingDatabase(getDbPath());
    try {
      const rows = db
        .prepare(
          "SELECT item_ref AS itemRef, adapter_id AS adapterId, document_json AS documentJson " +
            "FROM entries WHERE bundle_id = 'okf-v2' ORDER BY item_ref",
        )
        .all() as Array<{ itemRef: string; adapterId: string; documentJson: string }>;

      expect(rows.map((row) => row.itemRef)).toEqual([
        "okf-v2//reports/draft-note",
        "okf-v2//reports/legacy",
        "okf-v2//reports/quarterly",
      ]);
      expect(rows.every((row) => row.adapterId === "okf")).toBe(true);

      const byRef = new Map(rows.map((row) => [row.itemRef, JSON.parse(row.documentJson) as Record<string, unknown>]));

      // Full v0.2 family: generated + verified (list form) + object-list sources + status + stale_after.
      const quarterly = byRef.get("okf-v2//reports/quarterly") as {
        updated?: string;
        provenance?: {
          generatedBy?: string;
          generatedAt?: string;
          verified?: Array<{ by: string; at?: string }>;
          sources?: Array<{ resource: string }>;
        };
        lifecycleStatus?: string;
        staleAfter?: string;
      };
      expect(quarterly.updated).toBe("2026-06-20T22:53:05Z");
      expect(quarterly.provenance?.generatedBy).toBe("reference_agent/gemini-2.5-pro");
      expect(quarterly.provenance?.generatedAt).toBe("2026-06-20T22:53:05Z");
      expect(quarterly.provenance?.verified).toEqual([
        { by: "human:ahormati", at: "2026-06-25T09:00:00Z" },
        { by: "process:finance-nightly", at: "2026-06-26T03:00:00Z" },
      ]);
      expect(quarterly.provenance?.sources).toEqual([
        expect.objectContaining({ resource: "https://example.com/data/q3-export.csv", id: "main-dataset" }),
        expect.objectContaining({ resource: "gs://acme-bucket/q3/events.parquet" }),
      ]);
      expect(quarterly.lifecycleStatus).toBe("stable");
      expect(quarterly.staleAfter).toBe("2026-12-31");

      // verified SINGLE-MAPPING form normalizes to a one-element array.
      const draft = byRef.get("okf-v2//reports/draft-note") as {
        provenance?: { verified?: Array<{ by: string; at?: string }> };
        lifecycleStatus?: string;
      };
      expect(draft.provenance?.verified).toEqual([{ by: "human:ahormati", at: "2026-06-18T00:05:00Z" }]);
      expect(draft.lifecycleStatus).toBe("draft");

      // Legacy v0.1-style note (no `generated` family) still falls back to `timestamp`.
      const legacy = byRef.get("okf-v2//reports/legacy") as { updated?: string; provenance?: unknown };
      expect(legacy.updated).toBe("2026-05-01T00:00:00Z");
      expect(legacy.provenance).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });

  test("show accepts the path-derived ref for a v0.2 concept", async () => {
    await akmIndex({ stashDir: v2Storage.stashDir, full: true });
    const shown = await showLocal({ ref: "okf-v2//reports/quarterly" });
    expect(shown.content).toContain("Q3 Rollup");
  });
});
