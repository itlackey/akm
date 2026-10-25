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
 * - **The user's logins** (the opencode host): OpenCode 2 keeps credentials in its
 *   database. The host keeps its sessions in akm's database and has its credential
 *   service read the user's, so their logins work and a refreshed token is written
 *   back where their own OpenCode finds it. OpenCode's database layer applies every
 *   migration a file it opens has not had, and akm changes no file it does not own,
 *   so a user's database that has not had them all is left alone, with a warning.
 * - **akm's own roots** (an isolated host): OpenCode keeps its logs, repositories
 *   and binaries under akm's data and cache directories, and loads no config
 *   directory of the user's.
 */

import path from "node:path";
import { getCacheDir, getDataDir, getStateDir } from "../../../../core/paths";
import { warnOnce } from "../../../../core/warn";
import { openDatabase } from "../../../../storage/database";
import type { EmbeddedHost } from "./host";
import type { HostSpec } from "./host-spec";

async function load() {
  const [sdk, plugin, restart, global, credential, database, migration, effect] = await Promise.all([
    import("@opencode/sdk/effect"),
    import("@opencode/core/plugin/promise"),
    import("@opencode/core/session/execution/restart"),
    import("@opencode/util/global"),
    import("@opencode/core/credential"),
    import("@opencode/core/database/database"),
    import("@opencode/core/database/migration.gen"),
    import("effect"),
  ]);
  return { sdk, plugin, restart, global, credential, database, migration, effect };
}

/** Whether the user's database at `file` has had every migration id in `known`, read with SQLite read-only; warns once when not. */
function upToDate(file: string, known: readonly string[]): boolean {
  const db = openDatabase(file, { readonly: true, create: false });
  let had = 0;
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration'").get()) {
      const ids = new Set(
        db
          .prepare<{ id: string }>("SELECT id FROM migration")
          .all()
          .map((row) => row.id),
      );
      had = known.filter((id) => ids.has(id)).length;
    }
  } finally {
    db.close();
  }
  if (had === known.length) return true;
  warnOnce(
    `opencode-logins-behind:${file}`,
    `Your OpenCode database is older than akm's embedded OpenCode (ledger ${had} vs ${known.length}); upgrade OpenCode to use its logins from akm.`,
  );
  return false;
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

/** Start the embedded OpenCode `spec` describes; aborting `signal` while it starts stops the start and releases what it had begun. */
export async function createSdkHost(spec: HostSpec, signal?: AbortSignal): Promise<EmbeddedHost> {
  const { sdk, plugin, restart, global, credential, database, migration, effect } = await load();
  const { Effect, Exit, Layer, References, Scope, Stream } = effect;
  const run = <A>(work: import("effect").Effect.Effect<A, unknown>, signal?: AbortSignal): Promise<A> =>
    Effect.runPromise(
      work.pipe(Effect.provideService(References.MinimumLogLevel, "None")),
      signal ? { signal } : undefined,
    );

  /** OpenCode's credential service, pointed at the user's database: it reads their logins and writes a refreshed token back, as a second OpenCode process would. */
  const readLogins = (userDatabase: string) =>
    credential.Credential.node.replace(
      credential.Credential.node.mapLayer(
        (layer) => Layer.provide(layer, database.Database.layer({ path: userDatabase })) as never,
      ),
    );
  const userDatabase = spec.credentialsFrom;
  const known = migration.migrations.map(({ id }) => id);
  const logins = userDatabase && upToDate(userDatabase, known) ? [readLogins(userDatabase)] : [];
  const inertSweep = Layer.succeed(restart.SessionRestart.Service, { resumeSuspendedSessions: Effect.void });
  const overrides = [
    restart.SessionRestart.node.replace(inertSweep),
    ...(spec.isolated ? [global.Global.node.replace(global.Global.layerWith(akmRoots()))] : []),
    ...logins,
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
          ...(spec.configDirectory ? { directory: spec.configDirectory } : {}),
        },
        plugins: [plugin.PluginPromise.fromPromise(spec.plugin)],
        log: { level: "error", emit: () => {} },
      },
      { overrides },
    ).pipe(Effect.provideService(Scope.Scope, scope)),
    signal,
  ).catch(async (error: unknown) => {
    await close();
    throw error;
  });

  // The SDK's generated input types wrap every field in an indexed-access type; `EmbeddedHost` is the contract
  // akm codes against, so each input crosses this boundary as the narrow type it was written to.
  const sessions = client.sessions;
  return {
    sessions: {
      create: (input, options) => run(sessions.create(input as never), options?.signal) as Promise<{ id: string }>,
      environment: (input, options) => run(sessions.environment(input as never), options?.signal),
      instructions: {
        entry: { put: (input, options) => run(sessions.instructions.entry.put(input as never), options?.signal) },
      },
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
