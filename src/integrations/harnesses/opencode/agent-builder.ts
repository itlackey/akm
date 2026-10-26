// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenCode command builder: the `opencode run` CLI of the opencode harness
 * (#1244), for both majors, treated like the Claude and Codex CLIs. The user's
 * OpenCode owns its config, logins and sessions; akm hands it a prompt and reads
 * the reply from stdout.
 *
 * The prompt goes on stdin: `opencode run` alters an argv message (quotes change,
 * inner quotes are escaped) and a prompt that starts with `-` could be taken for
 * a flag; stdin is read verbatim. akm closes it after the write, which the CLI
 * needs: with stdin open it waits for more input.
 *
 * Agent work adds nothing: `opencode run`, the authored args as written, `--model` when akm
 * names one, `--agent` when the asset names one, and the prompt on stdin. The run is the
 * user's own, on their OpenCode as they have it set up.
 *
 * Model work is akm's own process. It sets `OPENCODE_DISABLE_FREE_MODELS` (OpenCode 2.1.2 and
 * later, where the variable first appears): with no usable provider, OpenCode 2 would
 * otherwise send akm's data to its hosted free model. The variable deletes every zero-cost
 * model of the `opencode` and `opencode-go` providers, so it has no place on agent work,
 * where it would override a model the user chose. On OpenCode 2 model work also gets
 * `--standalone`, which keeps the run to one process that ends with it (the default attaches
 * to a background service that outlives the CLI, is shared across users on one port, ignores
 * inline config and replays killed sessions at every start), and `--title`, which names the
 * session and spares the second model request that would otherwise generate a title.
 *
 * A binary whose version cannot be read runs model work as OpenCode 1, with one warning that says so.
 *
 * Model work drops the config's `args`, keeping the model they name, as the
 * Claude and Codex shells do. On OpenCode 2 it runs as {@link MODEL_WORK_AGENT},
 * an agent defined inline for the run whose tools are limited to reading and
 * searching, added to the user's own inline config; OpenCode 1 cannot be
 * restricted and runs it unrestricted, with a one-line warning.
 */

import { asRecord, parseJsonc } from "../../../core/common";
import { warnOnce } from "../../../core/warn";
import {
  type AgentDispatchRequest,
  type BuiltCommand,
  type HarnessBuilder,
  type HarnessSpawn,
  modelFromArgs,
  withoutLeading,
  withoutModelFlag,
} from "../harness";
import { detectOpencodeMajor, isOpencode2 } from "./version";

/** The agent OpenCode 2 runs akm's model work as, limited to reading and searching; the name also marks those sessions in the user's history (`./session-log-v2.ts`). */
export const MODEL_WORK_AGENT = "akm-model-work";

/**
 * The agent's definition, in OpenCode 2's native shape, passed inline so it merges over the user's config and is
 * never written anywhere. Its permission rules are default-deny with the reading tools allowed after it (the last
 * matching rule wins; measured on OpenCode 2.1.2): `*` denied removes every tool, one a plugin registers that akm has
 * never heard of included, and the allows give back `read`, `glob` and `grep` and, when the akm plugin is installed,
 * `akm_search`, `akm_show` and `akm_curate`. Nothing else is allowed. This limits the tools; a plugin's own `setup`
 * and hooks still run.
 */
export const MODEL_WORK_AGENT_DEFINITION = {
  mode: "primary",
  permissions: [
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "glob", "grep", "akm_search", "akm_show", "akm_curate"].map((action) => ({
      action,
      resource: "*",
      effect: "allow",
    })),
  ],
};

const CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";

/**
 * The inline config model work runs with: the user's own `OPENCODE_CONFIG_CONTENT` as it is, with akm's agent set on
 * `agents.akm-model-work`, the one key akm's definition wins. OpenCode 2 reads that native `agents` map over the
 * legacy `agent` one, so a same-named entry the user keeps in `agent` is left out rather than left to conflict. The
 * child's value is built from the parent's, so a provider, model or key the user keeps only there stays. It is read as
 * OpenCode reads it, as JSONC (comments and trailing commas), and written back as JSON; content that reads only once
 * its `{env:NAME}` references are replaced (one written outside a string) is read the way OpenCode replaces them
 * ({@link withEnvReferences}). Content that is not valid JSONC holding an object either way is left out, with one
 * warning.
 */
function modelWorkConfig(): string {
  const content = process.env[CONFIG_CONTENT_ENV]?.trim();
  const user = content ? userConfig(content) : undefined;
  if (content && !user) {
    warnOnce(
      "opencode-config-content",
      `${CONFIG_CONTENT_ENV} is not valid JSONC holding an object, so OpenCode model work runs without it.`,
    );
  }
  const config: Record<string, unknown> = {
    ...user,
    agents: { ...asRecord(user?.agents), [MODEL_WORK_AGENT]: MODEL_WORK_AGENT_DEFINITION },
  };
  const legacy = asRecord(user?.agent);
  if (legacy && Object.hasOwn(legacy, MODEL_WORK_AGENT)) {
    const { [MODEL_WORK_AGENT]: _replaced, ...others } = legacy;
    config.agent = others;
  }
  return JSON.stringify(config);
}

function userConfig(content: string): Record<string, unknown> | undefined {
  return jsoncObject(content) ?? jsoncObject(withEnvReferences(content));
}

function jsoncObject(content: string): Record<string, unknown> | undefined {
  try {
    return asRecord(parseJsonc(content));
  } catch {
    return undefined;
  }
}

/**
 * `{env:NAME}` replaced as OpenCode replaces it in this variable before it parses it (`ConfigVariable.substitute`):
 * by the variable's value, or nothing when it is unset or empty, as written where the result reads as JSONC, else
 * escaped as the inside of a JSON string. A `{file:path}` is left for the OpenCode akm runs, which replaces it against
 * its own directory, as it would in-process.
 */
function withEnvReferences(content: string): string {
  const replaced = (escaped: boolean): string =>
    content.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
      const value = process.env[name] || "";
      return escaped ? JSON.stringify(value).slice(1, -1) : value;
    });
  const raw = replaced(false);
  try {
    parseJsonc(raw);
    return raw;
  } catch {
    return replaced(true);
  }
}

const NO_FREE_MODELS = { OPENCODE_DISABLE_FREE_MODELS: "1" };

export const opencodeBuilder: HarnessBuilder = {
  build({ bin, args }: HarnessSpawn, req: AgentDispatchRequest): BuiltCommand {
    const agent = req.agent ? ["--agent", req.agent] : [];
    const model = req.model ? ["--model", req.model] : [];
    if (req.prompt === undefined) {
      // An interactive launch is the TUI, which `run` (headless) is not.
      const authored = withoutLeading(args, "run");
      return { argv: [bin, ...(req.model ? withoutModelFlag(authored) : authored), ...agent, ...model] };
    }

    if (!req.modelWork) {
      return { argv: [bin, ...(req.model ? withoutModelFlag(args) : args), ...agent, ...model], stdin: req.prompt };
    }

    const oc2 = isOpencode2(bin);
    if (!oc2 && detectOpencodeMajor(bin).reportedMajor === undefined) {
      warnOnce(
        `opencode-version-unreadable:${bin}`,
        `Could not read the version of ${bin}, so akm runs its model work as OpenCode 1: no --standalone (an OpenCode 2 would attach to its shared background service) and unrestricted. Check \`${bin} --version\`.`,
      );
    }
    if (!oc2) {
      warnOnce(
        "opencode-1-model-work",
        "OpenCode 1 cannot restrict its tools, so model work on it runs unrestricted, in a scratch directory. OpenCode 2 limits its tools to reading and searching.",
      );
    }
    const named = req.model ?? modelFromArgs(args);
    return {
      argv: [
        bin,
        "run",
        ...(oc2 ? ["--standalone", "--title", "akm", "--agent", MODEL_WORK_AGENT] : []),
        ...(named ? ["--model", named] : []),
      ],
      env: { ...NO_FREE_MODELS, ...(oc2 ? { [CONFIG_CONTENT_ENV]: modelWorkConfig() } : {}) },
      stdin: req.prompt,
    };
  },
};
