/**
 * Regression tests for three consolidate writer bugs (2026-05-25):
 *
 *   #5  Description-not-in-body: the consolidate writer put `description`
 *       into the proposal envelope (`payload.frontmatter`) but never merged
 *       it into the body's YAML frontmatter. The accept-time validator
 *       parses the BODY for `description`, so 60 of 62 pending proposals
 *       were stuck with `MISSING_FRONTMATTER_DESCRIPTION` even though the
 *       envelope had it.
 *
 *   #6  Dedup-on-full-content: the cross-run / within-run content-hash dedup
 *       hashed the full file (frontmatter + body). Source memories with
 *       identical bodies but differing noise frontmatter (`inferenceProcessed:
 *       true` twin alongside the original; differing `updated:` dates) hashed
 *       to different values and both got promoted. ~28 ref-clusters of
 *       byte-identical bodies survived in the queue.
 *
 *   #7  Tag-only-body: source memories whose body was a 1-line tag string
 *       ("discord,notification,send-notification") got promoted to knowledge
 *       proposals that no reviewer would accept. No min-body-length guard
 *       existed pre-fix.
 *
 * These tests pin the contract directly — they validate that the proposal
 * shape the writer produces is the one the accept-time validator expects,
 * and that the new guards reject the failure modes documented above.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { assembleAssetFromString } from "../../../src/core/asset-serialize";
import { parseFrontmatter } from "../../../src/core/frontmatter";
import type { Proposal } from "../../../src/core/proposals";
import { validateProposal } from "../../../src/core/proposals";

function makeProposal(content: string, envelopeFm: Record<string, unknown> = {}): Proposal {
  return {
    id: "test-proposal-id",
    ref: "knowledge:test-asset",
    status: "pending",
    source: "consolidate",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    payload: {
      content,
      frontmatter: envelopeFm,
    },
  };
}

describe("Bug #5 — consolidate writer must merge description INTO body frontmatter", () => {
  test("OLD writer shape (description ONLY in envelope) is rejected by the validator", () => {
    // This is what consolidate produced before the 2026-05-25 fix: body
    // frontmatter has the memory's native keys but no description.
    const bodyWithoutDescription = `---\ncaptureMode: hot\nbeliefState: asserted\nupdated: 2026-05-21\n---\n\nReal substantive memory body here, more than a hundred characters of useful engineering knowledge.\n`;
    const proposal = makeProposal(bodyWithoutDescription, { description: "Description only in envelope" });

    const report = validateProposal(proposal);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => /description/i.test(f.message))).toBe(true);
  });

  test("NEW writer shape (description merged into body) is accepted by the validator", () => {
    // The new writer produces this shape: existing body frontmatter PLUS
    // description as a merged-in key.
    const parsedSource = parseFrontmatter(
      `---\ncaptureMode: hot\nbeliefState: asserted\nupdated: 2026-05-21\n---\n\nReal substantive memory body here, more than a hundred characters of useful engineering knowledge.\n`,
    );
    const mergedFm = {
      ...parsedSource.data,
      description: "Real summary explaining what this knowledge asset captures.",
    };
    const serializedFm = yamlStringify(mergedFm).trimEnd();
    const newContent = assembleAssetFromString(serializedFm, parsedSource.content);

    // Sanity-check the merged body actually has description before validating
    expect(/^\s*description\s*:/m.test(newContent.split("---")[1] ?? "")).toBe(true);

    const proposal = makeProposal(newContent, {
      description: "Real summary explaining what this knowledge asset captures.",
    });
    const report = validateProposal(proposal);
    expect(report.ok).toBe(true);
  });

  test("merged body frontmatter preserves the source memory's other keys", () => {
    const sourceContent = `---\ncaptureMode: hot\nbeliefState: asserted\nupdated: 2026-05-21\ntags:\n  - test\n  - merging\n---\n\nThis body must be long enough to clear the body-min-chars guard so the test reflects realistic merged output.\n`;
    const parsed = parseFrontmatter(sourceContent);
    const merged = { ...parsed.data, description: "Substantive description of the new knowledge asset content." };
    const serialized = yamlStringify(merged).trimEnd();
    const finalContent = assembleAssetFromString(serialized, parsed.content);

    const reparsed = parseFrontmatter(finalContent);
    expect(reparsed.data.description).toBe("Substantive description of the new knowledge asset content.");
    expect(reparsed.data.captureMode).toBe("hot");
    expect(reparsed.data.beliefState).toBe("asserted");
    expect(reparsed.data.tags).toEqual(["test", "merging"]);
  });
});

describe("Bug #6 — dedup must hash on BODY only so noise-frontmatter twins are caught", () => {
  // Helper that mirrors the new dedup logic in consolidate.ts.
  function bodyHash(content: string): string {
    const body = parseFrontmatter(content).content.trim();
    return createHash("sha256").update(body, "utf8").digest("hex");
  }
  function fullHash(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  test("identical bodies with differing inferenceProcessed frontmatter share a body-hash but NOT a full-hash", () => {
    const sharedBody =
      "# Discord URL extraction\n\nUse `discord:fetch-embed-urls` to extract URLs from embedded message previews.\nSeen across multiple capture sessions.";
    const twinA = `---\ncaptureMode: hot\nbeliefState: asserted\ninferenceProcessed: false\nupdated: 2026-05-21\n---\n\n${sharedBody}\n`;
    const twinB = `---\ncaptureMode: hot\nbeliefState: asserted\ninferenceProcessed: true\nupdated: 2026-05-22\n---\n\n${sharedBody}\n`;

    // Old (buggy) dedup missed this because frontmatter differed.
    expect(fullHash(twinA)).not.toBe(fullHash(twinB));
    // New dedup catches it because the body is byte-identical.
    expect(bodyHash(twinA)).toBe(bodyHash(twinB));
  });

  test("genuinely different bodies still produce different body hashes (no over-dedup)", () => {
    const a = `---\ncaptureMode: hot\n---\n\nPattern A: deploy needs VPN before connecting to prod database.`;
    const b = `---\ncaptureMode: hot\n---\n\nPattern B: rollback procedure for failed migrations on staging.`;
    expect(bodyHash(a)).not.toBe(bodyHash(b));
  });
});

describe("Bug #7 — tag-only / tiny-body memories must be rejected before queuing", () => {
  // Helper that mirrors the new min-body-length guard in consolidate.ts.
  const PROMOTE_BODY_MIN_CHARS = 100;
  function shouldRejectAsTooSmall(memoryContent: string): boolean {
    const body = parseFrontmatter(memoryContent).content.trim();
    return body.length < PROMOTE_BODY_MIN_CHARS;
  }

  test("rejects a memory whose body is a single tag string", () => {
    const tagOnly = `---\ncaptureMode: hot\nbeliefState: asserted\ninferenceProcessed: true\n---\n\ndiscord,notification,send-notification\n`;
    expect(shouldRejectAsTooSmall(tagOnly)).toBe(true);
  });

  test("rejects a memory with an empty body", () => {
    const empty = `---\ncaptureMode: hot\n---\n\n\n`;
    expect(shouldRejectAsTooSmall(empty)).toBe(true);
  });

  test("accepts a memory whose body is substantive (≥100 chars)", () => {
    const substantive = `---\ncaptureMode: hot\n---\n\nThis is a substantive memory body that easily clears the minimum length threshold for promotion to knowledge.\n`;
    expect(shouldRejectAsTooSmall(substantive)).toBe(false);
  });

  test("rejects a borderline 99-char body but accepts 100-char body", () => {
    const ninetyNine = "x".repeat(99);
    const oneHundred = "x".repeat(100);
    expect(shouldRejectAsTooSmall(`---\nfoo: 1\n---\n\n${ninetyNine}\n`)).toBe(true);
    expect(shouldRejectAsTooSmall(`---\nfoo: 1\n---\n\n${oneHundred}\n`)).toBe(false);
  });
});

describe("yaml round-trip: merged body frontmatter parses cleanly", () => {
  // Defensive — the new writer uses yaml.stringify to serialize the merged
  // frontmatter dict. Project's hand-rolled parseFrontmatter is a subset of
  // YAML, so this test guards against the writer emitting shapes the parser
  // can't read back.
  test("simple keys round-trip", () => {
    const fm = { captureMode: "hot", beliefState: "asserted", description: "A summary." };
    const yaml = yamlStringify(fm).trimEnd();
    const assembled = assembleAssetFromString(yaml, "Body content here.\n");
    const parsed = parseFrontmatter(assembled);
    expect(parsed.data.captureMode).toBe("hot");
    expect(parsed.data.description).toBe("A summary.");
  });

  test("list values round-trip", () => {
    const fm = { tags: ["alpha", "beta"], description: "Has tags." };
    const yaml = yamlStringify(fm).trimEnd();
    const assembled = assembleAssetFromString(yaml, "Body.\n");
    const parsed = parseFrontmatter(assembled);
    expect(parsed.data.tags).toEqual(["alpha", "beta"]);
    expect(parsed.data.description).toBe("Has tags.");
  });

  test("yamlParse confirms the merged shape is valid YAML", () => {
    const fm = { captureMode: "hot", description: "ok", updated: "2026-05-21" };
    const yaml = yamlStringify(fm).trimEnd();
    expect(yamlParse(yaml)).toEqual(fm);
  });
});
