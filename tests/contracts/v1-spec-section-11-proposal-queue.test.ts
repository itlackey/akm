import { describe, expect, test } from "bun:test";
import { extractSection, readDoc, SPEC_PATH } from "./spec-helpers";

// Pins v1 spec §11 — Proposal queue (Planned for v1).

const REQUIRED_PROPOSAL_FIELDS = ["id", "ref", "status", "source", "source_run", "created_at", "updated_at"];

const REQUIRED_PROPOSAL_COMMANDS = ["list", "show", "diff", "accept", "reject"];

const REQUIRED_EVENTS = ["propose_invoked", "reflect_invoked", "distill_invoked", "promoted", "rejected"];

describe("v1 spec §11 — proposal queue", () => {
  const spec = readDoc(SPEC_PATH);
  const section = extractSection(spec, "## 11. Proposal queue");

  test("§11 exists and is marked Planned for v1", () => {
    expect(section).not.toBe("");
    expect(section).toContain("Planned for v1");
  });

  test("§11.1 names `proposal.db` as the durable store", () => {
    expect(section).toContain("proposal.db");
  });

  test("§11.1 declares each required proposal row field", () => {
    for (const field of REQUIRED_PROPOSAL_FIELDS) {
      expect(section).toContain(`\`${field}\``);
    }
  });

  test("§11.1 declares pending/accepted/rejected/archived statuses", () => {
    expect(section).toContain("`pending`");
    expect(section).toContain("`accepted`");
    expect(section).toContain("`rejected`");
    expect(section).toContain("`archived`");
  });

  test("§11.2 lists every proposal subcommand", () => {
    for (const cmd of REQUIRED_PROPOSAL_COMMANDS) {
      expect(section).toContain(`akm proposal ${cmd}`);
    }
  });

  test("§11.2 says `accept` validates BEFORE promoting", () => {
    const flat = section.replace(/\s+/g, " ");
    expect(flat).toMatch(/validation .*\*\*before\*\* promoting/i);
  });

  test("§11.2 says `accept` promotes via writeAssetToSource()", () => {
    // The locked rule is "all asset writes funnel through writeAssetToSource".
    // The proposal queue is the only legal path that bypasses it for queue
    // state — promotion must hand back to the single dispatch point.
    expect(section).toContain("writeAssetToSource()");
  });

  test("§11.1 says multiple proposals per `ref` coexist", () => {
    // The id is per-row; the ref isn't unique. The queue must hold N proposals
    // for the same target ref without filesystem collisions.
    expect(section).toMatch(/Multiple proposals for\s*the same `ref`/i);
  });

  test("§11.2 names a `--reason` flag on `reject`", () => {
    expect(section).toMatch(/akm proposal reject.*--reason/);
  });

  test("§11.3 declares every locked event name", () => {
    for (const event of REQUIRED_EVENTS) {
      expect(section).toContain(`\`${event}\``);
    }
  });

  test("§11.3 says other plugins cannot reuse these event names", () => {
    expect(section).toMatch(/cannot reuse these names/i);
  });

  test("§11 stops before §12 (helper boundary check)", () => {
    // Defensive: extractSection() returns to EOF if no sibling stop
    // heading exists. Pin the section terminus so a missing §12 heading
    // (or a renamed one) trips this test instead of silently spilling
    // §12+§13+§14 content into the §11 assertions above.
    expect(section).not.toContain("## 12.");
    expect(section).not.toContain("## 13.");
    expect(section).not.toContain("## 14.");
  });
});
