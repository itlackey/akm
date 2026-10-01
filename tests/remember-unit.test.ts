import { describe, expect, test } from "bun:test";
import { parse as yamlParse } from "yaml";
import {
  buildMemoryFrontmatter,
  parseDuration,
  runAutoHeuristics,
  synthesizeMemoryDescription,
} from "../src/commands/remember";

describe("parseDuration", () => {
  test("parses days", () => {
    expect(parseDuration("30d")).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parseDuration("1d")).toBe(24 * 60 * 60 * 1000);
  });

  test("parses hours", () => {
    expect(parseDuration("12h")).toBe(12 * 60 * 60 * 1000);
  });

  test("parses minutes with lowercase `m`", () => {
    expect(parseDuration("5m")).toBe(5 * 60 * 1000);
  });

  test("parses months as a 30-day approximation with uppercase `M`", () => {
    // `m` = minutes, `M` = months — the CLI-wide canonical grammar. (`m` here
    // formerly meant months; it is now minutes, with `M` reserved for months.)
    expect(parseDuration("3M")).toBe(3 * 30 * 24 * 60 * 60 * 1000);
  });

  test("rejects invalid format", () => {
    expect(() => parseDuration("forever")).toThrow(/Invalid --expires/);
    expect(() => parseDuration("30")).toThrow(/Invalid --expires/);
    expect(() => parseDuration("d30")).toThrow(/Invalid --expires/);
  });

  test("trims whitespace and rejects noncanonical uppercase units", () => {
    expect(() => parseDuration(" 7D ")).toThrow(/Invalid --expires/);
  });
});

describe("buildMemoryFrontmatter — YAML injection guard", () => {
  test("emits a parseable, well-formed YAML block for a normal record", () => {
    const out = buildMemoryFrontmatter({
      description: "VPN required for staging deploys",
      tags: ["ops", "networking"],
      source: "skills/deploy",
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
    expect(parsed.source).toBe("skills/deploy");
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

  // Precondition for consolidate-wave2-e.test.ts's D4 deletion (Phase 2
  // triage): the exact empty-string input, distinct from the whitespace-only
  // case above.
  test("omits an empty-string description", () => {
    const out = buildMemoryFrontmatter({ description: "", tags: ["x"] });
    const parsed = yamlParse(out.replace(/^---\n/, "").replace(/\n---$/, "")) as Record<string, unknown>;
    expect(parsed.description).toBeUndefined();
    expect(parsed.tags).toEqual(["x"]);
  });
});

describe("buildMemoryFrontmatter — captureMode + beliefState (Phase 1B / Rec 7)", () => {
  test("emits captureMode: hot when explicitly passed", () => {
    const out = buildMemoryFrontmatter({ tags: ["ops"], captureMode: "hot" });
    const parsed = yamlParse(out.replace(/^---\n/, "").replace(/\n---$/, "")) as Record<string, unknown>;
    expect(parsed.captureMode).toBe("hot");
  });

  test("emits beliefState when passed", () => {
    const out = buildMemoryFrontmatter({ tags: ["ops"], beliefState: "asserted" });
    const parsed = yamlParse(out.replace(/^---\n/, "").replace(/\n---$/, "")) as Record<string, unknown>;
    expect(parsed.beliefState).toBe("asserted");
  });

  test("emits captureMode + beliefState together (the hot-path CLI contract)", () => {
    const out = buildMemoryFrontmatter({
      description: "VPN required for staging deploys",
      tags: ["ops"],
      captureMode: "hot",
      beliefState: "asserted",
    });
    const parsed = yamlParse(out.replace(/^---\n/, "").replace(/\n---$/, "")) as Record<string, unknown>;
    expect(parsed.captureMode).toBe("hot");
    expect(parsed.beliefState).toBe("asserted");
  });

  test("omits captureMode + beliefState when not passed (default-safe)", () => {
    const out = buildMemoryFrontmatter({ tags: ["ops"] });
    const parsed = yamlParse(out.replace(/^---\n/, "").replace(/\n---$/, "")) as Record<string, unknown>;
    expect(parsed.captureMode).toBeUndefined();
    expect(parsed.beliefState).toBeUndefined();
  });

  test("rejects unknown captureMode values silently (frontmatter omits the key)", () => {
    const out = buildMemoryFrontmatter({
      tags: ["ops"],
      captureMode: "unknown-mode" as unknown as "hot",
    });
    const parsed = yamlParse(out.replace(/^---\n/, "").replace(/\n---$/, "")) as Record<string, unknown>;
    expect(parsed.captureMode).toBeUndefined();
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

// #834: `akm remember` wrote memories with no `description:`, and akm's
// indexer covers only frontmatter/headings — never body prose — so those
// memories were retrievable only by whatever words survived into the
// auto-generated filename. `synthesizeMemoryDescription` closes that gap
// deterministically (no LLM call) at write time.
describe("synthesizeMemoryDescription", () => {
  test("returns the first sentence of a single-sentence body", () => {
    expect(synthesizeMemoryDescription("Deployment needs VPN access.")).toBe("Deployment needs VPN access.");
  });

  test("accumulates whole sentences until the next would exceed the cap", () => {
    const body =
      "akm's measured value comes entirely from being called, not from being present. " +
      "Harbor A/B benchmark, 138 trials, showed a real engagement lift when the trigger wording changed.";
    const out = synthesizeMemoryDescription(body, 120);
    // The full first sentence fits; the second is dropped because appending it
    // would exceed the cap. A distinctive term from mid-body ("Harbor") must
    // still not require truncating the first sentence to admit it.
    expect(out).toBe("akm's measured value comes entirely from being called, not from being present.");
    expect(out.length).toBeLessThanOrEqual(120);
  });

  test("captures a distinctive mid-body term when it fits within the cap", () => {
    const body = "Harbor A/B benchmark, 138 trials, showed a real engagement lift when the trigger wording changed.";
    const out = synthesizeMemoryDescription(body);
    expect(out).toContain("Harbor");
    expect(out).toContain("engagement");
    expect(out).toContain("trigger wording");
  });

  test("hard-truncates a single sentence longer than the cap", () => {
    const longSentence = `This is a very long single sentence that keeps going ${"and going ".repeat(20)}without stopping.`;
    const out = synthesizeMemoryDescription(longSentence, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });

  test("skips a leading markdown heading so the description isn't a repeated title", () => {
    const out = synthesizeMemoryDescription("# Deploy Notes\n\nVPN required for staging deploys.");
    expect(out).toBe("VPN required for staging deploys.");
  });

  test("falls back to the heading itself when the body is only a heading", () => {
    const out = synthesizeMemoryDescription("# Deploy Notes");
    expect(out).toBe("# Deploy Notes");
  });

  test("swallows a trailing quote so a quoted sentence isn't split mid-quote", () => {
    const out = synthesizeMemoryDescription('Alice said, "hi there." Then she left.', 100);
    expect(out).toBe('Alice said, "hi there." Then she left.');
  });

  test("returns empty string for empty/whitespace-only input", () => {
    expect(synthesizeMemoryDescription("")).toBe("");
    expect(synthesizeMemoryDescription("   \n  ")).toBe("");
  });

  test("keeps IPs, versions, domains, file names and URLs whole", () => {
    const body =
      "Host 192.168.0.203 runs akm 0.9.12 behind example.com, config in notes.md, docs at https://example.com/a.b?x=1.";
    expect(synthesizeMemoryDescription(body)).toBe(body);
  });

  test("still splits sentences when the first one holds a dotted token", () => {
    const out = synthesizeMemoryDescription("Upgraded to 0.9.12 on 192.168.0.203. Then rebooted the box.", 40);
    expect(out).toBe("Upgraded to 0.9.12 on 192.168.0.203.");
    expect(synthesizeMemoryDescription("Is it 0.9.12? Yes! Done.", 14)).toBe("Is it 0.9.12?");
  });
});
