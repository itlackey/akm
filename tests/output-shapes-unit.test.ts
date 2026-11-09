import { describe, expect, test } from "bun:test";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { resolveOutputMode } from "../src/output/context";
import { shapeForCommand } from "../src/output/shapes";
import {
  capDescription,
  pickFields,
  shapeProposalAcceptOutput,
  shapeProposalDiffOutput,
  shapeProposalEntry,
  shapeProposalListOutput,
  shapeProposalRejectOutput,
  shapeProposalShowOutput,
  shapeSearchHit,
  shapeSearchOutput,
  shapeShowOutput,
  truncateDescription,
} from "../src/output/shapes/helpers";
import { formatPlain } from "../src/output/text";

describe("pickFields", () => {
  test("returns only requested fields, in the requested order", () => {
    const source = { a: 1, b: 2, c: 3, d: 4 };
    expect(pickFields(source, ["b", "d"])).toEqual({ b: 2, d: 4 });
  });

  test("omits fields that are absent", () => {
    expect(pickFields({ a: 1 }, ["a", "b"])).toEqual({ a: 1 });
  });

  test("omits fields whose value is undefined", () => {
    expect(pickFields({ a: 1, b: undefined }, ["a", "b"])).toEqual({ a: 1 });
  });

  test("preserves null values explicitly", () => {
    expect(pickFields({ a: 1, b: null }, ["a", "b"])).toEqual({ a: 1, b: null });
  });
});

describe("command dry-run output shape", () => {
  test("registers the already-safe canonical envelope without reshaping it", () => {
    const result = {
      schemaVersion: 1,
      shape: "command-dry-run",
      ok: true,
      dryRun: true,
      engine: "reviewer",
      provenance: [{ field: "engine", layer: "installation-defaults", kind: "installation", via: "explicit" }],
      notices: [],
    };

    expect(shapeForCommand("command-dry-run", result, "full")).toEqual(result);
  });
});

describe("truncateDescription", () => {
  test("returns short descriptions unchanged", () => {
    expect(truncateDescription("hello", 100)).toBe("hello");
  });

  test("collapses whitespace", () => {
    expect(truncateDescription("hello   world\n\nagain", 100)).toBe("hello world again");
  });

  test("truncates to a word boundary when possible", () => {
    const long = "the quick brown fox jumps over the lazy dog repeatedly";
    const result = truncateDescription(long, 25);
    // Body is up to limit-1 chars; `...` is appended → realistic max = limit+2.
    expect(result.length).toBeLessThanOrEqual(25 + 2);
    expect(result.endsWith("...")).toBe(true);
    // Should not split on a word
    const beforeEllipsis = result.slice(0, -3).trimEnd();
    expect(long).toContain(beforeEllipsis);
  });

  test("falls back to hard truncation when no word boundary is reasonable", () => {
    const noSpaces = "x".repeat(40);
    const result = truncateDescription(noSpaces, 10);
    expect(result.length).toBeLessThanOrEqual(10 + 2);
    expect(result.endsWith("...")).toBe(true);
  });
});

describe("capDescription", () => {
  test("caps a long description", () => {
    const hit = { name: "x", description: "a".repeat(500) };
    const capped = capDescription(hit, 100);
    // truncateDescription appends `...`, so the resulting body is up to limit+2.
    expect((capped.description as string).length).toBeLessThanOrEqual(100 + 2);
    expect(capped.name).toBe("x");
  });

  test("leaves a short description alone", () => {
    const hit = { name: "x", description: "short" };
    expect(capDescription(hit, 100)).toEqual({ name: "x", description: "short" });
  });

  test("ignores hits without a string description", () => {
    const hit = { name: "x", description: 42 as unknown };
    expect(capDescription(hit, 100)).toEqual(hit);
  });
});

describe("shapeSearchHit — local stash hits", () => {
  const fullHit = {
    type: "skill",
    name: "deploy",
    description: "Deploy the app",
    ref: "skills/deploy",
    itemRef: "team//skills/deploy",
    action: "akm show skills/deploy",
    score: 0.42,
    estimatedTokens: 120,
    origin: "local:.",
    tags: ["ops"],
    whyMatched: "name match",
  };

  test("brief keeps only type/name/ref/action/estimatedTokens", () => {
    // ref is included at brief so agents can run `akm show <ref>`
    expect(shapeSearchHit(fullHit, "brief")).toEqual({
      type: "skill",
      name: "deploy",
      ref: "skills/deploy",
      action: "akm show skills/deploy",
      estimatedTokens: 120,
    });
  });

  test("normal adds ref, description and score (and caps description)", () => {
    const out = shapeSearchHit(fullHit, "normal");
    expect(out).toMatchObject({
      type: "skill",
      name: "deploy",
      description: "Deploy the app",
      action: "akm show skills/deploy",
      score: 0.42,
      estimatedTokens: 120,
      ref: "skills/deploy",
    });
    expect(out).not.toHaveProperty("origin");
    expect(out).not.toHaveProperty("tags");
    expect(out).not.toHaveProperty("itemRef");
  });

  test("full passes the hit through verbatim, including the durable itemRef", () => {
    expect(shapeSearchHit(fullHit, "full")).toEqual(fullHit);
    expect(shapeSearchHit(fullHit, "full")).toHaveProperty("itemRef", "team//skills/deploy");
  });
});

describe("shapeSearchHit — registry hits", () => {
  // Registry hits carry no `curated` boolean. They may surface optional
  // `warnings` when a provider has non-fatal issues.
  const registryHit = {
    type: "registry",
    name: "azure-ops",
    description: "Azure ops kit",
    action: "akm bundle add npm:azure-ops",
    installRef: "npm:azure-ops",
    warnings: ["registry rate limit hit, results may be stale"],
    id: "npm:azure-ops",
    score: 0.7,
  };

  test("brief is exactly name + installRef + score (QA #28)", () => {
    // Brief carries the install ref so callers can act without --detail full.
    const result = shapeSearchHit(registryHit, "brief");
    expect(result).toEqual({ name: "azure-ops", installRef: "npm:azure-ops", score: 0.7 });
    // action is not in brief output — use installRef to act
    expect(result).not.toHaveProperty("curated");
    // brief intentionally omits warnings to keep payloads small
    expect(result).not.toHaveProperty("warnings");
  });

  test("normal adds description and surfaces optional warnings", () => {
    const out = shapeSearchHit(registryHit, "normal");
    expect(out).toMatchObject({
      name: "azure-ops",
      description: "Azure ops kit",
      action: "akm bundle add npm:azure-ops",
      installRef: "npm:azure-ops",
      warnings: ["registry rate limit hit, results may be stale"],
    });
    expect(out).not.toHaveProperty("curated");
  });

  test("full passes through and never re-adds curated", () => {
    const out = shapeSearchHit(registryHit, "full");
    expect(out).toEqual(registryHit);
    expect(out).not.toHaveProperty("curated");
  });

  test("the text renderer prints the install ref at normal detail", () => {
    const shaped = shapeForCommand("search", { hits: [], registryHits: [registryHit] }, "normal");
    expect(formatPlain("search", shaped, "normal")).toContain("installRef: npm:azure-ops");
  });
});

describe("shapeShowOutput", () => {
  const fullShow = {
    type: "skill",
    name: "deploy",
    ref: "team//skills/deploy",
    path: "/tmp/team/skills/deploy/SKILL.md",
    editable: false,
    editHint: "Inspect with akm show team//skills/deploy",
    description: "Deploy",
    action: "akm show skills/deploy",
    content: "long body...",
    template: "tpl",
    cwd: "/tmp",
    extra: "should-not-appear",
  };

  test("show at full picks the show field set + adds schemaVersion", () => {
    const out = shapeShowOutput(fullShow, "full");
    expect(out.schemaVersion).toBe(1);
    expect(out).toMatchObject({
      type: "skill",
      name: "deploy",
      description: "Deploy",
      content: "long body...",
      template: "tpl",
      cwd: "/tmp",
    });
    // `extra` was not in the picked field set, even at full.
    expect(out).not.toHaveProperty("extra");
  });

  test("show at brief omits schemaVersion (only added at full)", () => {
    const out = shapeShowOutput(fullShow, "brief");
    expect(out).not.toHaveProperty("schemaVersion");
    expect(out.name).toBe("deploy");
  });

  // `ref` is the canonical identity of the shown asset and must be present in
  // EVERY show detail level.
  test("ref is present in show at every detail level", () => {
    expect(shapeShowOutput(fullShow, "brief").ref).toBe("team//skills/deploy");
    expect(shapeShowOutput(fullShow, "normal").ref).toBe("team//skills/deploy");
    expect(shapeShowOutput(fullShow, "full").ref).toBe("team//skills/deploy");
  });

  test("fragment provenance and context status survive every show shape", () => {
    const fragmentShow = {
      ...fullShow,
      selectedRef: "team//skills/deploy#akm-fragment-2-abc",
      parentRef: "team//skills/deploy",
      fragmentOrdinal: 2,
      fragmentCount: 3,
      startLine: 12,
      endLine: 18,
      fragmentChars: 200,
      fragmentEstimatedTokens: 50,
      parentChars: 1200,
      parentEstimatedTokens: 300,
      contextMode: "lead",
      contextMaxChars: 800,
      contextTruncated: true,
    };

    expect(shapeShowOutput(fragmentShow, "normal")).toMatchObject({
      selectedRef: fragmentShow.selectedRef,
      parentRef: fragmentShow.parentRef,
      fragmentOrdinal: 2,
      contextMode: "lead",
      contextMaxChars: 800,
      contextTruncated: true,
    });
  });

  test("toc survives every show shape and detail level", () => {
    const toc = [{ level: 2, text: "Install", slug: "install", startLine: 3 }];
    for (const detail of ["brief", "normal", "full"] as const) {
      expect(shapeShowOutput({ ...fullShow, toc }, detail).toc).toEqual(toc);
    }
  });

  // `path` and `editable` are projected at every --detail level, not
  // gated behind --detail full — only `schemaVersion`/`editHint` are full-only.
  test("path and editable are present in show at --detail brief (not full-gated)", () => {
    const out = shapeShowOutput(fullShow, "brief");
    expect(out.path).toBe("/tmp/team/skills/deploy/SKILL.md");
    expect(out.editable).toBe(false);
    expect(out).not.toHaveProperty("schemaVersion");
  });
});

describe("shapeForCommand", () => {
  test("routes search results through shapeSearchOutput", () => {
    const out = shapeForCommand(
      "search",
      { hits: [{ type: "skill", name: "x", action: "a", estimatedTokens: 1 }], registryHits: [] },
      "brief",
    ) as Record<string, unknown>;
    expect(Array.isArray(out.results)).toBe(true);
    expect(out).not.toHaveProperty("hits");
    expect((out.results as unknown[])[0]).toEqual({
      type: "skill",
      name: "x",
      action: "a",
      estimatedTokens: 1,
    });
  });

  test("routes show results through shapeShowOutput at full", () => {
    const out = shapeForCommand(
      "show",
      { type: "skill", name: "deploy", action: "a", extra: "drop me" },
      "full",
    ) as Record<string, unknown>;
    expect(out).not.toHaveProperty("extra");
  });

  test("non-search/show commands pass through unmodified", () => {
    // "info" and "health" are passthrough commands (#484: see
    // tests/output-passthrough-envelope.test.ts), so they get a
    // shape/schemaVersion stamp — this test's job is only to confirm they
    // are NOT routed through the search/show shapers (whose field-dropping
    // behavior is asserted by the two tests above), so the original fields
    // besides the stamp survive untouched.
    const result = { something: "untouched" };
    expect(shapeForCommand("info", result, "full")).toMatchObject(result);
    expect(shapeForCommand("health", result, "full")).toMatchObject(result);
  });
});

describe("shapeSearchOutput", () => {
  test("respects detail level for hits", () => {
    const result = {
      hits: [{ type: "skill", name: "x", action: "a", estimatedTokens: 1, description: "desc" }],
      registryHits: [],
    };
    const brief = shapeSearchOutput(result, "brief") as { results: Record<string, unknown>[] };
    const normal = shapeSearchOutput(result, "normal") as { results: Record<string, unknown>[] };
    expect((brief.results[0] as Record<string, unknown>).description).toBeUndefined();
    expect((normal.results[0] as Record<string, unknown>).description).toBe("desc");
  });
});

describe("curate field sets", () => {
  const item = {
    source: "stash",
    type: "knowledge",
    name: "guide",
    ref: "team//knowledge/guide",
    path: "/tmp/team/knowledge/guide.md",
    editable: true,
    editHint: "stale",
    id: "guide",
    description: "Guide",
    preview: "body",
    keys: ["K"],
    parameters: [{ name: "p" }],
    run: "bash x",
    supportRefs: [],
    beliefState: "active",
    followUp: "akm show team//knowledge/guide",
    reason: "r",
    score: 0.5,
  };
  const curate = (detail: "brief" | "normal" | "full") =>
    (shapeForCommand("curate", { query: "q", summary: "s", items: [item] }, detail) as { results: object[] })
      .results[0] as Record<string, unknown>;

  test("normal is the field set `--detail agent` used to return", () => {
    expect(Object.keys(curate("normal")).sort()).toEqual(
      [
        "source",
        "type",
        "name",
        "ref",
        "path",
        "editable",
        "id",
        "description",
        "supportRefs",
        "beliefState",
        "followUp",
        "reason",
        "score",
      ].sort(),
    );
  });

  test("brief keeps the refs and followUp; full keeps everything", () => {
    expect(Object.keys(curate("brief")).sort()).toEqual(
      ["source", "type", "name", "ref", "id", "supportRefs", "beliefState", "followUp", "reason"].sort(),
    );
    expect(curate("full")).toEqual(item);
  });

  test("the list key is `results`, never `items`", () => {
    const out = shapeForCommand("curate", { query: "q", summary: "s", items: [item] }, "normal") as Record<
      string,
      unknown
    >;
    expect(out).toHaveProperty("results");
    expect(out).not.toHaveProperty("items");
  });
});

describe("curate normal access projection", () => {
  test("local items include access fields while registry-only items have no path", () => {
    const out = shapeForCommand(
      "curate",
      {
        query: "deploy",
        summary: "Selected two",
        items: [
          {
            source: "stash",
            type: "knowledge",
            name: "guide",
            ref: "team//knowledge/guide",
            path: "/tmp/team/knowledge/guide.md",
            editable: false,
            editHint: "Inspect with akm show team//knowledge/guide",
            followUp: "akm show team//knowledge/guide",
            reason: "Useful guide",
          },
          {
            source: "registry",
            type: "registry",
            name: "deploy-kit",
            id: "deploy-kit",
            followUp: "akm bundle add deploy-kit",
            reason: "External kit",
          },
        ],
      },
      "normal",
    ) as { results: Record<string, unknown>[] };

    expect(out.results[0]).toMatchObject({
      ref: "team//knowledge/guide",
      path: "/tmp/team/knowledge/guide.md",
      editable: false,
      editHint: "Inspect with akm show team//knowledge/guide",
    });
    expect(out.results[1]).not.toHaveProperty("path");
    expect(out.results[1]).not.toHaveProperty("editable");
  });

  test("brief preserves merged semantic fallback mode and warning", () => {
    const out = shapeForCommand(
      "curate",
      {
        query: "deploy",
        summary: "Selected zero",
        items: [],
        searchMode: "fts-fallback",
        warnings: ["Vector search unavailable — falling back to keyword search."],
      },
      "brief",
    );

    expect(out).toMatchObject({
      searchMode: "fts-fallback",
      warnings: ["Vector search unavailable — falling back to keyword search."],
    });
  });
});

// ── Output-shape registry exhaustiveness (#274) ─────────────────────────────

describe("shapeForCommand: unknown command", () => {
  test("throws with the command name in the message instead of silently passing the result through", () => {
    // The output shape registry is exhaustive. A missing case is a registration
    // bug (there is no silent JSON.stringify fallback). The throw must include the
    // unknown command name so the caller / test sees the missing registration.
    expect(() => shapeForCommand("definitely-not-a-real-command", { foo: "bar" }, "normal")).toThrow(
      "output shape not registered for command: definitely-not-a-real-command",
    );
  });
});

// ── #1476: list-returning commands carry no duplicated `results` alias ──

describe("shapeForCommand — no `results` collection alias (#1476)", () => {
  // command -> [collection key, minimal valid raw result]
  const LIST_COMMANDS: Array<[string, string, Record<string, unknown>]> = [
    ["search", "results", { hits: [{ type: "skill", name: "x", action: "a" }], registryHits: [] }],
    ["curate", "results", { items: [{ type: "skill", name: "x" }], query: "q", summary: "s" }],
    ["proposal-list", "proposals", { totalCount: 1, proposals: [{ id: "p1", ref: "lessons/x", status: "pending" }] }],
    ["list", "sources", { sources: [{ name: "b1" }] }],
    ["env-list", "envs", { envs: [{ name: "e1" }] }],
    ["secret-list", "secrets", { secrets: [{ name: "s1" }] }],
    ["registry-list", "registries", { registries: [{ name: "r1" }] }],
    ["workflow-list", "runs", { runs: [{ id: "w1" }] }],
    ["task-history", "rows", { rows: [{ id: "t1" }] }],
    ["log-list", "events", { events: [{ eventType: "add", ref: "lessons/x", ts: "2024-01-01T00:00:00Z" }] }],
    ["config-diff", "rows", { rows: [{ path: "semanticSearchMode", local: "off", other: "auto" }] }],
  ];

  for (const [command, key, raw] of LIST_COMMANDS) {
    test(`akm ${command} has \`${key}\`${key === "results" ? " and no `hits` or `items`" : " and no `results`"}`, () => {
      const out = shapeForCommand(command, raw, "normal") as Record<string, unknown>;
      expect(Array.isArray(out[key])).toBe(true);
      if (key === "results") {
        expect(out).not.toHaveProperty("hits");
        expect(out).not.toHaveProperty("items");
      } else {
        expect(out).not.toHaveProperty("results");
      }
    });
  }
});

// ── #284: shapeProposal* — proposal commands ───────────────────────────────

describe("shapeProposal* — proposal commands", () => {
  const fullProposal: Record<string, unknown> = {
    id: "uuid-1",
    ref: "lessons/rg-over-grep",
    status: "pending",
    source: "reflect",
    sourceRun: "run-7",
    createdAt: "2026-04-27T00:00:00Z",
    updatedAt: "2026-04-27T00:00:01Z",
    payload: { content: "BODY", frontmatter: { description: "d" } },
    review: undefined,
  };

  test("shapeProposalEntry brief drops payload + sourceRun", () => {
    const out = shapeProposalEntry(fullProposal, "brief");
    expect(out).toEqual({
      id: "uuid-1",
      ref: "lessons/rg-over-grep",
      status: "pending",
      source: "reflect",
      createdAt: "2026-04-27T00:00:00Z",
    });
    expect(out).not.toHaveProperty("payload");
    expect(out).not.toHaveProperty("sourceRun");
  });

  test("shapeProposalEntry normal keeps metadata + sourceRun + updatedAt; still drops payload", () => {
    const out = shapeProposalEntry(fullProposal, "normal");
    expect(out).toMatchObject({
      id: "uuid-1",
      ref: "lessons/rg-over-grep",
      status: "pending",
      source: "reflect",
      sourceRun: "run-7",
      createdAt: "2026-04-27T00:00:00Z",
      updatedAt: "2026-04-27T00:00:01Z",
    });
    expect(out).not.toHaveProperty("payload");
  });

  test("shapeProposalEntry full keeps payload", () => {
    const out = shapeProposalEntry(fullProposal, "full");
    expect(out).toHaveProperty("payload");
    expect((out.payload as Record<string, unknown>).content).toBe("BODY");
  });

  // A consolidate retire proposal's payload.content is empty by design (it
  // deletes, it does not write) — `retirement` is the field a reviewer needs
  // instead, so it must survive shaping at normal AND full, the same way
  // confidence/gateDecision already do.
  const retireProposal: Record<string, unknown> = {
    ...fullProposal,
    source: "consolidate-pair",
    retirement: {
      retiredRef: "memories/old-note",
      successorRef: "memories/new-note",
      cosine: 0.94,
      judgeLabel: "duplicate",
      judgeReason: "same durable facts",
      retiredContentHash: "a".repeat(64),
      successorContentHash: "b".repeat(64),
      reason: "duplicate",
    },
    retiredArchive: { dirs: [".akm/memory-cleanup/archive/x"] },
    promotionSource: "memories/some-source",
    promotionSourceHash: "c".repeat(64),
  };

  test("shapeProposalEntry normal keeps retirement; drops retiredArchive/promotionSource(Hash)", () => {
    const out = shapeProposalEntry(retireProposal, "normal");
    expect(out.retirement).toEqual(retireProposal.retirement as Record<string, unknown>);
    expect(out).not.toHaveProperty("retiredArchive");
    expect(out).not.toHaveProperty("promotionSource");
    expect(out).not.toHaveProperty("promotionSourceHash");
  });

  test("shapeProposalEntry full keeps retirement, retiredArchive and promotionSource(Hash)", () => {
    const out = shapeProposalEntry(retireProposal, "full");
    expect(out.retirement).toEqual(retireProposal.retirement as Record<string, unknown>);
    expect(out.retiredArchive).toEqual(retireProposal.retiredArchive as Record<string, unknown>);
    expect(out.promotionSource).toBe("memories/some-source");
    expect(out.promotionSourceHash).toBe("c".repeat(64));
  });

  test("shapeProposalEntry brief drops retirement — brief is id/ref/status/source/createdAt only", () => {
    const out = shapeProposalEntry(retireProposal, "brief");
    expect(out).not.toHaveProperty("retirement");
    expect(out).not.toHaveProperty("continuityRisk"); // this fixture is not flagged
  });

  test("shapeProposalEntry brief projects a minimal continuityRisk marker for a flagged retire proposal", () => {
    // `proposal list`'s DEFAULT detail level is "brief" (no --detail flag
    // given projects here) — retirement itself is not restored until
    // "normal", so without this marker a flagged proposal would be
    // indistinguishable from a clean one in the default listing.
    const flagged: Record<string, unknown> = {
      ...retireProposal,
      retirement: {
        ...(retireProposal.retirement as Record<string, unknown>),
        continuityRisk: { failingQueries: 1, ranks: [{ query: "q", retiredRank: 1, successorRank: null }] },
      },
    };
    const out = shapeProposalEntry(flagged, "brief");
    expect(out.continuityRisk).toBe(true);
    expect(out).not.toHaveProperty("retirement"); // still brief otherwise — no other retirement field leaks through
  });

  test("shapeProposalListOutput shapes nested proposals + carries totalCount", () => {
    const result = { schemaVersion: 1, totalCount: 2, proposals: [fullProposal, fullProposal] };
    const brief = shapeProposalListOutput(result, "brief");
    expect(brief.totalCount).toBe(2);
    expect(Array.isArray(brief.proposals)).toBe(true);
    const list = brief.proposals as Record<string, unknown>[];
    expect(list).toHaveLength(2);
    expect(list[0]).not.toHaveProperty("payload");
    // full level adds schemaVersion
    const full = shapeProposalListOutput(result, "full");
    expect(full.schemaVersion).toBe(1);
  });

  test("shapeProposalShowOutput surfaces validation alongside the entry", () => {
    const validation = { ok: true, findings: [] };
    const out = shapeProposalShowOutput({ schemaVersion: 1, proposal: fullProposal, validation }, "normal");
    expect(out.validation).toEqual(validation);
    expect((out.proposal as Record<string, unknown>).ref).toBe("lessons/rg-over-grep");
    expect(out).not.toHaveProperty("schemaVersion");
    // full adds schemaVersion
    const full = shapeProposalShowOutput({ schemaVersion: 1, proposal: fullProposal, validation }, "full");
    expect(full.schemaVersion).toBe(1);
  });

  test("shapeProposalAcceptOutput projects ok+id+ref+assetPath at every detail", () => {
    const result = {
      schemaVersion: 1,
      ok: true,
      id: "uuid-1",
      ref: "lessons/rg-over-grep",
      assetPath: "/tmp/stash/lessons/rg.md",
      proposal: fullProposal,
    };
    for (const detail of ["brief", "normal", "full"] as const) {
      const out = shapeProposalAcceptOutput(result, detail);
      expect(out.ok).toBe(true);
      expect(out.id).toBe("uuid-1");
      expect(out.ref).toBe("lessons/rg-over-grep");
      expect(out.assetPath).toBe("/tmp/stash/lessons/rg.md");
    }
  });

  test("shapeProposalRejectOutput threads `reason` only when present", () => {
    const withReason = shapeProposalRejectOutput(
      { schemaVersion: 1, ok: true, id: "uuid-1", ref: "lessons/x", reason: "duplicate", proposal: fullProposal },
      "normal",
    );
    expect(withReason.reason).toBe("duplicate");
    const withoutReason = shapeProposalRejectOutput(
      { schemaVersion: 1, ok: true, id: "uuid-1", ref: "lessons/x", proposal: fullProposal },
      "normal",
    );
    expect(withoutReason).not.toHaveProperty("reason");
  });

  test("shapeProposalDiffOutput projects id/ref/isNew/unified", () => {
    const result = {
      schemaVersion: 1,
      id: "uuid-1",
      ref: "lessons/x",
      isNew: true,
      unified: "--- /dev/null\n+++ a\n",
      targetPath: "/tmp/x",
    };
    const brief = shapeProposalDiffOutput(result, "brief");
    expect(brief).toMatchObject({ id: "uuid-1", isNew: true, targetPath: "/tmp/x" });
    expect(brief).not.toHaveProperty("schemaVersion");
    const full = shapeProposalDiffOutput(result, "full");
    expect(full.schemaVersion).toBe(1);
  });

  test("shapeProposalDiffOutput carries a retirement's op, verdict and note at every detail level (#997)", () => {
    const result = {
      schemaVersion: 1,
      id: "uuid-1",
      ref: "stash//memories/old",
      isNew: false,
      unified: "--- x (existing)\n+++ /dev/null (retired: archived; successor memories/new)\n@@ 1,1 0,0 @@\n-body",
      op: "delete",
      retirement: {
        retiredRef: "memories/old",
        successorRef: "memories/new",
        judgeLabel: "duplicate",
        judgeReason: "same facts",
        cosine: 0.98,
        continuityRisk: { failingQueries: 1, ranks: [{ query: "q", retiredRank: 1, successorRank: null }] },
      },
      note: "Accepting archives the retired file.",
    };
    for (const detail of ["brief", "normal", "full"] as const) {
      expect(shapeProposalDiffOutput(result, detail)).toMatchObject({
        op: "delete",
        retirement: result.retirement,
        note: result.note,
      });
    }
    // An ordinary diff result stays exactly as it was: no retirement keys appear.
    const ordinary = shapeProposalDiffOutput(
      { schemaVersion: 1, id: "uuid-1", ref: "r", isNew: true, unified: "+" },
      "full",
    );
    expect(ordinary).not.toHaveProperty("op");
    expect(ordinary).not.toHaveProperty("retirement");
    expect(ordinary).not.toHaveProperty("note");
  });

  test("shapeProposalEntry projects reviewHistory from `normal` up, never in brief (#997)", () => {
    const reopened = {
      ...fullProposal,
      reviewHistory: [
        {
          review: { outcome: "rejected", reason: "no", decidedAt: "2026-04-27T00:00:00Z" },
          reopenedAt: "2026-04-28T00:00:00Z",
        },
      ],
    };
    expect(shapeProposalEntry(reopened, "brief")).not.toHaveProperty("reviewHistory");
    expect(shapeProposalEntry(reopened, "normal")).toHaveProperty("reviewHistory", reopened.reviewHistory);
    expect(shapeProposalEntry(reopened, "full")).toHaveProperty("reviewHistory", reopened.reviewHistory);
  });

  test("proposal-reopen shapes like a reject envelope; the batch is a passthrough", () => {
    const reopened = shapeForCommand(
      "proposal-reopen",
      { schemaVersion: 1, ok: true, id: "uuid-1", ref: "lessons/x", reason: "second look", proposal: fullProposal },
      "brief",
    ) as Record<string, unknown>;
    expect(reopened).toMatchObject({ ok: true, id: "uuid-1", ref: "lessons/x", reason: "second look" });
    expect((reopened.proposal as Record<string, unknown>).status).toBe("pending");
    const batch = shapeForCommand(
      "proposal-reopen-batch",
      { reopened: 1, results: [{ id: "uuid-1" }] },
      "brief",
    ) as Record<string, unknown>;
    expect(batch).toMatchObject({ ok: true, reopened: 1, shape: "proposal-reopen-batch", schemaVersion: 1 });
  });

  test("shapeForCommand routes proposal-* arms through their dedicated shapers", () => {
    const list = shapeForCommand(
      "proposal-list",
      { schemaVersion: 1, totalCount: 1, proposals: [fullProposal] },
      "brief",
    ) as Record<string, unknown>;
    expect(list.totalCount).toBe(1);
    const show = shapeForCommand(
      "proposal-show",
      { schemaVersion: 1, proposal: fullProposal, validation: { ok: true, findings: [] } },
      "normal",
    ) as Record<string, unknown>;
    expect((show.proposal as Record<string, unknown>).ref).toBe("lessons/rg-over-grep");
    const accept = shapeForCommand(
      "proposal-accept",
      {
        schemaVersion: 1,
        ok: true,
        id: "uuid-1",
        ref: "lessons/x",
        assetPath: "/tmp/x",
        proposal: fullProposal,
      },
      "brief",
    ) as Record<string, unknown>;
    expect(accept.assetPath).toBe("/tmp/x");
    const reject = shapeForCommand(
      "proposal-reject",
      { schemaVersion: 1, ok: true, id: "uuid-1", ref: "lessons/x", proposal: fullProposal },
      "brief",
    ) as Record<string, unknown>;
    expect(reject.id).toBe("uuid-1");
    const diff = shapeForCommand(
      "proposal-diff",
      { schemaVersion: 1, id: "uuid-1", ref: "lessons/x", isNew: true, unified: "+++" },
      "brief",
    ) as Record<string, unknown>;
    expect(diff.isNew).toBe(true);
    // There is no "reflect" shape registration: `akm reflect` has no standalone
    // CLI verb and no `output("reflect", ...)` call site (reflect.ts is an
    // internal function the improve loop calls directly). "proposal-new" (`akm
    // proposal new`) shares the same producer-shape handler and IS a live CLI
    // verb (src/commands/proposal/propose-cli.ts), so it covers this registry
    // path.
    const propose = shapeForCommand(
      "proposal-new",
      { schemaVersion: 2, ok: true, ref: "lessons/x", proposal: fullProposal, engine: "p", durationMs: 1 },
      "normal",
    ) as Record<string, unknown>;
    expect(propose.ok).toBe(true);
  });
});

describe("--detail", () => {
  test("an unknown value (including the retired `agent`) warns once and uses normal", () => {
    const lines: string[] = [];
    _resetWarnOnceForTests();
    _setWarnSinkForTests((_level, args) => lines.push(args.join(" ")));
    try {
      expect(resolveOutputMode(["--detail", "agent"], { detail: "full" })).toEqual({
        format: "json",
        detail: "normal",
      });
      expect(resolveOutputMode(["--detail=agent"])).toMatchObject({ detail: "normal" });
      expect(resolveOutputMode(["--detail", "huge"])).toMatchObject({ detail: "normal" });
    } finally {
      _setWarnSinkForTests();
    }
    expect(lines.filter((line) => line.includes('"agent"'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('"huge"'))).toHaveLength(1);
  });

  test("brief, normal and full are accepted and the config default applies without a flag", () => {
    expect(resolveOutputMode(["--detail=full"])).toMatchObject({ detail: "full" });
    expect(resolveOutputMode([], { detail: "normal" })).toMatchObject({ detail: "normal" });
  });
});
