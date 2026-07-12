// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contribution command cluster (`akm agent`, `akm lint`, `akm propose`) —
 * the asset authoring / validation / proposal-creation verbs. Extracted
 * verbatim from src/cli.ts (WS6) so the God Module shrinks; the
 * `main.subCommands.{agent,lint,propose}` keys and every command's args /
 * output shape stay byte-identical.
 *
 * These three handlers each branch on the result and call `process.exit`
 * conditionally (exit 1 on a failed dispatch / proposal, or on
 * `--fail-on-flagged` lint findings), so they keep the inline
 * `runWithJsonErrors` form rather than migrating to `defineJsonCommand`
 * (which is reserved for plain runWithJsonErrors+output handlers).
 *
 * NOTE on `propose` vs `proposal`: the proposal MANAGEMENT family
 * (list/show/accept/reject/…) lives in src/commands/proposal-cli.ts. The
 * `propose` (create) verb here is the asset-authoring entry point and shares
 * no private helper with that module — its path/name helpers come from the
 * shared src/core/asset-create.ts module, imported below.
 */

import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "citty";
import { getStringArg, parsePositiveIntFlag } from "../../cli/parse-args";
import { EXIT_CODES, output, runWithJsonErrors } from "../../cli/shared";
import { assertFlatAssetName, combineCreatePath, normalizeCreateSubPath } from "../../core/asset/asset-create";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import { akmLint } from "../lint/index";
import { akmPropose } from "../proposal/propose";
import { akmAgentDispatch } from "./agent-dispatch";

const EXIT_GENERAL = EXIT_CODES.GENERAL;

export const agentCommand = defineCommand({
  meta: {
    name: "agent",
    description:
      "Dispatch an agent CLI (opencode, claude, …) with an optional agent asset that provides the system prompt, model, and tool policy. Use <agent-ref> to embody a stash agent, --model to override the model, and --prompt/--command/--workflow to provide the task.",
  },
  args: {
    profile: {
      type: "positional",
      description: "Agent profile / platform to use (opencode, claude, …)",
      required: false,
    },
    "agent-ref": {
      type: "positional",
      description:
        "Optional agent asset ref (e.g. agent:code-reviewer). Loads system prompt, model, and tool policy from the stash asset.",
      required: false,
    },
    prompt: { type: "string", description: "Task prompt to pass to the agent" },
    command: { type: "string", description: "Load prompt from a command: asset" },
    workflow: { type: "string", description: "Load prompt from a workflow: asset" },
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
      if (!args.profile) {
        throw new UsageError(
          "Usage: akm agent <profile> [<agent-ref>] [--prompt <text>] [--model <model>]",
          "MISSING_REQUIRED_ARGUMENT",
          "Provide the agent profile name. Available profiles are listed in profiles.agent.",
        );
      }

      const timeoutMs = parsePositiveIntFlag(args["timeout-ms"], "--timeout-ms");

      const config = loadConfig();
      const { getDefaultLlmConfig } = await import("../../core/config/config.js");
      // After 0.8.0 the agent block IS the loaded AkmConfig.
      const agentConfig = config;

      // Resolve agent asset ref → extract system prompt, model, and tool policy.
      const agentRef = getStringArg(args, "agent-ref");

      let systemPrompt: string | undefined;
      let assetModel: string | undefined;
      let assetTools: import("../../sources/types.js").ShowResponse["toolPolicy"] | undefined;

      if (agentRef) {
        const { akmShowUnified } = await import("../read/show.js");
        const asset = await akmShowUnified({ ref: agentRef, detail: "full" });
        systemPrompt = typeof asset.content === "string" ? asset.content : undefined;
        assetModel = typeof asset.modelHint === "string" ? asset.modelHint : undefined;
        assetTools = asset.toolPolicy;
      }

      // --model flag wins over the asset's modelHint.
      const model = getStringArg(args, "model") ?? assetModel;

      const promptText = getStringArg(args, "prompt");
      const commandRef = getStringArg(args, "command");
      const workflowRef = getStringArg(args, "workflow");
      const cwd = getStringArg(args, "cwd");

      // Only build a dispatch request when there is something to dispatch — a
      // prompt, an agent asset, or a model override. When none of these are
      // present the agent is launched interactively (no injected prompt, no
      // platform-specific flags beyond the profile's base args).
      const hasDispatchContent = !!(promptText ?? commandRef ?? workflowRef ?? systemPrompt ?? model ?? assetTools);

      const result = await akmAgentDispatch({
        profileName: String(args.profile),
        prompt: promptText,
        commandRef,
        workflowRef,
        agentConfig,
        llmConfig: getDefaultLlmConfig(config),
        ...(hasDispatchContent
          ? {
              dispatch: {
                prompt: promptText ?? "",
                systemPrompt,
                model,
                tools: assetTools,
                ...(cwd ? { cwd } : {}),
              },
            }
          : {}),
        ...(cwd ? { cwd } : {}),
        ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
      });

      output("agent-result", result);

      if (!result.ok) {
        process.exit(EXIT_GENERAL);
      }
    });
  },
});

export const lintCommand = defineCommand({
  meta: {
    name: "lint",
    description:
      "Scan stash .md files for structural issues (unquoted colons, missing updated field, orphaned stubs, placeholder stubs, missing name/type, stale paths, broken refs in body text and in refs/xrefs/supersededBy/contradictedBy frontmatter). Use --fix to auto-fix Tier 1 issues. Exits 0 on success regardless of findings; use --fail-on-flagged for CI fail-on-finding behavior.",
  },
  args: {
    fix: {
      type: "boolean",
      alias: "auto-fix",
      description: "Apply auto-fixes in place (alias: --auto-fix)",
      default: false,
    },
    dir: { type: "string", description: "Override stash root directory (default: from config)" },
    "fail-on-flagged": {
      type: "boolean",
      description: "Exit non-zero when summary.flagged > 0 (CI-friendly). Default: exit 0 regardless of findings.",
      default: false,
    },
    type: {
      type: "string",
      description: "Only lint assets of this type (e.g. workflows, tasks, memories)",
      default: undefined,
    },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      const result = akmLint({
        fix: args.fix ?? false,
        dir: getStringArg(args, "dir"),
        typeFilter: getStringArg(args, "type"),
      });
      output("lint", result);
      if (args["fail-on-flagged"] && result.summary.flagged > 0) {
        process.exitCode = EXIT_GENERAL;
        return;
      }
    });
  },
});

export const proposeCommand = defineCommand({
  meta: {
    name: "propose",
    description: "Ask the configured agent CLI to author a brand-new asset and queue it as a proposal",
  },
  args: {
    // Optional in citty so run() is invoked when omitted; we re-validate
    // below to surface a structured UsageError (exit 2) instead of citty's
    // default help-banner exit-0.
    type: { type: "positional", description: "Asset type (skill, command, knowledge, lesson, ...)", required: false },
    name: {
      type: "positional",
      description: "Asset name (flat, no '/'; use --path for a subdirectory)",
      required: false,
    },
    path: {
      type: "string",
      description:
        "Relative subdirectory under the type dir to place the proposed asset in (e.g. 'release'). The filename comes from the name.",
    },
    task: { type: "string", description: "Task description for the agent (what should the asset do?)" },
    file: { type: "string", description: "Read the task or prompt text from a UTF-8 file" },
    profile: { type: "string", description: "Override the agent profile (defaults to agent.default)" },
    "timeout-ms": { type: "string", description: "Override the agent CLI timeout in milliseconds" },
  },
  async run({ args }) {
    await runWithJsonErrors(async () => {
      // citty silently shows help and exits 0 when required positionals are
      // omitted. Re-validate explicitly so the exit code is 2 (USAGE) and a
      // structured JSON error reaches scripted callers.
      const taskFromFlag = typeof args.task === "string" ? args.task : undefined;
      const fileFromFlag = typeof args.file === "string" ? args.file : undefined;
      if (!args.type || !args.name || (!taskFromFlag && !fileFromFlag)) {
        throw new UsageError(
          "Usage: akm propose <type> <name> (--task '<task>' | --file <path>).",
          "MISSING_REQUIRED_ARGUMENT",
          "Provide the asset type, name, and exactly one of --task or --file.",
        );
      }
      if (taskFromFlag && fileFromFlag) {
        throw new UsageError("Pass exactly one of --task or --file.", "INVALID_FLAG_VALUE");
      }
      // `name` is flat; subdirectory placement is `--path`'s job.
      assertFlatAssetName(String(args.name));
      const proposedName = combineCreatePath(normalizeCreateSubPath(getStringArg(args, "path")), String(args.name));
      const taskText = fileFromFlag ? fs.readFileSync(path.resolve(fileFromFlag), "utf8") : (taskFromFlag ?? "");
      const timeoutMs = parsePositiveIntFlag(args["timeout-ms"], "--timeout-ms");
      const result = await akmPropose({
        type: String(args.type),
        name: proposedName,
        task: taskText,
        profile: getStringArg(args, "profile"),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      output("propose", result);
      if (result.ok === false) {
        process.exit(EXIT_GENERAL);
      }
    });
  },
});
