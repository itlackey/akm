/**
 * Unit coverage for the golden-fixture normalizer (WI-01, R6 — plan §12.4 /
 * brief §3.2). Written FIRST (test-first): at the moment this file is
 * created, `tests/_helpers/golden.ts` does not exist yet, so this suite is
 * expected to fail with a module-resolution error until WI-01's
 * implementation step lands it.
 *
 * Placeholder classes exercised (brief §3.2 rule 2):
 *   <TS>    ISO timestamps AND `timestampForFilename()` tokens
 *           (`src/core/common.ts:525` — `toISOString().replace(/[:.]/g, "-")`)
 *   <ID>    uuids / proposal ids (default for any bare uuid-shaped string)
 *   <TXN>   transaction ids (key-name override: any key containing
 *           "transaction", case-insensitive — covers `transactionId` and
 *           the mv-engine's `mutationTransactionId` idempotency-key grammar)
 *   <STASH>/<DATA>/<TMP>  sandbox roots, substituted via the `roots` param
 *   <DUR>   duration fields (key name containing "duration", case-insensitive)
 */

import { describe, expect, test } from "bun:test";
import { normalizeGolden, stableStringify } from "./_helpers/golden";

const UUID_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const UUID_B = "9c858901-8a57-4791-81fe-4c455b099bc9";

describe("normalizeGolden — <TS> (ISO timestamps + timestampForFilename tokens)", () => {
  test("ISO timestamp with fractional seconds normalizes to <TS>", () => {
    const input = { createdAt: "2026-07-14T10:30:45.123Z", note: "no ts here" };
    expect(normalizeGolden(input)).toEqual({ createdAt: "<TS>", note: "no ts here" });
  });

  test("ISO timestamp without fractional seconds normalizes to <TS>", () => {
    const input = { createdAt: "2026-07-14T10:30:45Z" };
    expect(normalizeGolden(input)).toEqual({ createdAt: "<TS>" });
  });

  test("timestampForFilename token ([:.]->'-') embedded in a filename normalizes to <TS>", () => {
    // src/core/common.ts timestampForFilename(): new Date().toISOString().replace(/[:.]/g, "-")
    const input = { journalHome: "proposal-transactions/abc/2026-07-14T10-30-45-123Z-journal.json" };
    expect(normalizeGolden(input)).toEqual({ journalHome: "proposal-transactions/abc/<TS>-journal.json" });
  });

  test("multiple timestamps in one string all normalize", () => {
    const input = { range: "from 2026-07-14T10:30:45.000Z to 2026-07-14T11:00:00.000Z" };
    expect(normalizeGolden(input)).toEqual({ range: "from <TS> to <TS>" });
  });
});

describe("normalizeGolden — <ID> / <TXN> (uuids and proposal/transaction ids)", () => {
  test("a bare uuid normalizes to <ID> by default", () => {
    const input = { assetId: UUID_A };
    expect(normalizeGolden(input)).toEqual({ assetId: "<ID>" });
  });

  test("proposal id fields normalize to <ID>", () => {
    const input = { proposalId: UUID_A };
    expect(normalizeGolden(input)).toEqual({ proposalId: "<ID>" });
  });

  test("an embedded uuid in a non-id-keyed string still normalizes to <ID> via the fallback pattern", () => {
    const input = { message: `duplicate of ${UUID_A}` };
    expect(normalizeGolden(input)).toEqual({ message: "duplicate of <ID>" });
  });

  test("transactionId fields normalize to <TXN>, not <ID>", () => {
    const input = { transactionId: UUID_A };
    expect(normalizeGolden(input)).toEqual({ transactionId: "<TXN>" });
  });

  test("mutationTransactionId (mv-engine idempotencyMetadataKey grammar) normalizes to <TXN>", () => {
    const input = { mutationTransactionId: UUID_A };
    expect(normalizeGolden(input)).toEqual({ mutationTransactionId: "<TXN>" });
  });

  test("a transaction id embedded in a longer string under a transaction-ish key also becomes <TXN>", () => {
    const input = { transactionHome: `proposal-transactions/${UUID_A}/journal.json` };
    expect(normalizeGolden(input)).toEqual({ transactionHome: "proposal-transactions/<TXN>/journal.json" });
  });

  test("distinct uuids in one object both normalize independently", () => {
    const input = { a: UUID_A, b: UUID_B };
    expect(normalizeGolden(input)).toEqual({ a: "<ID>", b: "<ID>" });
  });
});

describe("normalizeGolden — <STASH>/<DATA>/<TMP> (sandbox roots)", () => {
  const roots = {
    stash: "/tmp/akm-test-suite-xyz/stash",
    data: "/tmp/akm-test-suite-xyz/data",
    tmp: "/tmp/akm-test-suite-xyz/tmp",
  };

  test("stash/data/tmp roots substitute to their placeholders", () => {
    const input = {
      stashPath: `${roots.stash}/memories/foo.md`,
      dataPath: `${roots.data}/index.db`,
      tmpPath: `${roots.tmp}/scratch`,
      unrelated: "/home/user/not-a-root/file.txt",
    };
    expect(normalizeGolden(input, roots)).toEqual({
      stashPath: "<STASH>/memories/foo.md",
      dataPath: "<DATA>/index.db",
      tmpPath: "<TMP>/scratch",
      unrelated: "/home/user/not-a-root/file.txt",
    });
  });

  test("without roots supplied, no path substitution occurs (only TS/ID/TXN/DUR rules apply)", () => {
    const input = { stashPath: `${roots.stash}/memories/foo.md` };
    expect(normalizeGolden(input)).toEqual({ stashPath: `${roots.stash}/memories/foo.md` });
  });
});

describe("normalizeGolden — <DUR> (durationMs and duration-flavored keys)", () => {
  test("durationMs normalizes to <DUR>", () => {
    const input = { durationMs: 1234 };
    expect(normalizeGolden(input)).toEqual({ durationMs: "<DUR>" });
  });

  test("a duration-flavored key variant (totalDurationMs) also normalizes to <DUR>", () => {
    const input = { totalDurationMs: 42 };
    expect(normalizeGolden(input)).toEqual({ totalDurationMs: "<DUR>" });
  });

  test("a non-duration numeric field is left untouched", () => {
    const input = { count: 3, retries: 0 };
    expect(normalizeGolden(input)).toEqual({ count: 3, retries: 0 });
  });
});

describe("normalizeGolden — recursion + idempotence", () => {
  test("nested objects and arrays normalize recursively", () => {
    const input = {
      events: [
        { id: UUID_A, at: "2026-07-14T10:30:45.123Z", durationMs: 5 },
        { id: UUID_B, at: "2026-07-14T10:30:46.000Z", durationMs: 10 },
      ],
    };
    expect(normalizeGolden(input)).toEqual({
      events: [
        { id: "<ID>", at: "<TS>", durationMs: "<DUR>" },
        { id: "<ID>", at: "<TS>", durationMs: "<DUR>" },
      ],
    });
  });

  test("normalizing an already-normalized value is a no-op (idempotent)", () => {
    const input = {
      createdAt: "2026-07-14T10:30:45.123Z",
      proposalId: UUID_A,
      transactionId: UUID_B,
      durationMs: 99,
    };
    const once = normalizeGolden(input);
    const twice = normalizeGolden(once);
    expect(twice).toEqual(once);
  });

  test("scalars other than string/number pass through unchanged", () => {
    const input = { flag: true, missing: null, tags: ["a", "b"] };
    expect(normalizeGolden(input)).toEqual({ flag: true, missing: null, tags: ["a", "b"] });
  });
});

describe("stableStringify — idempotent, key-sorted serialization", () => {
  test("keys are sorted at every nesting level", () => {
    const value = { b: 1, a: { d: 2, c: 3 } };
    const out = stableStringify(value);
    expect(out).toBe('{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
  });

  test("array element order is preserved (only object keys are sorted)", () => {
    const value = { list: [3, 1, 2] };
    const out = stableStringify(value);
    expect(out).toBe('{\n  "list": [\n    3,\n    1,\n    2\n  ]\n}\n');
  });

  test("output ends with exactly one trailing newline", () => {
    const out = stableStringify({ a: 1 });
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  test("is idempotent under parse + re-stringify", () => {
    const value = { z: [3, 2, 1], a: "x", nested: { y: 1, x: 2 } };
    const first = stableStringify(value);
    const second = stableStringify(JSON.parse(first));
    expect(second).toBe(first);
  });
});
