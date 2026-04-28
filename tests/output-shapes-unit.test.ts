import { describe, expect, test } from "bun:test";
import {
  capDescription,
  pickFields,
  shapeAssetHit,
  shapeForCommand,
  shapeRegistrySearchOutput,
  shapeSearchHit,
  shapeSearchHitForAgent,
  shapeSearchOutput,
  shapeShowOutput,
  truncateDescription,
} from "../src/output/shapes";

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
    ref: "skill:deploy",
    action: "akm show skill:deploy",
    score: 0.42,
    estimatedTokens: 120,
    origin: "local:.",
    tags: ["ops"],
    whyMatched: "name match",
  };

  test("brief keeps only type/name/action/estimatedTokens", () => {
    expect(shapeSearchHit(fullHit, "brief")).toEqual({
      type: "skill",
      name: "deploy",
      action: "akm show skill:deploy",
      estimatedTokens: 120,
    });
  });

  test("normal adds description and score (and caps description)", () => {
    const out = shapeSearchHit(fullHit, "normal");
    expect(out).toMatchObject({
      type: "skill",
      name: "deploy",
      description: "Deploy the app",
      action: "akm show skill:deploy",
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
});

describe("shapeSearchHit — registry hits", () => {
  // v1 spec §4.2: registry hits no longer surface a `curated` boolean. They
  // may surface optional `warnings` when a provider has non-fatal issues.
  const registryHit = {
    type: "registry",
    name: "azure-ops",
    description: "Azure ops kit",
    action: "akm add npm:azure-ops",
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
      action: "akm add npm:azure-ops",
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
      ref: "skill:deploy",
      description: "long ".repeat(100),
      action: "akm show skill:deploy",
      score: 0.5,
      estimatedTokens: 100,
      tags: ["ops"],
      origin: "local:.",
    };
    const out = shapeSearchHitForAgent(hit);
    expect(out).toMatchObject({
      name: "deploy",
      ref: "skill:deploy",
      type: "skill",
      action: "akm show skill:deploy",
      score: 0.5,
      estimatedTokens: 100,
    });
    expect(out).not.toHaveProperty("tags");
    expect(out).not.toHaveProperty("origin");
    expect(typeof out.description).toBe("string");
  });
});

describe("shapeAssetHit", () => {
  const asset = {
    assetName: "deploy",
    assetType: "skill",
    description: "Deploy the app",
    stash: { id: "x", name: "x" },
    action: "akm show skill:deploy",
    estimatedTokens: 120,
  };

  test("brief drops description", () => {
    expect(shapeAssetHit(asset, "brief")).toEqual({
      assetName: "deploy",
      assetType: "skill",
      action: "akm show skill:deploy",
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
    description: "Deploy",
    action: "akm show skill:deploy",
    content: "long body...",
    template: "tpl",
    cwd: "/tmp",
    extra: "should-not-appear-in-agent-mode",
  };

  test("forAgent picks the agent-action field set", () => {
    const out = shapeShowOutput(fullShow, "full", true);
    expect(out).toMatchObject({
      type: "skill",
      name: "deploy",
      description: "Deploy",
      content: "long body...",
    });
    expect(out).not.toHaveProperty("extra");
  });

  test("forAgent=false at full picks the show field set + adds schemaVersion", () => {
    const out = shapeShowOutput(fullShow, "full", false);
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

  test("forAgent=false at brief omits schemaVersion (only added at full)", () => {
    const out = shapeShowOutput(fullShow, "brief", false);
    expect(out).not.toHaveProperty("schemaVersion");
    expect(out.name).toBe("deploy");
  });
});

describe("shapeForCommand", () => {
  test("routes search results through shapeSearchOutput", () => {
    const out = shapeForCommand(
      "search",
      { hits: [{ type: "skill", name: "x", action: "a", estimatedTokens: 1 }], registryHits: [] },
      "brief",
      false,
    ) as Record<string, unknown>;
    expect(Array.isArray(out.hits)).toBe(true);
    expect((out.hits as unknown[])[0]).toEqual({
      type: "skill",
      name: "x",
      action: "a",
      estimatedTokens: 1,
    });
  });

  test("routes show results through shapeShowOutput at full + forAgent=true", () => {
    const out = shapeForCommand(
      "show",
      { type: "skill", name: "deploy", action: "a", extra: "drop me" },
      "full",
      true,
    ) as Record<string, unknown>;
    expect(out).not.toHaveProperty("extra");
  });

  test("non-search/show commands pass through unmodified", () => {
    const result = { something: "untouched" };
    expect(shapeForCommand("info", result, "full", false)).toEqual(result);
  });
});

describe("shapeSearchOutput", () => {
  test("respects detail level for hits", () => {
    const result = {
      hits: [{ type: "skill", name: "x", action: "a", estimatedTokens: 1, description: "desc" }],
      registryHits: [],
    };
    const brief = shapeSearchOutput(result, "brief", false) as { hits: Record<string, unknown>[] };
    const normal = shapeSearchOutput(result, "normal", false) as { hits: Record<string, unknown>[] };
    expect((brief.hits[0] as Record<string, unknown>).description).toBeUndefined();
    expect((normal.hits[0] as Record<string, unknown>).description).toBe("desc");
  });

  test("forAgent overrides detail and uses the agent shape", () => {
    const result = {
      hits: [
        {
          type: "skill",
          name: "x",
          action: "a",
          ref: "skill:x",
          description: "d",
          score: 0.1,
          estimatedTokens: 1,
        },
      ],
      registryHits: [],
    };
    const out = shapeSearchOutput(result, "brief", true) as { hits: Record<string, unknown>[] };
    expect((out.hits[0] as Record<string, unknown>).ref).toBe("skill:x");
  });
});

describe("shapeRegistrySearchOutput", () => {
  test("shapes registry hits at the requested detail level", () => {
    const result = {
      hits: [
        {
          name: "azure-ops",
          description: "Azure ops kit",
          action: "akm add npm:azure-ops",
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
