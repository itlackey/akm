// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm models` — the one place to see and change which model answers each alias
 * (`fast`, `balanced`, `reasoning`, and any the user adds) on a connection.
 *
 *   akm models [--connection NAME]                      the picks, beside what the endpoint lists
 *   akm models set <alias> <model> [--connection NAME]  change one
 *
 * Connections only: a harness's alias map is `harnesses.<name>.models`, edited
 * with `akm config set`.
 */
import { defineGroupCommand, defineJsonCommand, GLOBAL_OUTPUT_ARGS, output } from "../cli/shared";
import {
  type AkmConfig,
  type ConnectionConfig,
  defaultConnection,
  loadConfig,
  mutateConfig,
} from "../core/config/config";
import { resolveApiKey } from "../core/config/credentials";
import { entryModel, entryWithModel } from "../core/config/model-aliases";
import { ConfigError, UsageError } from "../core/errors";
import { redactUrlCredentials } from "../core/redaction";
import { warn } from "../core/warn";
import { selectionNotConfigured } from "../integrations/agent/resolution";
import { listEndpointModels } from "../llm/model-list";

const CONNECTION_ARG = {
  connection: {
    type: "string",
    description: "The connection to show or change (default: the default connection)",
  },
} as const;

/** The connection to show or change: the one named, else the default. */
function targetConnection(config: AkmConfig, name: string | undefined): { name: string; connection: ConnectionConfig } {
  if (name !== undefined) {
    const connection = config.connections?.[name];
    if (connection) return { name, connection };
    throw selectionNotConfigured(config, "connection", name);
  }
  const found = defaultConnection(config);
  if (found) return found;
  throw new ConfigError(
    "No connection is configured, so there are no model aliases to show or change. Run `akm setup` to add one.",
    "LLM_NOT_CONFIGURED",
  );
}

/** The models the connection's endpoint lists, or none when it cannot say. */
async function availableModels(name: string, connection: ConnectionConfig, probe: boolean): Promise<string[]> {
  if (!probe) return [];
  const apiKey = resolveApiKey(connection.apiKey, { connection: name }, connection.endpoint);
  const listed = await listEndpointModels({ endpoint: connection.endpoint, ...(apiKey ? { apiKey } : {}) });
  if (listed.ok) return listed.models;
  warn(`Could not list models from ${redactUrlCredentials(connection.endpoint)} (${listed.error}).`);
  return [];
}

/** Probing is the default, so only the opt-out is declared; citty parses `--no-probe` as `probe: false` (see `setup`'s flag in `cli.ts`). */
const PROBE_ARG = {
  "no-probe": {
    type: "boolean",
    description: "Do not ask the endpoint which models it lists.",
  },
} as const;

const probes = (args: object): boolean => (args as { probe?: boolean }).probe !== false;

export const modelsCommand = defineGroupCommand({
  meta: {
    name: "models",
    description:
      "Show which model answers each alias on a connection, beside the models its endpoint lists; `models set` changes one",
  },
  // The group runs the list itself, so it declares the output flags a leaf command would get from `defineJsonCommand`.
  args: { ...GLOBAL_OUTPUT_ARGS, ...CONNECTION_ARG, ...PROBE_ARG },
  // `akm models` is itself the list, so the bare group is not a usage error here.
  async defaultRun({ args }) {
    const { name, connection } = targetConnection(loadConfig(), args.connection);
    const aliases = Object.fromEntries(
      Object.entries(connection.models ?? {}).map(([alias, entry]) => [alias, entryModel(entry)]),
    );
    output("models", { connection: name, aliases, available: await availableModels(name, connection, probes(args)) });
  },
  subCommands: {
    set: defineJsonCommand({
      meta: {
        name: "set",
        description:
          "Make a model answer an alias on a connection, e.g. `akm models set reasoning glm-5`; an alias with request fields keeps them",
      },
      args: {
        alias: { type: "positional", required: true, description: "Alias: fast, balanced, reasoning, or your own" },
        model: { type: "positional", required: true, description: "The model's name on the endpoint" },
        ...CONNECTION_ARG,
        ...PROBE_ARG,
      },
      async run({ args }) {
        const alias = args.alias.trim();
        const model = args.model.trim();
        if (!alias || !model) {
          throw new UsageError(
            "Name an alias and a model: `akm models set <alias> <model>`.",
            "MISSING_REQUIRED_ARGUMENT",
          );
        }
        const { name, connection } = targetConnection(loadConfig(), args.connection);
        const available = await availableModels(name, connection, probes(args));
        if (available.length > 0 && !available.includes(model)) {
          warn(`"${model}" is not among the models ${name} lists; setting it anyway.`);
        }

        const before = connection.models?.[alias];
        mutateConfig((current) => {
          const target = targetConnection(current, name);
          const held = target.connection.models?.[alias];
          return {
            ...current,
            connections: {
              ...current.connections,
              [name]: {
                ...target.connection,
                models: { ...target.connection.models, [alias]: entryWithModel(held, model) },
              },
            },
          };
        });
        output("models-set", {
          connection: name,
          alias,
          model,
          previous: before === undefined ? null : entryModel(before),
        });
      },
    }),
  },
});
