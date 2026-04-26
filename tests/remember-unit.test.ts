import { describe, expect, test } from "bun:test";
import { parse as yamlParse } from "yaml";
import { buildMemoryFrontmatter, parseDuration, runAutoHeuristics } from "../src/commands/remember";

describe("parseDuration", () => {
  test("parses days", () => {
    expect(parseDuration("30d")).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parseDuration("1d")).toBe(24 * 60 * 60 * 1000);
  });

  test("parses hours", () => {
    expect(parseDuration("12h")).toBe(12 * 60 * 60 * 1000);
  });

  test("parses months as 30-day approximation", () => {
    expect(parseDuration("6m")).toBe(6 * 30 * 24 * 60 * 60 * 1000);
  });

  test("rejects invalid format", () => {
    expect(() => parseDuration("forever")).toThrow(/Invalid --expires/);
    expect(() => parseDuration("30")).toThrow(/Invalid --expires/);
    expect(() => parseDuration("d30")).toThrow(/Invalid --expires/);
  });

  test("trims whitespace and accepts uppercase units", () => {
    expect(parseDuration(" 7D ")).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("buildMemoryFrontmatter — YAML injection guard", () => {
  test("emits a parseable, well-formed YAML block for a normal record", () => {
    const out = buildMemoryFrontmatter({
      description: "VPN required for staging deploys",
      tags: ["ops", "networking"],
      source: "skill:deploy",
      observed_at: "2026-04-24",
      expires: "2026-07-23",
      subjective: false,
    });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out.endsWith("\n---")).toBe(true);

    const inner = out.replace(/^---\n/, "").replace(/\n---$/, "");
    const parsed = yamlParse(inner) as Record<string, unknown>;
    expect(parsed.description).toBe("VPN required for staging deploys");
    expect(parsed.tags).toEqual(["ops", "networking"]);
    expect(parsed.source).toBe("skill:deploy");
    expect(parsed.observed_at).toBe("2026-04-24");
    expect(parsed.expires).toBe("2026-07-23");
    expect(parsed.subjective).toBeUndefined();
  });

  test("preserves subjective: true when set", () => {
    const out = buildMemoryFrontmatter({ tags: ["x"], subjective: true });
    const parsed = yamlParse(out.replace(/^---\n/, "").replace(/\n---$/, "")) as Record<string, unknown>;
    expect(parsed.subjective).toBe(true);
  });

  test("description containing newlines + forged tags cannot inject extra keys", () => {
    // Pre-fix this string would have been emitted as:
    //   description: nice
    //   tags: [pwned]
    // …producing two real frontmatter keys. With yaml.stringify it is
    // safely quoted as a single string value.
    const malicious = "nice\ntags: [pwned]";
    const out = buildMemoryFrontmatter({ description: malicious, tags: ["expected"] });
    const parsed = yamlParse(out.replace(/^---\n/, "").replace(/\n---$/, "")) as Record<string, unknown>;
    expect(parsed.tags).toEqual(["expected"]);
    expect(parsed.description).toBe(malicious);
    expect((parsed as Record<string, unknown>).pwned).toBeUndefined();
  });

  test("source containing YAML metacharacters round-trips intact", () => {
    const tricky = "https://example.com/path?q=#anchor: { x: y }";
    const out = buildMemoryFrontmatter({ tags: ["ops"], source: tricky });
    const parsed = yamlParse(out.replace(/^---\n/, "").replace(/\n---$/, "")) as Record<string, unknown>;
    expect(parsed.source).toBe(tricky);
  });

  test("omits empty fields", () => {
    const out = buildMemoryFrontmatter({ tags: [] });
    expect(out).toBe("---\n---");
  });

  test("omits whitespace-only string fields", () => {
    const out = buildMemoryFrontmatter({ description: "   ", tags: ["x"] });
    const parsed = yamlParse(out.replace(/^---\n/, "").replace(/\n---$/, "")) as Record<string, unknown>;
    expect(parsed.description).toBeUndefined();
    expect(parsed.tags).toEqual(["x"]);
  });
});

describe("runAutoHeuristics", () => {
  test("detects a fenced code block as the `code` tag", () => {
    const result = runAutoHeuristics("Found this:\n```sh\necho hi\n```");
    expect(result.tags).toContain("code");
  });

  test("does not add `code` tag when no fenced block present", () => {
    const result = runAutoHeuristics("plain prose, no code");
    expect(result.tags).not.toContain("code");
  });

  test("flags first-person pronouns as subjective (lowercase + capital I)", () => {
    expect(runAutoHeuristics("I think we should ship").subjective).toBe(true);
    expect(runAutoHeuristics("we shipped my favorite feature").subjective).toBe(true);
    expect(runAutoHeuristics("our team agreed").subjective).toBe(true);
  });

  test("non-first-person prose is not flagged subjective", () => {
    expect(runAutoHeuristics("The cluster restarted at 3am.").subjective).toBeUndefined();
    // Capitalised My/Our at sentence start currently isn't matched —
    // documented as case-sensitive. If we widen this in a future
    // patch, update this test to reflect the new behaviour.
    expect(runAutoHeuristics("My take is...").subjective).toBeUndefined();
  });

  test("captures the first URL as source", () => {
    const result = runAutoHeuristics("see https://example.com/docs and also https://example.org");
    expect(result.source).toBe("https://example.com/docs");
  });

  test("captures an explicit ISO date as observed_at", () => {
    const result = runAutoHeuristics("Incident on 2026-04-24, resolved.");
    expect(result.observed_at).toBe("2026-04-24");
  });

  test("interprets `today` as observed_at", () => {
    const result = runAutoHeuristics("today the deploy failed");
    expect(result.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Should be today's date (loose check — no timezone drift assertions)
    const today = new Date().toISOString().slice(0, 10);
    expect(result.observed_at).toBe(today);
  });

  test("handles plain prose without any signals", () => {
    const result = runAutoHeuristics("Just a regular note about something boring.");
    expect(result.tags).toEqual([]);
    expect(result.source).toBeUndefined();
    expect(result.observed_at).toBeUndefined();
    expect(result.subjective).toBeUndefined();
  });
});
