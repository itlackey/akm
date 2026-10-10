// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contribution command cluster (`akm agent`, `akm lint`) — the asset
 * authoring / validation verbs. Extracted verbatim from src/cli.ts (WS6) so
 * the God Module shrinks; the `main.subCommands.{agent,lint}` keys and every
 * command's args / output shape stay byte-identical.
 *
 * These handlers branch on the result and set a non-zero `process.exitCode`
 * conditionally (exit 1 on a failed dispatch, or on `--fail-on-flagged` lint
 * findings) rather than emitting through the thrown-error path, so they keep
 * the inline `runWithJsonErrors` form rather than migrating to
 * `defineJsonCommand` (which is reserved for plain runWithJsonErrors+output
 * handlers). `process.exitCode` (not `process.exit()`) so the process still
 * exits via natural event-loop drain rather than skipping pending cleanup —
 * see R-067 / F4.
 *
 * NOTE: the asset-authoring `propose` verb (formerly here) moved to
 * `akm proposal new` (0.9 CLI overhaul, S8) — see
 * src/commands/proposal/propose-cli.ts.
 */

import fs from "node:fs";
import { defineCommand } from "citty";
import { getStringArg, parsePositiveIntFlag } from "../../cli/parse-args";
import { EXIT_CODES, GLOBAL_OUTPUT_ARGS, output, runWithJsonErrors } from "../../cli/shared";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { getHyphenatedBoolean } from "../../output/context";
import { akmLint } from "../lint/index";
import { akmAgentDispatch } from "./agent-dispatch";

const EXIT_GENERAL = EXIT_CODES.GENERAL;

export function readPromptStdin(read: () => string = () => fs.readFileSync(0, "utf8")): string {
  return read();
}

export const agentCommand = defineCommand({
  meta: {
    name: "agent",
    description:
      "Dispatch an agent CLI (opencode, claude, …) with an optional agent persona and model defaults. Use --prompt for work; stored commands run through akm command run. Nonempty tool requests require separate operator authorization and are rejected by the current CLI.",
  },
  args: {
    ...GLOBAL_OUTPUT_ARGS,
    "agent-ref": {
      type: "positional",
      description:
        "Optional agent asset ref (e.g. agents/code-reviewer). Resolves persona and model defaults; the current CLI rejects a nonempty tool request without separate operator authorization.",
      required: false,
    },
    prompt: { type: "string", description: "Task prompt to pass to the agent" },
    "prompt-stdin": {
      type: "boolean",
      description: "Read the task prompt from stdin (mutually exclusive with --prompt)",
      default: false,
    },
    engine: { type: "string", description: "Agent engine to use (default: defaults.engine)" },
    model: {
      type: "string",
      description:
        "Model override — accepts aliases (opus, sonnet, haiku) or exact platform model IDs. Overrides the model specified in the agent asset.",
    },
    "timeout-ms": { type: "string", description: "Override the agent CLI timeout in milliseconds" },
    cwd: {
      type: "string",
      description: "Working directory for the spawned agent (defaults to the current directory)",
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const timeoutMs = parsePositiveIntFlag(args["timeout-ms"], "--timeout-ms");

      const config = loadConfig();
      const agentConfig = config;

      // Preserve the selector; the common execution-source adapter resolves it.
      const agentRef = getStringArg(args, "agent-ref");

      const promptText = getStringArg(args, "prompt");
      const promptStdin = args["prompt-stdin"] === true;
      if (promptStdin && promptText !== undefined) {
        throw new UsageError("--prompt-stdin cannot be combined with --prompt.", "INVALID_FLAG_VALUE");
      }
      const cwd = getStringArg(args, "cwd");

      // The common invocation resolver loads a selected agent through its
      // owning bundle adapter. This CLI never re-reads/show-projects the file.
      const model = getStringArg(args, "model");

      const stdinPrompt = promptStdin ? readPromptStdin() : undefined;

      const result = await akmAgentDispatch({
        engine: getStringArg(args, "engine"),
        prompt: stdinPrompt ?? promptText,
        ...(agentRef === undefined ? {} : { agentRef }),
        agentConfig,
        ...(model === undefined ? {} : { selection: { model } }),
        ...(cwd ? { cwd } : {}),
        ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      });

      output("agent-result", result);

      if (!result.ok) {
        // R-067-style fix: this used to call `process.exit(EXIT_GENERAL)`
        // directly, which terminates synchronously and skips any pending
        // `finally`/cleanup up the call stack (including the dispatched
        // agent process' own bookkeeping). `output()` has already run above,
        // so there is nothing left in this handler that depends on
        // terminating immediately — `process.exitCode` + `return` (this is
        // the last statement anyway) lets the process exit naturally once
        // the event loop drains.
        process.exitCode = EXIT_GENERAL;
        return;
      }
    });
  },
});

export const lintCommand = defineCommand({
  meta: {
    name: "lint",
    description:
      "Scan bundle .md files for structural issues (unquoted colons, missing updated field, orphaned stubs, placeholder stubs, missing name/type, stale paths, broken refs in body text and in refs/xrefs/supersededBy/contradictedBy frontmatter). Use --fix to auto-fix Tier 1 issues. Exits 0 on success regardless of findings; use --fail-on-flagged for CI fail-on-finding behavior.",
  },
  args: {
    // R-051: `lint` is a raw `defineCommand` (not `defineJsonCommand`), so it
    // does not get `GLOBAL_OUTPUT_ARGS` for free. `--format`/`--detail`/
    // `--output` already parsed correctly here (this command has no
    // positional for a stray value to fall into), so this is purely a
    // `--help` visibility / consistency fix, not a behavior change.
    ...GLOBAL_OUTPUT_ARGS,
    fix: {
      type: "boolean",
      description: "Apply auto-fixes in place",
      default: false,
    },
    // Declared as its own arg rather than `alias: "auto-fix"`: citty's alias
    // handling (node:util parseArgs `short` options) only supports
    // SINGLE-character aliases. A
    // multi-char alias rendered in help as `-auto-fix` (one dash) and parsed
    // as a pile of junk single-char flags, so BOTH advertised spellings —
    // `-auto-fix` and `--auto-fix` — silently ran a plain lint while claiming
    // to fix. Two real boolean args, OR'd at the call site, work and render.
    "auto-fix": {
      type: "boolean",
      description: "Apply auto-fixes in place (same as --fix)",
      default: false,
    },
    dir: { type: "string", description: "Override bundle root directory (default: from config)" },
    "fail-on-flagged": {
      type: "boolean",
      description: "Exit non-zero when summary.flagged > 0 (CI-friendly). Default: exit 0 regardless of findings.",
      default: false,
    },
    // #884: NOT folded into `--fix`. Every other auto-fix repairs a structural
    // defect in the file it edits; this one DELETES an assertion the user (or
    // the improve pipeline) made about the belief graph, and it does so in
    // files that are themselves perfectly well-formed. That is a data decision,
    // so it stays opt-in behind its own flag even when `--fix` is present.
    "prune-dangling-edges": {
      type: "boolean",
      description:
        "Opt-in repair: drop supersededBy/contradictedBy entries whose target has neither a file nor a prune tombstone. Modifies memories — review the plain `akm lint` report first.",
      default: false,
    },
    type: {
      type: "string",
      description:
        "Only lint assets of this type (e.g. workflows, tasks, memories). akm bundles only — every other adapter validates the whole bundle and warns that the flag had no effect.",
      default: undefined,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = await akmLint({
        fix: args.fix === true || getHyphenatedBoolean(args, "auto-fix"),
        dir: getStringArg(args, "dir"),
        typeFilter: getStringArg(args, "type"),
        pruneDanglingEdges: getHyphenatedBoolean(args, "prune-dangling-edges"),
      });
      output("lint", result);
      if (args["fail-on-flagged"] && result.summary.flagged > 0) {
        process.exitCode = EXIT_GENERAL;
        return;
      }
    });
  },
});
