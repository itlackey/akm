// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import type { Proposal } from "../src/commands/proposal/proposal-types";
import { parseCommandResponse } from "../src/workspace/cli-child";
import { againstUsual, classifyOutcome, decidedAt, pChart, weekRange } from "../src/workspace/derive";
import { missesFromRows } from "../src/workspace/misses";
import { binomialQuantile } from "../src/workspace/stats";

const proposal = (over: Partial<Proposal>): Proposal => ({ status: "accepted", ...over }) as Proposal;

describe("classifyOutcome", () => {
  test("names who decided an accept, and what became of the rest", () => {
    expect(classifyOutcome(proposal({ status: "pending" }))).toBe("pending");
    expect(classifyOutcome(proposal({ status: "rejected" }))).toBe("rejected");
    expect(classifyOutcome(proposal({ status: "reverted" }))).toBe("reverted");
    const review = (decidedBy?: "triage" | "human") =>
      ({
        outcome: "accepted",
        decidedAt: "2026-10-01T00:00:00Z",
        ...(decidedBy ? { decidedBy } : {}),
      }) as Proposal["review"];
    expect(classifyOutcome(proposal({ review: review("triage") }))).toBe("judge");
    expect(classifyOutcome(proposal({ review: review("human") }))).toBe("you");
    // Before decidedBy was recorded: the gate's auto-accept says judge; otherwise unknown.
    expect(
      classifyOutcome(
        proposal({ review: review(), gateDecision: { outcome: "auto-accepted" } as Proposal["gateDecision"] }),
      ),
    ).toBe("judge");
    expect(classifyOutcome(proposal({ review: review() }))).toBe("unknown");
  });
});

describe("decidedAt", () => {
  test("dates a reverted proposal by its accept, not the revert that overwrote the review", () => {
    const review = { outcome: "rejected", decidedAt: "2026-10-20T00:00:00Z" } as Proposal["review"];
    const reverted = proposal({ status: "reverted", review, updatedAt: "2026-10-20T00:00:00Z" });
    expect(decidedAt({ ...reverted, acceptedAt: "2026-10-01T00:00:00Z" })).toBe("2026-10-01T00:00:00Z");
    // Reverted before `acceptedAt` existed: the revert time is all there is.
    expect(decidedAt(reverted)).toBe("2026-10-20T00:00:00Z");
    expect(decidedAt(proposal({ review: { outcome: "accepted", decidedAt: "2026-10-02T00:00:00Z" } }))).toBe(
      "2026-10-02T00:00:00Z",
    );
  });
});

describe("binomialQuantile", () => {
  test("is the exact quantile", () => {
    expect(binomialQuantile(10, 0.5, 0.5)).toBe(5);
    expect(binomialQuantile(100, 0.1, 0.975)).toBe(16);
    expect(binomialQuantile(0, 0.5, 0.5)).toBe(0);
    expect(binomialQuantile(20, 0, 0.9)).toBe(0);
    expect(binomialQuantile(20, 1, 0.1)).toBe(20);
  });
});

describe("againstUsual", () => {
  test("a small sample or baseline is low-data, never a verdict", () => {
    expect(againstUsual(2, 5, 40, 400).state).toBe("low-data");
    expect(againstUsual(20, 100, 3, 20).state).toBe("low-data");
  });
  test("judges the share against the central 95% at the current n", () => {
    // Baseline 10%: at n=100, the usual range is about 5% to 16%.
    const within = againstUsual(10, 100, 100, 1000);
    expect(within.state).toBe("within");
    expect(within.low).toBeCloseTo(0.05, 1);
    expect(within.high).toBeCloseTo(0.16, 1);
    expect(againstUsual(30, 100, 100, 1000).state).toBe("above");
    expect(againstUsual(1, 100, 100, 1000).state).toBe("below");
  });
});

describe("pChart", () => {
  test("limits widen where a week has fewer observations, and an empty week has none", () => {
    const steady = ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"].map((week) => ({
      week,
      x: 30,
      n: 100,
    }));
    const { centre, points } = pChart([
      ...steady,
      { week: "2026-10-12", x: 3, n: 10 },
      { week: "2026-10-19", x: 0, n: 0 },
      { week: "2026-10-26", x: 70, n: 100 },
    ]);
    expect(centre).toBeCloseTo(223 / 610, 5);
    const [big, , , , , small, empty, outlier] = points;
    expect((small?.upper ?? 0) - (small?.lower ?? 0)).toBeGreaterThan((big?.upper ?? 0) - (big?.lower ?? 0));
    expect(empty).toMatchObject({ rate: null, lower: null, upper: null, signal: false });
    expect(outlier?.signal).toBe(true);
    expect(big?.signal).toBe(false);
  });
});

describe("weekRange", () => {
  test("lists each ISO week start from the week of `from` to the week of `to`", () => {
    expect(weekRange("2026-10-14", "2026-11-02")).toEqual(["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
  });
});

describe("missesFromRows", () => {
  const row = (at: string, query: string, resultCount = 0, source = "user") =>
    ({ id: 1, at, eventType: "search", query, resultCount, source }) as Parameters<typeof missesFromRows>[0][number];
  test("groups by query, flags a query that missed on two days, and leaves out other sources and hits", () => {
    const misses = missesFromRows([
      row("2026-10-30T10:00:00Z", "Deploy  Guide"),
      row("2026-10-31T10:00:00Z", "deploy guide"),
      row("2026-10-31T11:00:00Z", "oneoff"),
      row("2026-10-31T12:00:00Z", "found it", 3),
      row("2026-10-31T13:00:00Z", "task search", 0, "task"),
    ]);
    expect(misses.map((m) => [m.query.toLowerCase().replace(/\s+/g, " "), m.count, m.days, m.repeated])).toEqual([
      ["deploy guide", 2, 2, true],
      ["oneoff", 1, 1, false],
    ]);
  });
});

test("workspace command responses require the expected JSON result and never report false success", () => {
  for (const stdout of [
    "",
    "not JSON",
    "null",
    "[]",
    "{}",
    '{"shape":"remove","schemaVersion":1}',
    '{"shape":"import","schemaVersion":1,"ok":false}',
  ]) {
    expect(() => parseCommandResponse(stdout, "import")).toThrow("State may already have changed");
    try {
      parseCommandResponse(stdout, "import");
    } catch (error) {
      expect((error as Error).message).toContain("Reload the view before retrying");
      expect(error).toMatchObject({ code: "INVALID_COMMAND_RESPONSE" });
    }
  }
  // The result comes back without its envelope.
  expect(parseCommandResponse('{"shape":"import","schemaVersion":1,"ref":"knowledge/new"}', "import")).toEqual({
    ref: "knowledge/new",
  });
});
