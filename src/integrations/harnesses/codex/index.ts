// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenAI Codex CLI harness (P2 integration, plan §"The adapter contract").
 *
 * Per-harness barrel gathering the Codex integration surfaces:
 *   - agent command builder → ./agent-builder.ts    (codexBuilder)
 *   - result extractor      → ./result-extractor.ts (codexResultExtractor)
 *
 * It also defines {@link CodexHarness}, the {@link AkmHarness} descriptor that
 * `HARNESS_REGISTRY` registers. Dispatch-only: no native session-log reader or
 * config importer yet.
 */

import { caps } from "../shared";
import { BaseHarness } from "../types";
import { codexBuilder } from "./agent-builder";
import { codexResultExtractor } from "./result-extractor";

export { codexBuilder, codexResumeArgs, writeCodexOutputSchemaFile } from "./agent-builder";
export { codexResultExtractor } from "./result-extractor";

/**
 * OpenAI Codex CLI.
 *
 * Canonical id is `'codex'`; no alias or distinct runtime identity.
 */
export class CodexHarness extends BaseHarness {
  readonly id = "codex" as const;
  readonly displayName = "OpenAI Codex CLI";
  readonly aliases = [] as const;
  readonly agentBuilder = codexBuilder;
  readonly resultExtractor = codexResultExtractor;
  // ── Workflow-engine descriptor (plan §"Capability matrix", P2) ────────────
  // akm spawns `codex exec` locally per unit ⇒ local-runner.
  readonly pattern = "local-runner" as const;
  // `--output-schema <file>` enforces a caller-supplied JSON schema natively.
  readonly structuredOutput = "native-schema" as const;
  // No flag-shaped resume: codex resume is the `exec resume <id>` SUBCOMMAND
  // chain (see `codexResumeArgs` in ./agent-builder.ts).
  // Presence flag: CODEX_SANDBOX is stamped only on processes codex itself
  // spawns inside its sandbox, so it genuinely means "running under codex" —
  // but its VALUE (e.g. "seatbelt") is a sandbox mode, not a session id, so it
  // is registered as `presenceEnv` (harness inference only), never
  // `identityEnv` (whose values persist as agent_session_id). CODEX_HOME (the
  // matrix's other candidate) is deliberately NOT registered anywhere: it is a
  // user config-dir var commonly exported in shell profiles, so it would stamp
  // identity onto manual runs (see `AkmHarness.presenceEnv`).
  readonly presenceEnv = ["CODEX_SANDBOX"] as const;
  readonly capabilities = caps({
    agentDispatch: true,
    detection: true,
  });
}
