// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { stringify as yamlStringify } from "yaml";
import { compileWorkflowProgram } from "../../../src/workflows/ir/compile";
import { canonicalPlanJson, computePlanHash } from "../../../src/workflows/ir/plan-hash";
import { parseWorkflowProgram } from "../../../src/workflows/program/parser";
import { PROGRAM_RETRY_REASONS } from "../../../src/workflows/program/schema";
import { fuzzSeeds, Rng, withSeed } from "./_rng";

/**
 * Seeded fuzz for the YAML workflow-program frontend (`program/parser.ts` +
 * `ir/compile.ts`).
 *
 * A generator emits random VALID programs (1-15 steps; unit/map/route mix;
 * grammar-legal ids/params/schemas/budgets/gates; route targets constrained to
 * strictly-later steps) and a separate generator emits INVALID variants (bad
 * id, duplicate id, self/backward route, unknown key, bad budget). Programs are
 * serialized with the same `yaml` library the parser reads, so a valid program
 * is always valid YAML — a reported failure is a real semantic bug, never an
 * accidental quoting artifact.
 *
 * Properties (each iteration reproducible from its printed seed):
 *   - the parser NEVER throws (returns errors);
 *   - the compiler NEVER throws on parse-ok input;
 *   - compilation is DETERMINISTIC — same program ⇒ same canonical plan JSON
 *     and the same `computePlanHash`;
 *   - the plan ROUND-TRIPS through plain JSON unchanged;
 *   - every invalid variant produces at least one validation error, and (where
 *     the category has a distinctive message) names the problem.
 *
 * The hand-written goldens live in `program-parser.test.ts` / `ir-compile.test.ts`.
 */

type Yaml = Record<string, unknown>;

const STEP_IDS = [
  "build",
  "review",
  "ship",
  "a_b",
  "n-1",
  "Deploy",
  "x",
  "step_2",
  "gate_it",
  "wrap-up",
  "route_x",
  "z9",
];
const PARAM_NAMES = ["items", "changed_files", "target", "n", "Flag", "the_input"];
const IDENT = ["files", "verdict", "x", "count", "a_b", "Result"] as const;
const TIMEOUTS = ["500ms", "5s", "10m", "none", "300", "1500ms"] as const;
const RUNNERS = ["llm", "agent", "sdk", "inherit"] as const;
const REDUCERS = ["collect", "vote"] as const;
const ON_ERROR = ["fail", "continue"] as const;
const ISOLATION = ["none", "worktree"] as const;

/** 0-2 trailing `.ident` / `[n]` path segments (compile validates only the root). */
function randPath(rng: Rng): string {
  let out = "";
  const n = rng.int(3);
  for (let i = 0; i < n; i++) out += rng.bool() ? `.${rng.pick(IDENT)}` : `[${rng.int(5)}]`;
  return out;
}

/** A grammar-legal reference for free-text instructions. */
function instructionRef(rng: Rng, params: string[], earlier: string[], inMap: boolean): string {
  const opts: Array<() => string> = [];
  if (params.length) opts.push(() => `\${{ params.${rng.pick(params)} }}`);
  if (earlier.length) opts.push(() => `\${{ steps.${rng.pick(earlier)}.output${randPath(rng)} }}`);
  if (inMap) {
    opts.push(() => `\${{ item }}`);
    opts.push(() => `\${{ item_index }}`);
  }
  return opts.length ? rng.pick(opts)() : "";
}

/** A single whole-value reference for `map.over` / `route.input`. */
function wholeValueRef(rng: Rng, params: string[], earlier: string[]): string {
  const opts: Array<() => string> = [];
  if (params.length) opts.push(() => `\${{ params.${rng.pick(params)} }}`);
  if (earlier.length) opts.push(() => `\${{ steps.${rng.pick(earlier)}.output${randPath(rng)} }}`);
  // params is always non-empty by construction, so opts is never empty.
  return rng.pick(opts)();
}

/** Free-text instructions with 0-3 embedded valid refs (always non-empty). */
function instructions(rng: Rng, params: string[], earlier: string[], inMap: boolean): string {
  const parts: string[] = ["Do the work"];
  const refCount = rng.int(4);
  for (let i = 0; i < refCount; i++) {
    const ref = instructionRef(rng, params, earlier, inMap);
    if (ref) parts.push(ref);
    parts.push("then continue");
  }
  return `${parts.join(" ")}.`;
}

/** A small schema from the supported subset (any plain object is accepted). */
function schema(rng: Rng): Yaml {
  switch (rng.int(3)) {
    case 0:
      return { type: "array", items: { type: "string" } };
    case 1:
      return { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
    default:
      return { type: "string" };
  }
}

function unitBlock(rng: Rng, params: string[], earlier: string[], inMap: boolean): Yaml {
  const unit: Yaml = { instructions: instructions(rng, params, earlier, inMap) };
  if (rng.bool(0.4)) unit.runner = rng.pick(RUNNERS);
  if (rng.bool(0.3)) unit.profile = "reviewer";
  if (rng.bool(0.3)) unit.model = rng.pick(["fast", "deep", "balanced"]);
  if (rng.bool(0.3)) unit.timeout = rng.pick(TIMEOUTS);
  if (rng.bool(0.25)) unit.on_error = rng.pick(ON_ERROR);
  if (rng.bool(0.2)) unit.output = schema(rng);
  if (rng.bool(0.2)) unit.env = [`env:secret_${rng.int(5)}`];
  if (rng.bool(0.15)) unit.isolation = rng.pick(ISOLATION);
  if (rng.bool(0.2)) {
    unit.retry = {
      max: rng.range(1, 3),
      on: rng.shuffle(PROGRAM_RETRY_REASONS).slice(0, rng.range(1, 2)),
    };
  }
  return unit;
}

function gateBlock(rng: Rng): Yaml {
  const gate: Yaml = { criteria: Array.from({ length: rng.range(1, 3) }, (_, i) => `criterion ${i + 1} is met`) };
  if (rng.bool(0.4)) gate.max_loops = rng.range(1, 4);
  return gate;
}

/** Build a random VALID program object (YAML surface, snake_case keys). */
function validProgram(rng: Rng): { yaml: Yaml; ids: string[] } {
  const stepCount = rng.range(1, 15);
  const ids = rng.shuffle(STEP_IDS).slice(0, stepCount);
  // Backfill synthetic ids if the pool is smaller than the step count.
  while (ids.length < stepCount) ids.push(`s${ids.length}`);

  const paramCount = rng.range(1, 3);
  const paramNames = rng.shuffle(PARAM_NAMES).slice(0, paramCount);
  const params: Yaml = {};
  for (const name of paramNames) params[name] = schema(rng);

  const steps: Yaml[] = ids.map((id, index) => {
    const earlier = ids.slice(0, index);
    const later = ids.slice(index + 1);
    const step: Yaml = { id };
    if (rng.bool(0.4)) step.title = `Step ${index + 1}`;

    // A route needs at least one strictly-later target.
    const canRoute = later.length > 0;
    const kind = canRoute && rng.bool(0.25) ? "route" : rng.bool(0.4) ? "map" : "unit";

    if (kind === "unit") {
      step.unit = unitBlock(rng, paramNames, earlier, false);
      if (rng.bool(0.2)) step.output = schema(rng);
      if (rng.bool(0.3)) step.gate = gateBlock(rng);
    } else if (kind === "map") {
      const map: Yaml = {
        over: wholeValueRef(rng, paramNames, earlier),
        unit: unitBlock(rng, paramNames, earlier, true),
      };
      if (rng.bool(0.4)) map.concurrency = rng.range(1, 8);
      if (rng.bool(0.5)) map.reducer = rng.pick(REDUCERS);
      step.map = map;
      if (rng.bool(0.2)) step.output = schema(rng);
      if (rng.bool(0.3)) step.gate = gateBlock(rng);
    } else {
      // route — targets are strictly-later ids; matches are unique.
      const branchCount = rng.range(1, Math.min(3, later.length));
      const targets = rng.shuffle(later).slice(0, branchCount);
      const when: Yaml = {};
      targets.forEach((target, i) => {
        when[`match_${i}`] = target;
      });
      const route: Yaml = { input: wholeValueRef(rng, paramNames, earlier), when };
      if (rng.bool(0.4)) route.default = rng.pick(later);
      step.route = route;
    }
    return step;
  });

  const program: Yaml = { version: 1, name: `wf-${rng.int(1000)}`, params, steps };
  if (rng.bool(0.3)) program.description = "a fuzzed workflow";
  if (rng.bool(0.3)) {
    const defaults: Yaml = {};
    if (rng.bool()) defaults.runner = rng.pick(RUNNERS);
    if (rng.bool()) defaults.on_error = rng.pick(ON_ERROR);
    if (rng.bool()) defaults.timeout = rng.pick(TIMEOUTS);
    if (Object.keys(defaults).length) program.defaults = defaults;
  }
  if (rng.bool(0.3)) {
    const budget: Yaml = {};
    if (rng.bool()) budget.max_tokens = rng.range(1, 100_000);
    if (rng.bool()) budget.max_units = rng.range(1, 100);
    if (Object.keys(budget).length) program.budget = budget;
  }
  return { yaml: program, ids };
}

type Corruption = { yaml: Yaml; expect: string };

/** Apply ONE semantic corruption to a fresh valid program. */
function invalidProgram(rng: Rng): Corruption {
  const { yaml, ids } = validProgram(rng);
  const steps = yaml.steps as Yaml[];
  const kind = rng.pick(["bad_id", "dup_id", "self_route", "backward_route", "unknown_key", "bad_budget"] as const);

  switch (kind) {
    case "bad_id": {
      const i = rng.int(steps.length);
      steps[i].id = rng.pick(["1leading", "has space", "dot.ted", "bad!", "a.b"]);
      return { yaml, expect: "invalid id" };
    }
    case "dup_id": {
      if (steps.length < 2) {
        steps.push({ id: ids[0], unit: { instructions: "dup" } });
      } else {
        steps[1].id = steps[0].id;
      }
      return { yaml, expect: "Duplicate step id" };
    }
    case "self_route": {
      const i = rng.int(steps.length);
      const self = steps[i].id as string;
      delete steps[i].unit;
      delete steps[i].map;
      steps[i].route = {
        input: `\${{ params.${(yaml.params && Object.keys(yaml.params)[0]) || "x"} }}`,
        when: { m: self },
      };
      return { yaml, expect: "route to itself" };
    }
    case "backward_route": {
      // Make the LAST step route back to the first — always a backward edge.
      const last = steps.length - 1;
      if (last === 0) {
        steps.push({ id: "tail", route: { input: `\${{ params.x }}`, when: { m: steps[0].id as string } } });
      } else {
        delete steps[last].unit;
        delete steps[last].map;
        steps[last].route = { input: `\${{ params.x }}`, when: { m: steps[0].id as string } };
      }
      return { yaml, expect: "backward" };
    }
    case "unknown_key": {
      const i = rng.int(steps.length);
      steps[i].bogus_key = 42;
      return { yaml, expect: "Unknown" };
    }
    default: {
      // bad_budget
      yaml.budget = rng.pick([{ max_tokens: 0 }, { max_units: -1 }, { max_tokens: 1.5 }, { max_units: "many" }]);
      return { yaml, expect: "budget" };
    }
  }
}

const SOURCE = { path: "workflows/fuzz.yaml" };

describe("workflow-program fuzz — valid programs parse, compile, are deterministic and round-trip", () => {
  const seeds = fuzzSeeds(120);
  test("parser/compiler never throw; plan hash is stable; plan round-trips through JSON", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const { yaml } = validProgram(rng);
        const text = yamlStringify(yaml);

        const parsed = parseWorkflowProgram(text, SOURCE);
        if (!parsed.ok) {
          throw new Error(
            `valid program failed to parse: ${parsed.errors.map((e) => `${e.line}:${e.message}`).join(" | ")}\n${text}`,
          );
        }

        const first = compileWorkflowProgram(parsed.program);
        if (!first.ok) {
          throw new Error(
            `valid program failed to compile: ${first.errors.map((e) => `${e.line}:${e.message}`).join(" | ")}\n${text}`,
          );
        }
        const second = compileWorkflowProgram(parsed.program);
        expect(second.ok).toBe(true);
        if (!second.ok) return;

        // Determinism: identical canonical plan JSON + identical hash.
        expect(canonicalPlanJson(second.plan)).toBe(canonicalPlanJson(first.plan));
        expect(computePlanHash(second.plan)).toBe(computePlanHash(first.plan));

        // Round-trip: the plan is plain JSON and survives serialize → parse.
        expect(JSON.parse(JSON.stringify(first.plan))).toEqual(first.plan);
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});

describe("workflow-program fuzz — invalid variants produce naming errors, never throw", () => {
  const seeds = fuzzSeeds(200);
  test("each corruption yields at least one validation error identifying the problem", () => {
    for (const seed of seeds) {
      withSeed(seed, () => {
        const rng = new Rng(seed);
        const { yaml, expect: expectedFragment } = invalidProgram(rng);
        const text = yamlStringify(yaml);

        // Parser never throws — errors are returned.
        const parsed = parseWorkflowProgram(text, SOURCE);

        if (parsed.ok) {
          // If it parsed, the compiler must reject it (and must not throw).
          const compiled = compileWorkflowProgram(parsed.program);
          expect(compiled.ok).toBe(false);
          return;
        }
        expect(parsed.errors.length).toBeGreaterThan(0);
        const joined = parsed.errors.map((e) => e.message).join(" | ");
        expect(joined).toContain(expectedFragment);
      });
    }
    expect(seeds.length).toBeGreaterThan(0);
  });
});
