/**
 * Report-level coverage for Track B learning curves (issue #265).
 *
 * Verifies that a `LearningCurve` supplied via `EvolveReportInput.learningCurve`
 * surfaces in both the JSON envelope (under `learning`) and the markdown
 * body (as a "Learning curve" section). Companion unit tests for
 * `computeLearningCurve` itself live in `metrics.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { computeLearningCurve, type EpisodeRecord } from "./metrics";
import {
  type EvolveReportInput,
  renderEvolveReport,
  renderLearningCurveSection,
  type UtilityRunReport,
} from "./report";

function emptyUtilityReport(): UtilityRunReport {
  return {
    timestamp: "2026-04-27T00:00:00Z",
    branch: "test",
    commit: "deadbee",
    model: "m",
    corpus: { domains: 0, tasks: 0, slice: "all", seedsPerArm: 1 },
    aggregateNoakm: { passRate: 0, tokensPerPass: 0, wallclockMs: 0 },
    aggregateAkm: { passRate: 0, tokensPerPass: 0, wallclockMs: 0 },
    aggregateDelta: {
      passRate: 0,
      tokensPerPass: 0,
      wallclockMs: 0,
    },
    trajectoryAkm: {
      correctAssetLoaded: null,
      feedbackRecorded: 0,
    },
    failureModes: { byLabel: {}, byTask: {} },
    tasks: [],
    warnings: [],
    akmRuns: [],
    taskMetadata: [],
    goldRankRecords: [],
  };
}

function ep(overrides: Partial<EpisodeRecord> & { episode_index: number; pass_rate: number }): EpisodeRecord {
  return {
    delta_from_previous_episode: 0,
    cumulative_feedback_events: 0,
    cumulative_proposals_created: 0,
    cumulative_proposals_accepted: 0,
    cumulative_lessons_created: 0,
    lesson_reuse_rate: null,
    ...overrides,
  };
}

function baseEvolveInput(extra: Partial<EvolveReportInput> = {}): EvolveReportInput {
  return {
    timestamp: "2026-04-27T00:00:00Z",
    branch: "test",
    commit: "deadbee",
    model: "m",
    domain: "test",
    seedsPerArm: 1,
    proposals: { rows: [], totalProposals: 0, totalAccepted: 0, acceptanceRate: 0, lintPassRate: 0 },
    longitudinal: {
      improvementSlope: 0.1,
      overSyntheticLift: 0.05,
      degradationCount: 0,
      degradations: [],
      prePassRate: 0.5,
      postPassRate: 0.6,
      syntheticPassRate: 0.55,
    },
    arms: { pre: emptyUtilityReport(), post: emptyUtilityReport(), synthetic: emptyUtilityReport() },
    warnings: [],
    ...extra,
  };
}

describe("renderEvolveReport — learning block (#265)", () => {
  test("emits learning.episodes[] + slope + time_to_improvement when learningCurve supplied", () => {
    const curve = computeLearningCurve([
      ep({ episode_index: 0, pass_rate: 0.4, cumulative_feedback_events: 10 }),
      ep({
        episode_index: 1,
        pass_rate: 0.55,
        cumulative_feedback_events: 22,
        cumulative_proposals_created: 4,
        cumulative_proposals_accepted: 3,
        cumulative_lessons_created: 3,
        lesson_reuse_rate: 0.42,
      }),
      ep({
        episode_index: 2,
        pass_rate: 0.7,
        cumulative_feedback_events: 35,
        cumulative_proposals_created: 7,
        cumulative_proposals_accepted: 5,
        cumulative_lessons_created: 5,
        lesson_reuse_rate: 0.6,
      }),
    ]);
    const { json, markdown } = renderEvolveReport(baseEvolveInput({ learningCurve: curve }));
    const parsed = json as {
      learning?: {
        episodes: Array<{ episode_index: number; pass_rate: number; cumulative_lessons_created: number }>;
        pass_rate_by_episode: number[];
        learning_slope: number;
        time_to_improvement: number | null;
      };
    };
    expect(parsed.learning).toBeDefined();
    expect(parsed.learning?.episodes).toHaveLength(3);
    expect(parsed.learning?.pass_rate_by_episode).toEqual([0.4, 0.55, 0.7]);
    expect(parsed.learning?.time_to_improvement).toBe(1);
    expect(parsed.learning?.learning_slope).toBeCloseTo(0.15, 3);
    expect(markdown).toContain("Learning curve");
    expect(markdown).toContain("learning_slope=+0.150");
    expect(markdown).toContain("time_to_improvement=1");
  });

  test("omits learning block when learningCurve absent (legacy path)", () => {
    const { json, markdown } = renderEvolveReport(baseEvolveInput());
    const parsed = json as { learning?: object };
    expect(parsed.learning).toBeUndefined();
    expect(markdown).not.toContain("Learning curve");
  });

  test("renders n/a for time_to_improvement when no improvement", () => {
    const curve = computeLearningCurve([
      ep({ episode_index: 0, pass_rate: 0.5 }),
      ep({ episode_index: 1, pass_rate: 0.5 }),
    ]);
    const { json, markdown } = renderEvolveReport(baseEvolveInput({ learningCurve: curve }));
    const parsed = json as { learning?: { time_to_improvement: number | null } };
    expect(parsed.learning?.time_to_improvement).toBeNull();
    expect(markdown).toContain("time_to_improvement=n/a");
  });
});

describe("renderLearningCurveSection", () => {
  test("emits the empty-state message when no episodes are recorded", () => {
    const md = renderLearningCurveSection({
      episodes: [],
      pass_rate_by_episode: [],
      learning_slope: 0,
      time_to_improvement: null,
    });
    expect(md).toContain("No episodes recorded");
  });
});
