// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Shared in-memory object factories for tests.
 *
 * These build canonical test doubles (proposal rows, agent profiles, config
 * objects) that were previously copy-pasted verbatim across many test files.
 */

import type { Proposal } from "../../src/commands/proposal/repository";
import type { AkmConfig } from "../../src/core/config/config";
import type { AgentProfile } from "../../src/integrations/agent/profiles";

/**
 * A config that turns the LLM-as-judge quality gate OFF for reflect/distill
 * MECHANICS tests that don't exercise the judge.
 *
 * The gate defaults ON (`lesson_quality_gate` → `distill.qualityGate.enabled
 * ?? true`), and after 07 P0-2 it fails CLOSED when the judge can't render a
 * verdict — which is exactly the case in the test sandbox (no LLM configured,
 * so `getDefaultLlmConfig` returns null and the gate rejects before any chat
 * call). Passing this as `options.config` skips the gate so these tests stay
 * focused on reflect/distill mechanics. The dedicated fail-closed behavior is
 * covered by `tests/commands/improve/quality-gate-fail-closed.test.ts`.
 *
 * The fixture includes a named agent engine because reflect resolves through
 * the same strict engine boundary in tests and production.
 */
export function quietQualityGateConfig(): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    engines: {
      "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
    },
    defaults: { engine: "fake-agent", improveStrategy: "default" },
    improve: {
      strategies: { default: { processes: { distill: { qualityGate: { enabled: false } } } } },
    },
  } as AkmConfig;
}

/**
 * A pending `reflect`-sourced proposal for `ref` with a fixed timestamp and a
 * `# proposal` body. The id is `proposal-<ref>` with non-alphanumerics slugged.
 */
export function makeProposal(ref: string): Proposal {
  return {
    id: `proposal-${ref.replace(/[^a-z0-9-]/gi, "-")}`,
    ref,
    status: "pending",
    source: "reflect",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    payload: { content: "# proposal" },
  };
}

/**
 * A `fake-agent` captured-output agent profile. `overrides` shallow-merge over
 * the defaults.
 */
export function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "fake-agent",
    bin: "fake-agent",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH"],
    parseOutput: "text",
    ...overrides,
  };
}

/**
 * A minimal single-filesystem-source config pointing at `stashDir`.
 */
export function makeConfig(stashDir: string): AkmConfig {
  return {
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
  } as AkmConfig;
}
