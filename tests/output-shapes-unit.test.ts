import { describe, expect, test } from "bun:test";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { shapeForCommand } from "../src/output/shapes";
import {
  capDescription,
  pickFields,
  shapeAssetHit,
  shapeProposalAcceptOutput,
  shapeProposalDiffOutput,
  shapeProposalEntry,
  shapeProposalListOutput,
  shapeProposalRejectOutput,
  shapeProposalShowOutput,
  shapeRegistrySearchOutput,
  shapeSearchHit,
  shapeSearchHitForAgent,
  shapeSearchOutput,
  shapeShowOutput,
  truncateDescription,
} from "../src/output/shapes/helpers";

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
    action: "akm show skills/deploy",
    score: 0.42,
    estimatedTokens: 120,
    origin: "local:.",
    tags: ["ops"],
    whyMatched: "name match",
  };

  test("brief keeps only type/name/ref/action/estimatedTokens", () => {
    // REC-03: ref is now included at brief so agents can run `akm show <ref>`
    expect(shapeSearchHit(fullHit, "brief")).toEqual({
      type: "skill",
      name: "deploy",
      ref: "skills/deploy",
      action: "akm show skills/deploy",
      estimatedTokens: 120,
    });
  });

  test("normal adds description and score (and caps description)", () => {
    const out = shapeSearchHit(fullHit, "normal");
    expect(out).toMatchObject({
      type: "skill",
      name: "deploy",
      description: "Deploy the app",
      action: "akm show skills/deploy",
      score: 0.42,
      estimatedTokens: 120,
    });
    expect(out).not.toHaveProperty("ref");
    expect(out).not.toHaveProperty("origin");
    expect(out).not.toHaveProperty("tags");
  });

  test("full passes the hit through verbatim", () => {
    expect(shapeSearchHit(fullHit, "full")).toEqual(fullHit);
  });

  // Issue #856: matchStage reports which stage of the progressive AND->OR
  // lexical ladder produced the hit ("exact" | "prefix" | "relaxed").
  describe("matchStage", () => {
    const hitWithStage = { ...fullHit, matchStage: "relaxed" as const };

    test("brief omits matchStage", () => {
      expect(shapeSearchHit(hitWithStage, "brief")).not.toHaveProperty("matchStage");
    });

    test("normal surfaces matchStage when present", () => {
      const out = shapeSearchHit(hitWithStage, "normal");
      expect(out.matchStage).toBe("relaxed");
    });

    test("normal omits matchStage when absent from the hit", () => {
      const out = shapeSearchHit(fullHit, "normal");
      expect(out).not.toHaveProperty("matchStage");
    });

    test("full passes matchStage through verbatim", () => {
      expect(shapeSearchHit(hitWithStage, "full")).toEqual(hitWithStage);
    });
  });

  test("fragment provenance survives brief, normal, and agent projections", () => {
    const fragmentHit = {
      ...fullHit,
      ref: "knowledge/guide#akm-fragment-3-abc",
      selectedRef: "knowledge/guide#akm-fragment-3-abc",
      parentRef: "knowledge/guide",
      fragmentOrdinal: 3,
      fragmentCount: 5,
      startLine: 40,
      endLine: 47,
      previousRef: "knowledge/guide#akm-fragment-2-def",
      nextRef: "knowledge/guide#akm-fragment-4-ghi",
      fragmentChars: 400,
      fragmentEstimatedTokens: 100,
      parentChars: 8000,
      parentEstimatedTokens: 2000,
    };

    expect(shapeSearchHit(fragmentHit, "brief")).toMatchObject({
      selectedRef: fragmentHit.selectedRef,
      parentRef: fragmentHit.parentRef,
      fragmentOrdinal: 3,
      fragmentCount: 5,
      parentEstimatedTokens: 2000,
    });
    expect(shapeSearchHit(fragmentHit, "normal")).toMatchObject({
      startLine: 40,
      endLine: 47,
      fragmentEstimatedTokens: 100,
    });
    expect(shapeSearchHitForAgent(fragmentHit)).toMatchObject({
      selectedRef: fragmentHit.selectedRef,
      previousRef: fragmentHit.previousRef,
      nextRef: fragmentHit.nextRef,
    });
  });
});

describe("shapeSearchHit — registry hits", () => {
  // v1 spec §4.2: registry hits no longer surface a `curated` boolean. They
  // may surface optional `warnings` when a provider has non-fatal issues.
  const registryHit = {
    type: "registry",
    name: "azure-ops",
    description: "Azure ops kit",
    action: "akm bundle add npm:azure-ops",
    warnings: ["registry rate limit hit, results may be stale"],
    id: "npm:azure-ops",
    score: 0.7,
  };

  test("brief keeps name/score (QA #28: brief now projects name+installRef+score)", () => {
    // Brief now includes name (normalised from title if needed) and score so
    // callers can use the result without --detail full.
    const result = shapeSearchHit(registryHit, "brief");
    expect(result.name).toBe("azure-ops");
    expect(result.score).toBe(0.7);
    // action is no longer in brief output — use installRef to act
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
      warnings: ["registry rate limit hit, results may be stale"],
    });
    expect(out).not.toHaveProperty("curated");
  });

  test("full passes through and never re-adds curated", () => {
    const out = shapeSearchHit(registryHit, "full");
    expect(out).toEqual(registryHit);
    expect(out).not.toHaveProperty("curated");
  });
});

describe("shapeSearchHitForAgent", () => {
  test("includes ref + caps description", () => {
    const hit = {
      type: "skill",
      name: "deploy",
      ref: "skills/deploy",
      description: "long ".repeat(100),
      action: "akm show skills/deploy",
      score: 0.5,
      estimatedTokens: 100,
      tags: ["ops"],
      origin: "local:.",
    };
    const out = shapeSearchHitForAgent(hit);
    expect(out).toMatchObject({
      name: "deploy",
      ref: "skills/deploy",
      type: "skill",
      action: "akm show skills/deploy",
      score: 0.5,
      estimatedTokens: 100,
    });
    expect(out).not.toHaveProperty("tags");
    expect(out).not.toHaveProperty("origin");
    expect(typeof out.description).toBe("string");
  });

  test("omits editHint unless the local asset is read-only", () => {
    const editable = shapeSearchHitForAgent({
      type: "skill",
      name: "deploy",
      ref: "skills/deploy",
      path: "/tmp/skills/deploy/SKILL.md",
      editable: true,
      editHint: "stale hint",
    });
    expect(editable).not.toHaveProperty("editHint");

    const readOnly = shapeSearchHitForAgent({
      ...editable,
      editable: false,
      editHint: "akm clone team//skills/deploy",
    });
    expect(readOnly.editHint).toBe("akm clone team//skills/deploy");
  });

  // Issue #856: agents are the primary consumer named by the issue, so
  // matchStage must survive the agent projection.
  test("includes matchStage when present, omits it when absent", () => {
    const withStage = shapeSearchHitForAgent({
      type: "skill",
      name: "deploy",
      ref: "skills/deploy",
      matchStage: "prefix",
    });
    expect(withStage.matchStage).toBe("prefix");

    const withoutStage = shapeSearchHitForAgent({
      type: "skill",
      name: "deploy",
      ref: "skills/deploy",
    });
    expect(withoutStage).not.toHaveProperty("matchStage");
  });
});

describe("shapeAssetHit", () => {
  const asset = {
    assetName: "deploy",
    assetType: "skill",
    description: "Deploy the app",
    stash: { id: "x", name: "x" },
    action: "akm show skills/deploy",
    estimatedTokens: 120,
  };

  test("brief drops description", () => {
    expect(shapeAssetHit(asset, "brief")).toEqual({
      assetName: "deploy",
      assetType: "skill",
      action: "akm show skills/deploy",
      estimatedTokens: 120,
    });
  });

  test("normal includes description + stash", () => {
    expect(shapeAssetHit(asset, "normal")).toMatchObject({
      assetName: "deploy",
      assetType: "skill",
      description: "Deploy the app",
      stash: { id: "x", name: "x" },
    });
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
    extra: "should-not-appear-in-agent-mode",
  };

  test("shape=agent picks the agent-action field set", () => {
    const out = shapeShowOutput(fullShow, "full", "agent");
    expect(out).toMatchObject({
      type: "skill",
      name: "deploy",
      ref: "team//skills/deploy",
      path: "/tmp/team/skills/deploy/SKILL.md",
      editable: false,
      editHint: "Inspect with akm show team//skills/deploy",
      description: "Deploy",
      content: "long body...",
    });
    expect(out).not.toHaveProperty("extra");
  });

  test("shape=summary picks the compact metadata field set", () => {
    const out = shapeShowOutput(fullShow, "normal", "summary");
    expect(out).toMatchObject({ type: "skill", name: "deploy", description: "Deploy" });
    // summary omits content (compact metadata only).
    expect(out).not.toHaveProperty("content");
  });

  test("shape=human at full picks the show field set + adds schemaVersion", () => {
    const out = shapeShowOutput(fullShow, "full", "human");
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

  test("shape=human at brief omits schemaVersion (only added at full)", () => {
    const out = shapeShowOutput(fullShow, "brief", "human");
    expect(out).not.toHaveProperty("schemaVersion");
    expect(out.name).toBe("deploy");
  });

  // R-020: `ref` is the canonical identity of the shown asset and must be
  // present in EVERY show shape (human default, summary, and agent) — it was
  // previously stripped by the human/summary field lists, leaving `--shape
  // agent` as the only projection that carried it.
  test("ref is present in shape=human at every detail level", () => {
    expect(shapeShowOutput(fullShow, "brief", "human").ref).toBe("team//skills/deploy");
    expect(shapeShowOutput(fullShow, "normal", "human").ref).toBe("team//skills/deploy");
    expect(shapeShowOutput(fullShow, "full", "human").ref).toBe("team//skills/deploy");
  });

  test("ref is present in shape=summary", () => {
    expect(shapeShowOutput(fullShow, "normal", "summary").ref).toBe("team//skills/deploy");
  });

  test("ref is present in shape=agent", () => {
    expect(shapeShowOutput(fullShow, "normal", "agent").ref).toBe("team//skills/deploy");
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

    for (const shape of ["human", "summary", "agent"] as const) {
      expect(shapeShowOutput(fragmentShow, "normal", shape)).toMatchObject({
        selectedRef: fragmentShow.selectedRef,
        parentRef: fragmentShow.parentRef,
        fragmentOrdinal: 2,
        contextMode: "lead",
        contextMaxChars: 800,
        contextTruncated: true,
      });
    }
  });

  // D-14: `path` and `editable` are projected at every --detail level, not
  // gated behind --detail full — only `schemaVersion`/`editHint` are full-only.
  test("path and editable are present in shape=human at --detail brief (not full-gated)", () => {
    const out = shapeShowOutput(fullShow, "brief", "human");
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
      "human",
    ) as Record<string, unknown>;
    expect(Array.isArray(out.hits)).toBe(true);
    expect((out.hits as unknown[])[0]).toEqual({
      type: "skill",
      name: "x",
      action: "a",
      estimatedTokens: 1,
    });
  });

  test("routes show results through shapeShowOutput at full + shape=agent", () => {
    const out = shapeForCommand(
      "show",
      { type: "skill", name: "deploy", action: "a", extra: "drop me" },
      "full",
      "agent",
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
    expect(shapeForCommand("info", result, "full", "human")).toMatchObject(result);
    expect(shapeForCommand("health", result, "full", "human")).toMatchObject(result);
  });

  test("--shape summary on a non-show command warns and falls back to 'agent' instead of throwing", () => {
    const warnings: unknown[][] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args);
    });
    try {
      const summaryResult = shapeForCommand("search", { hits: [], registryHits: [] }, "normal", "summary");
      const agentResult = shapeForCommand("search", { hits: [], registryHits: [] }, "normal", "agent");
      expect(summaryResult).toEqual(agentResult);
      expect(warnings.some((args) => args.some((a) => String(a).includes("not supported for 'akm search'")))).toBe(
        true,
      );

      warnings.length = 0;
      const infoSummary = shapeForCommand("info", { x: 1 }, "normal", "summary");
      const infoAgent = shapeForCommand("info", { x: 1 }, "normal", "agent");
      expect(infoSummary).toEqual(infoAgent);
      expect(warnings.some((args) => args.some((a) => String(a).includes("not supported for 'akm info'")))).toBe(true);
    } finally {
      _setWarnSinkForTests(undefined);
      _resetWarnOnceForTests();
    }
  });

  test("--shape summary on show is allowed", () => {
    expect(() => shapeForCommand("show", { type: "skill", name: "deploy" }, "normal", "summary")).not.toThrow();
  });
});

describe("shapeSearchOutput", () => {
  test("respects detail level for hits", () => {
    const result = {
      hits: [{ type: "skill", name: "x", action: "a", estimatedTokens: 1, description: "desc" }],
      registryHits: [],
    };
    const brief = shapeSearchOutput(result, "brief", "human") as { hits: Record<string, unknown>[] };
    const normal = shapeSearchOutput(result, "normal", "human") as { hits: Record<string, unknown>[] };
    expect((brief.hits[0] as Record<string, unknown>).description).toBeUndefined();
    expect((normal.hits[0] as Record<string, unknown>).description).toBe("desc");
  });

  test("shape=agent overrides detail and uses the agent shape", () => {
    const result = {
      hits: [
        {
          type: "skill",
          name: "x",
          action: "a",
          ref: "skills/x",
          path: "/tmp/skills/x/SKILL.md",
          editable: true,
          description: "d",
          score: 0.1,
          estimatedTokens: 1,
        },
      ],
      registryHits: [],
    };
    const out = shapeSearchOutput(result, "brief", "agent") as { hits: Record<string, unknown>[] };
    expect(out.hits[0]).toMatchObject({
      ref: "skills/x",
      path: "/tmp/skills/x/SKILL.md",
      editable: true,
    });
  });

  test("shape=agent preserves machine-visible semantic fallback disclosure", () => {
    const out = shapeSearchOutput(
      {
        hits: [],
        registryHits: [],
        searchMode: "fts-fallback",
        warnings: ["Vector search unavailable — falling back to keyword search."],
      },
      "brief",
      "agent",
    );

    expect(out).toMatchObject({
      searchMode: "fts-fallback",
      warnings: ["Vector search unavailable — falling back to keyword search."],
    });
  });

  test("agent registry hits never acquire a local path", () => {
    const out = shapeSearchOutput(
      { hits: [], registryHits: [{ type: "registry", name: "kit", id: "kit", action: "akm bundle add kit" }] },
      "normal",
      "agent",
    ) as { registryHits: Record<string, unknown>[] };
    expect(out.registryHits[0]).not.toHaveProperty("path");
    expect(out.registryHits[0]).not.toHaveProperty("editable");
  });
});

describe("curate agent access projection", () => {
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
      "agent",
    ) as { items: Record<string, unknown>[] };

    expect(out.items[0]).toMatchObject({
      ref: "team//knowledge/guide",
      path: "/tmp/team/knowledge/guide.md",
      editable: false,
      editHint: "Inspect with akm show team//knowledge/guide",
    });
    expect(out.items[1]).not.toHaveProperty("path");
    expect(out.items[1]).not.toHaveProperty("editable");
  });

  test("agent projection preserves merged semantic fallback mode and warning", () => {
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
      "agent",
    );

    expect(out).toMatchObject({
      searchMode: "fts-fallback",
      warnings: ["Vector search unavailable — falling back to keyword search."],
    });
  });
});

describe("shapeRegistrySearchOutput", () => {
  test("shapes registry hits at the requested detail level", () => {
    const result = {
      hits: [
        {
          name: "azure-ops",
          description: "Azure ops kit",
          action: "akm bundle add npm:azure-ops",
          // v1 §4.2: no more `curated` key.
          score: 0.5,
          id: "npm:azure-ops",
        },
      ],
      registryHits: [],
    };
    const brief = shapeRegistrySearchOutput(result, "brief") as { hits: Record<string, unknown>[] };
    // QA #28: brief now projects name + score at minimum (not just name/action)
    expect(brief.hits[0]).toMatchObject({ name: "azure-ops", score: 0.5 });
  });
});

// ── Output-shape registry exhaustiveness (#274) ─────────────────────────────

describe("shapeForCommand: unknown command", () => {
  test("throws with the command name in the message instead of silently passing the result through", () => {
    // v1 spec §9: the output shape registry is exhaustive. A missing case is
    // a registration bug (silent JSON.stringify fallback was the old
    // behaviour). The throw must include the unknown command name so the
    // caller / test sees the missing registration.
    expect(() => shapeForCommand("definitely-not-a-real-command", { foo: "bar" }, "normal")).toThrow(
      "output shape not registered for command: definitely-not-a-real-command",
    );
  });
});

// ── #922: every list-returning command aliases its collection as `results` ──

describe("shapeForCommand — `results` collection alias (#922)", () => {
  // command -> [collection key, minimal valid raw result]
  const LIST_COMMANDS: Array<[string, string, Record<string, unknown>]> = [
    ["search", "hits", { hits: [{ type: "skill", name: "x", action: "a" }], registryHits: [] }],
    ["curate", "items", { items: [{ type: "skill", name: "x" }], query: "q", summary: "s" }],
    ["registry-search", "hits", { hits: [{ name: "x", installRef: "x" }], assetHits: [] }],
    ["proposal-list", "proposals", { totalCount: 1, proposals: [{ id: "p1", ref: "lessons/x", status: "pending" }] }],
    ["list", "sources", { sources: [{ name: "b1" }] }],
    ["env-list", "envs", { envs: [{ name: "e1" }] }],
    ["secret-list", "secrets", { secrets: [{ name: "s1" }] }],
    ["registry-list", "registries", { registries: [{ name: "r1" }] }],
    ["workflow-list", "runs", { runs: [{ id: "w1" }] }],
    ["task-history", "rows", { rows: [{ id: "t1" }] }],
    ["log-list", "events", { events: [{ eventType: "add", ref: "lessons/x", ts: "2024-01-01T00:00:00Z" }] }],
    ["config-diff", "rows", { rows: [{ path: "semanticSearchMode", local: "off", other: "auto" }] }],
    [
      "models-list",
      "rows",
      { rows: [{ alias: "fast", column: "claude", model: "claude-haiku", source: "default", via: "literal" }] },
    ],
  ];

  for (const [command, key, raw] of LIST_COMMANDS) {
    for (const shapeMode of ["human", "agent"] as const) {
      test(`akm ${command} --shape ${shapeMode} carries \`results\` as the SAME array as \`${key}\``, () => {
        const out = shapeForCommand(command, raw, "normal", shapeMode) as Record<string, unknown>;
        expect(Array.isArray(out.results)).toBe(true);
        // Not merely equal in content — the identical reference, so `results`
        // can never silently diverge from the semantic key it aliases.
        expect(out.results).toBe(out[key]);
      });
    }
  }

  test("a command with no registered collection key is untouched", () => {
    const out = shapeForCommand("info", { something: "untouched" }, "full", "human") as Record<string, unknown>;
    expect(out).not.toHaveProperty("results");
  });
});

// ── #284 GAP-MED 1: shapeProposal* — proposal commands ─────────────────────

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
    // R-063/R-064: the "reflect" shape registration was deleted — `akm
    // reflect` has no standalone CLI verb and no `output("reflect", ...)`
    // call site (reflect.ts is an internal function the improve loop calls
    // directly). "proposal-new" (`akm proposal new`, formerly the top-level
    // `akm propose`) shares the same producer-shape handler and IS a live CLI
    // verb (src/commands/proposal/propose-cli.ts), so it covers this
    // registry path.
    const propose = shapeForCommand(
      "proposal-new",
      { schemaVersion: 2, ok: true, ref: "lessons/x", proposal: fullProposal, engine: "p", durationMs: 1 },
      "normal",
    ) as Record<string, unknown>;
    expect(propose.ok).toBe(true);
  });
});
