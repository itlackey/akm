// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one place akm touches `@opencode/sdk` (core principle 11): it starts an
 * embedded OpenCode from a {@link HostSpec} and presents it as the narrow
 * {@link EmbeddedHost}. No binary, no server, no port: OpenCode's router runs in
 * this process. The SDK, `@opencode/core`, `@opencode/util` and `effect` are
 * imported lazily, so a command that never runs an agent never loads them.
 *
 * - **Through the effect entry.** `OpenCode.create(options, embed)` of the
 *   promise entry drops `embed`; `@opencode/sdk/effect` passes it on. Its client
 *   returns Effects, so each call akm makes is run here, quietly, as a promise.
 * - **No resume sweep.** At every start OpenCode resumes each top-level session
 *   whose turn never finished, with no check that another process owns it. akm
 *   shares one database between processes, so that would run an interrupted or
 *   timed-out turn again, under whichever process started next. The sweep is
 *   replaced by an inert one.
 * - **akm's own roots** (an isolated host): OpenCode keeps its logs, repositories
 *   and binaries under akm's data and cache directories, and loads no config
 *   directory of the user's.
 */

import path from "node:path";
import { getCacheDir, getDataDir, getStateDir } from "../../../../core/paths";
import type { EmbeddedHost, HostSpec } from "./host";

async function load() {
  const [sdk, plugin, restart, global, effect] = await Promise.all([
    import("@opencode/sdk/effect"),
    import("@opencode/core/plugin/promise"),
    import("@opencode/core/session/execution/restart"),
    import("@opencode/util/global"),
    import("effect"),
  ]);
  return { sdk, plugin, restart, global, effect };
}

/** The directories OpenCode keeps its own files under on the runtime host. */
function akmRoots() {
  const data = path.join(getDataDir(), "opencode");
  const cache = path.join(getCacheDir(), "opencode");
  return {
    data,
    cache,
    config: path.join(data, "config"),
    state: path.join(getStateDir(), "opencode"),
    log: path.join(data, "log"),
    repos: path.join(data, "repos"),
    bin: path.join(cache, "bin"),
  };
}

/** Start the embedded OpenCode `spec` describes. */
export async function createSdkHost(spec: HostSpec): Promise<EmbeddedHost> {
  const { sdk, plugin, restart, global, effect } = await load();
  const { Effect, Exit, Layer, References, Scope, Stream } = effect;
  const run = <A>(work: import("effect").Effect.Effect<A, unknown>, signal?: AbortSignal): Promise<A> =>
    Effect.runPromise(
      work.pipe(Effect.provideService(References.MinimumLogLevel, "None")),
      signal ? { signal } : undefined,
    );

  const inertSweep = Layer.succeed(restart.SessionRestart.Service, { resumeSuspendedSessions: Effect.void });
  const overrides = [
    restart.SessionRestart.node.replace(inertSweep),
    ...(spec.isolated ? [global.Global.node.replace(global.Global.layerWith(akmRoots()))] : []),
  ];
  const scope = await Effect.runPromise(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  const client = await run(
    sdk.OpenCode.create(
      {
        database: { path: spec.database },
        models: { fetch: spec.fetchModels },
        config: {
          ...(spec.isolated ? { project: false, claude: false } : {}),
          ...(spec.content ? { content: JSON.stringify(spec.content) } : {}),
        },
        plugins: [plugin.PluginPromise.fromPromise(spec.plugin)],
        log: { level: "error", emit: () => {} },
      },
      { overrides },
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  ).catch(async (error: unknown) => {
    await close();
    throw error;
  });

  const sessions = client.sessions;
  return {
    sessions: {
      create: (input) => run(sessions.create(input as never)) as Promise<{ id: string }>,
      environment: (input) => run(sessions.environment(input as never)),
      instructions: { entry: { put: (input) => run(sessions.instructions.entry.put(input as never)) } },
      prompt: (input, options) => run(sessions.prompt(input as never), options?.signal) as Promise<{ id: string }>,
      wait: (input, options) => run(sessions.wait(input as never), options?.signal),
      interrupt: async (input) => {
        await run(sessions.interrupt(input as never));
      },
      form: { cancel: (input) => run(sessions.form.cancel(input as never)) },
    },
    message: { list: (input) => run(client.message.list(input as never)) as never },
    permission: { reply: (input) => run(client.permission.reply(input as never)) },
    events: {
      forEach: (handler, signal) =>
        run(
          Stream.runForEach(client.events.subscribe(), (event) => Effect.promise(() => handler(event))),
          signal,
        ),
    },
    close,
  };
}
