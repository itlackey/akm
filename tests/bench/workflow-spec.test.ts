/**
 * Tests for the workflow-spec YAML loader.
 *
 * Covers: valid fixtures, malformed specs, unknown event names,
 * applicability filters, gold_ref validation, path-traversal rejection,
 * scoring validation, duplicate ids.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  KNOWN_EVENT_NAMES,
  loadAllWorkflowSpecs,
  loadWorkflowSpec,
  specApplies,
  WorkflowSpecError,
} from "./workflow-spec";

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "bench", "workflows");

const REQUIRED_SPECS = [
  "akm-lookup-before-edit",
  "akm-correct-asset-use",
  "akm-feedback-after-use",
  "akm-negative-feedback-on-failure",
  "akm-reflect-after-repeated-failure",
  "akm-proposal-review-before-accept",
];

// ── Scratch directory helpers ──────────────────────────────────────────────

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "akm-workflow-spec-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeSpec(name: string, body: string): string {
  const p = path.join(scratch, name);
  writeFileSync(p, body, "utf8");
  return p;
}

// ── Fixture sanity ─────────────────────────────────────────────────────────

describe("loadAllWorkflowSpecs (real fixtures)", () => {
  test("loads every checked-in workflow spec", () => {
    const specs = loadAllWorkflowSpecs(FIXTURE_DIR);
    const ids = specs.map((s) => s.id).sort();
    for (const required of REQUIRED_SPECS) {
      expect(ids).toContain(required);
    }
  });

  test("every fixture has a valid scoring block", () => {
    const specs = loadAllWorkflowSpecs(FIXTURE_DIR);
    for (const s of specs) {
      const sum =
        s.scoring.required_steps_weight + s.scoring.forbidden_steps_weight + s.scoring.evidence_quality_weight;
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    }
  });

  test("every fixture event-name is in the known set", () => {
    const known = new Set<string>(KNOWN_EVENT_NAMES);
    const specs = loadAllWorkflowSpecs(FIXTURE_DIR);
    for (const s of specs) {
      for (const step of s.required_sequence) {
        expect(known.has(step.event)).toBe(true);
        if (step.before) expect(known.has(step.before)).toBe(true);
      }
      for (const step of s.forbidden ?? []) {
        expect(known.has(step.event)).toBe(true);
        if (step.before) expect(known.has(step.before)).toBe(true);
      }
    }
  });
});

// ── Valid spec parsing ─────────────────────────────────────────────────────

describe("loadWorkflowSpec — valid", () => {
  test("parses a minimal valid spec", () => {
    const p = writeSpec(
      "min.yaml",
      `id: min
title: Minimal
required_sequence:
  - event: agent_started
  - event: agent_finished
scoring:
  required_steps_weight: 0.6
  forbidden_steps_weight: 0.2
  evidence_quality_weight: 0.2
`,
    );
    const spec = loadWorkflowSpec(p);
    expect(spec.id).toBe("min");
    expect(spec.required_sequence.length).toBe(2);
    expect(spec.forbidden).toBeUndefined();
    expect(spec.applies_to).toBeUndefined();
    expect(spec.sourcePath).toBe(path.resolve(p));
  });

  test("preserves all richer fields (applies_to, forbidden, gold_ref)", () => {
    const p = writeSpec(
      "rich.yaml",
      `id: rich
title: Rich
applies_to:
  arms: ["akm"]
  task_domains: ["docker-homelab"]
  outcomes: ["pass"]
  requires_gold_ref: true
  min_repeated_failures: 2
gold_ref: "skill:deploy"
required_sequence:
  - event: agent_started
  - event: akm_show
    ref_must_equal: gold_ref
    before: first_workspace_write
  - event: first_workspace_write
forbidden:
  - event: first_workspace_write
    before: akm_show
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.2
`,
    );
    const spec = loadWorkflowSpec(p);
    expect(spec.applies_to?.arms).toEqual(["akm"]);
    expect(spec.applies_to?.task_domains).toEqual(["docker-homelab"]);
    expect(spec.applies_to?.requires_gold_ref).toBe(true);
    expect(spec.applies_to?.min_repeated_failures).toBe(2);
    expect(spec.gold_ref).toBe("skill:deploy");
    expect(spec.forbidden?.length).toBe(1);
    expect(spec.required_sequence[1].ref_must_equal).toBe("gold_ref");
  });
});

// ── Malformed specs ────────────────────────────────────────────────────────

describe("loadWorkflowSpec — malformed", () => {
  test("rejects non-YAML garbage", () => {
    const p = writeSpec("bad.yaml", "::: not yaml\n  - oops:\n: : :");
    expect(() => loadWorkflowSpec(p)).toThrow(WorkflowSpecError);
  });

  test("rejects YAML whose top level is not a mapping", () => {
    const p = writeSpec("array.yaml", "- 1\n- 2\n");
    expect(() => loadWorkflowSpec(p)).toThrow(/must be a mapping/);
  });

  test("rejects missing required fields", () => {
    const p = writeSpec(
      "no-title.yaml",
      `id: x
required_sequence:
  - event: agent_started
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.2
`,
    );
    expect(() => loadWorkflowSpec(p)).toThrow(/title/);
  });

  test("rejects empty required_sequence", () => {
    const p = writeSpec(
      "empty-seq.yaml",
      `id: x
title: x
required_sequence: []
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.2
`,
    );
    expect(() => loadWorkflowSpec(p)).toThrow(/required_sequence/);
  });

  test("rejects scoring weights that don't sum to 1", () => {
    const p = writeSpec(
      "bad-scoring.yaml",
      `id: x
title: x
required_sequence:
  - event: agent_started
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.5
`,
    );
    expect(() => loadWorkflowSpec(p)).toThrow(/sum to 1/);
  });

  test("rejects scoring weight outside [0, 1]", () => {
    const p = writeSpec(
      "neg-scoring.yaml",
      `id: x
title: x
required_sequence:
  - event: agent_started
scoring:
  required_steps_weight: -0.2
  forbidden_steps_weight: 0.6
  evidence_quality_weight: 0.6
`,
    );
    expect(() => loadWorkflowSpec(p)).toThrow(/in \[0, 1\]/);
  });

  test("rejects invalid gold_ref via parseAssetRef", () => {
    const p = writeSpec(
      "bad-ref.yaml",
      `id: x
title: x
gold_ref: "not-a-ref"
required_sequence:
  - event: agent_started
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.2
`,
    );
    expect(() => loadWorkflowSpec(p)).toThrow(/gold_ref/);
  });

  test("rejects invalid polarity", () => {
    const p = writeSpec(
      "bad-polarity.yaml",
      `id: x
title: x
required_sequence:
  - event: akm_feedback
    polarity: lukewarm
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.2
`,
    );
    expect(() => loadWorkflowSpec(p)).toThrow(/polarity/);
  });
});

// ── Unknown event names ────────────────────────────────────────────────────

describe("loadWorkflowSpec — unknown event names", () => {
  test("rejects unknown event in required_sequence", () => {
    const p = writeSpec(
      "unknown.yaml",
      `id: x
title: x
required_sequence:
  - event: agent_started
  - event: cosmic_rays
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.2
`,
    );
    expect(() => loadWorkflowSpec(p)).toThrow(/Unknown event name "cosmic_rays"/);
  });

  test("rejects unknown event in `before` clause", () => {
    const p = writeSpec(
      "unknown-before.yaml",
      `id: x
title: x
required_sequence:
  - event: akm_search
    before: nope
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.2
`,
    );
    expect(() => loadWorkflowSpec(p)).toThrow(/Unknown event name "nope"/);
  });

  test("rejects unknown event in forbidden block", () => {
    const p = writeSpec(
      "unknown-forbidden.yaml",
      `id: x
title: x
required_sequence:
  - event: agent_started
forbidden:
  - event: ouija_board
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.2
`,
    );
    expect(() => loadWorkflowSpec(p)).toThrow(/Unknown event name "ouija_board"/);
  });
});

// ── Applicability filters ──────────────────────────────────────────────────

describe("specApplies", () => {
  function specWith(applies_to?: object) {
    const yaml = applies_to
      ? `id: x\ntitle: x\napplies_to:\n${Object.entries(applies_to)
          .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
          .join(
            "\n",
          )}\nrequired_sequence:\n  - event: agent_started\nscoring:\n  required_steps_weight: 0.5\n  forbidden_steps_weight: 0.3\n  evidence_quality_weight: 0.2\n`
      : `id: x\ntitle: x\nrequired_sequence:\n  - event: agent_started\nscoring:\n  required_steps_weight: 0.5\n  forbidden_steps_weight: 0.3\n  evidence_quality_weight: 0.2\n`;
    const p = writeSpec(`${Math.random().toString(36).slice(2)}.yaml`, yaml);
    return loadWorkflowSpec(p);
  }

  test("no filter ⇒ matches anything", () => {
    const s = specWith();
    expect(specApplies(s, { arm: "noakm", taskId: "any/thing" })).toBe(true);
  });

  test("arm filter rejects mismatched arm", () => {
    const s = specWith({ arms: ["akm"] });
    expect(specApplies(s, { arm: "noakm", taskId: "x/y" })).toBe(false);
    expect(specApplies(s, { arm: "akm", taskId: "x/y" })).toBe(true);
  });

  test("task_domains filter uses first segment of taskId", () => {
    const s = specWith({ task_domains: ["docker-homelab"] });
    expect(specApplies(s, { arm: "akm", taskId: "docker-homelab/redis" })).toBe(true);
    expect(specApplies(s, { arm: "akm", taskId: "az-cli/storage" })).toBe(false);
  });

  test("outcomes filter requires the outcome to be present", () => {
    const s = specWith({ outcomes: ["pass"] });
    expect(specApplies(s, { arm: "akm", taskId: "x/y", outcome: "pass" })).toBe(true);
    expect(specApplies(s, { arm: "akm", taskId: "x/y", outcome: "fail" })).toBe(false);
    expect(specApplies(s, { arm: "akm", taskId: "x/y" })).toBe(false);
  });

  test("requires_gold_ref demands hasGoldRef", () => {
    const s = specWith({ requires_gold_ref: true });
    expect(specApplies(s, { arm: "akm", taskId: "x/y", hasGoldRef: false })).toBe(false);
    expect(specApplies(s, { arm: "akm", taskId: "x/y", hasGoldRef: true })).toBe(true);
  });

  test("min_repeated_failures gates on repeatedFailures count", () => {
    const s = specWith({ min_repeated_failures: 2 });
    expect(specApplies(s, { arm: "akm", taskId: "x/y", repeatedFailures: 1 })).toBe(false);
    expect(specApplies(s, { arm: "akm", taskId: "x/y", repeatedFailures: 2 })).toBe(true);
    expect(specApplies(s, { arm: "akm", taskId: "x/y" })).toBe(false);
  });
});

// ── Path traversal ─────────────────────────────────────────────────────────

describe("loadWorkflowSpec — path traversal", () => {
  test("rejects spec resolved outside the provided root", () => {
    // Set up a workflows root with a sibling file outside it.
    const root = path.join(scratch, "workflows");
    mkdirSync(root, { recursive: true });
    const inside = path.join(root, "ok.yaml");
    writeFileSync(
      inside,
      `id: ok
title: ok
required_sequence:
  - event: agent_started
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.2
`,
      "utf8",
    );
    const outside = path.join(scratch, "outside.yaml");
    writeFileSync(outside, "id: nope\ntitle: nope\n", "utf8");

    expect(() => loadWorkflowSpec(inside, root)).not.toThrow();
    expect(() => loadWorkflowSpec(outside, root)).toThrow(/outside/);
    // Traversal pattern must also be rejected.
    const traversal = path.join(root, "..", "outside.yaml");
    expect(() => loadWorkflowSpec(traversal, root)).toThrow(/outside/);
  });

  test("allows in-root spec paths whose filename starts with '..'", () => {
    const root = path.join(scratch, "workflows");
    mkdirSync(root, { recursive: true });
    const inside = path.join(root, "..still-inside.yaml");
    writeFileSync(
      inside,
      `id: ok
title: ok
required_sequence:
  - event: agent_started
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.2
`,
      "utf8",
    );
    expect(() => loadWorkflowSpec(inside, root)).not.toThrow();
  });

  test("loadAllWorkflowSpecs ignores non-yaml files in dir", () => {
    const root = path.join(scratch, "workflows");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "README.md"), "not a spec\n", "utf8");
    writeFileSync(
      path.join(root, "a.yaml"),
      `id: a
title: a
required_sequence:
  - event: agent_started
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.2
`,
      "utf8",
    );
    const specs = loadAllWorkflowSpecs(root);
    expect(specs.length).toBe(1);
    expect(specs[0].id).toBe("a");
  });

  test("loadAllWorkflowSpecs rejects duplicate ids across files", () => {
    const root = path.join(scratch, "workflows");
    mkdirSync(root, { recursive: true });
    const body = `id: dup
title: dup
required_sequence:
  - event: agent_started
scoring:
  required_steps_weight: 0.5
  forbidden_steps_weight: 0.3
  evidence_quality_weight: 0.2
`;
    writeFileSync(path.join(root, "a.yaml"), body, "utf8");
    writeFileSync(path.join(root, "b.yaml"), body, "utf8");
    expect(() => loadAllWorkflowSpecs(root)).toThrow(/Duplicate workflow spec id "dup"/);
  });
});
