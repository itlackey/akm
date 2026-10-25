// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one place akm touches `@opencode/sdk` (core principle 11): it starts an
 * embedded OpenCode from a {@link HostSpec} and presents it as the narrow
 * {@link EmbeddedHost}. No binary, no server, no port: OpenCode's router runs in
 * this process. The SDK, `@opencode/core`, `@opencode/util`, `@opencode/schema`
 * and `effect` are imported lazily, so a command that never runs an agent never
 * loads them.
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
 *   database. The host keeps its sessions in akm's database, and its credential
 *   service reads the user's with SQLite, read-only: akm changes no file it does
 *   not own. A login OpenCode would refresh before using it (an OAuth token at or
 *   near its expiry) is left out, with a warning: the refreshed token could not be
 *   written back, and the refresh would spend the refresh token the user's own
 *   OpenCode holds. Logins are read only from a database that has had every
 *   migration this OpenCode carries; an older one is not read, with a warning.
 * - **akm's own roots** (an isolated host): OpenCode keeps its logs, repositories
 *   and binaries under akm's data and cache directories, and loads no user or
 *   project config, though it still reads `~/.agents` and its system config.
 */

import path from "node:path";
import { isRecord } from "../../../../core/common";
import { getCacheDir, getDataDir, getStateDir } from "../../../../core/paths";
import { warnOnce } from "../../../../core/warn";
import { openDatabase } from "../../../../storage/database";
import type { EmbeddedHost } from "./host";
import type { HostSpec } from "./host-spec";

async function load() {
  const [sdk, plugin, restart, global, credential, legacy, migration, effect] = await Promise.all([
    import("@opencode/sdk/effect"),
    import("@opencode/core/plugin/promise"),
    import("@opencode/core/session/execution/restart"),
    import("@opencode/util/global"),
    import("@opencode/core/credential"),
    import("@opencode/schema/credential-legacy"),
    import("@opencode/core/database/migration.gen"),
    import("effect"),
  ]);
  return { sdk, plugin, restart, global, credential, legacy, migration, effect };
}

/** How long before an OAuth token expires OpenCode refreshes it rather than use it. */
const REFRESH_MARGIN_MS = 5 * 60_000;

interface StoredLogin {
  readonly id: string;
  readonly integrationID: string;
  readonly label: string;
  readonly value: unknown;
}

/**
 * The logins stored in the user's database at `file`, read with SQLite
 * read-only, in the order OpenCode's credential service lists them, each value
 * decoded by `decode`. An OAuth login OpenCode would refresh is left out, and
 * named once.
 */
function storedLogins(file: string, decode: (value: unknown) => unknown): StoredLogin[] {
  const db = openDatabase(file, { readonly: true, create: false });
  let rows: { id: string; integration_id: string | null; label: string; value: string }[];
  try {
    rows = db
      .prepare<(typeof rows)[number]>(
        "SELECT id, integration_id, label, value FROM credential ORDER BY active ASC, time_created ASC, id ASC",
      )
      .all();
  } finally {
    db.close();
  }
  const logins: StoredLogin[] = [];
  for (const row of rows) {
    if (!row.integration_id) continue;
    const value = decode(JSON.parse(row.value));
    if (isRecord(value) && value.type === "oauth" && Number(value.expires) <= Date.now() + REFRESH_MARGIN_MS) {
      warnOnce(
        `opencode-login-expired:${row.integration_id}`,
        `Your OpenCode login for ${row.integration_id} has expired; run OpenCode to refresh it.`,
      );
      continue;
    }
    logins.push({ id: row.id, integrationID: row.integration_id, label: row.label, value });
  }
  return logins;
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
  const { sdk, plugin, restart, global, credential, legacy, migration, effect } = await load();
  const { Effect, Exit, Layer, References, Schema, Scope, Stream } = effect;
  const run = <A>(work: import("effect").Effect.Effect<A, unknown>, signal?: AbortSignal): Promise<A> =>
    Effect.runPromise(
      work.pipe(Effect.provideService(References.MinimumLogLevel, "None")),
      signal ? { signal } : undefined,
    );

  /** OpenCode's credential service over the user's database, read-only: it gives out their logins and never writes. */
  const readLogins = (userDatabase: string) => {
    const decode = Schema.decodeUnknownSync(legacy.CredentialLegacy.Value);
    const logins = () =>
      storedLogins(userDatabase, decode).map((login) => new credential.Credential.Info(login as never));
    const refused = () => Effect.die(new Error("akm reads your OpenCode logins and never changes them."));
    return credential.Credential.node.replace(
      Layer.succeed(
        credential.Credential.Service,
        credential.Credential.Service.of({
          all: () => Effect.sync(logins),
          list: (integrationID) => Effect.sync(() => logins().filter((login) => login.integrationID === integrationID)),
          get: (id) => Effect.sync(() => logins().find((login) => login.id === id)),
          create: refused,
          activate: refused,
          remove: refused,
          // OpenCode's own provider plugins rewrite some stored rows as they start; the rewrite is not kept.
          update: () => Effect.void,
        }),
      ),
    );
  };
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
