// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The embedded OpenCode hosts akm runs, and what akm asks of one.
 *
 * A process runs at most two, created on first use and kept until
 * {@link closeOpencodeSdk}: the `runtime` host, akm's own agent runtime driven
 * by the user's connections, and the `opencode` host, the user's own OpenCode
 * (their config, providers and logins) for the opencode harness. A host serves
 * any number of sessions; what differs per session (model, environment, request
 * fields) is set on the session, never on the host, so a host is never keyed by
 * its configuration.
 *
 * The SDK itself is reached only through `./sdk-host.ts`. Everything here and in
 * the runner depends on the narrow {@link EmbeddedHost} below.
 */

import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "@opencode/plugin";
import { isRecord } from "../../../../core/common";
import { loadConfig } from "../../../../core/config/config";
import { getDataDir } from "../../../../core/paths";
import { opencodeDataDir } from "../roots";
import { akmPlugin, type SessionRegistry } from "./plugin";
import { runtimeConfigContent } from "./runtime-config";
import { createSdkHost } from "./sdk-host";

export type HostKind = "runtime" | "opencode";

/** The text every session on a host is answered with when it asks for something only a person could give. */
const NOBODY_TO_ASK =
  "This is an unattended run: nobody can answer questions or approve requests. Continue without it.";

export interface SessionCreate {
  readonly title: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly location: { readonly directory: string };
  readonly model?: { readonly providerID: string; readonly id: string };
  readonly agent?: string;
  readonly permissions?: readonly {
    readonly action: string;
    readonly resource: string;
    readonly effect: "allow" | "deny" | "ask";
  }[];
}

export interface MessagePage {
  readonly data: unknown[];
  readonly cursor?: { readonly next?: string | null };
}

/** The part of an embedded OpenCode that akm uses. */
export interface EmbeddedHost {
  readonly sessions: {
    create(input: SessionCreate): Promise<{ readonly id: string }>;
    environment(input: { sessionID: string; variables: Record<string, string> }): Promise<void>;
    instructions: { entry: { put(input: { sessionID: string; key: string; value: string }): Promise<void> } };
    prompt(input: { sessionID: string; text: string }, options?: { signal?: AbortSignal }): Promise<{ id: string }>;
    wait(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<void>;
    interrupt(input: { sessionID: string }): Promise<void>;
    form: { cancel(input: { sessionID: string; formID: string; message: string }): Promise<void> };
  };
  readonly message: {
    /** A cursor carries its page's order; OpenCode refuses one combined with `order`. */
    list(input: { sessionID: string; limit: number; order?: "asc" | "desc"; cursor?: string }): Promise<MessagePage>;
  };
  readonly permission: {
    reply(input: { sessionID: string; requestID: string; decision: "reject"; message: string }): Promise<void>;
  };
  readonly events: {
    /** Call `handler` for every event until `signal` aborts or the host closes. */
    forEach(handler: (event: unknown) => Promise<void>, signal: AbortSignal): Promise<void>;
  };
  close(): Promise<void>;
}

/**
 * What akm asks of a new host: the real one is built from this by
 * `./sdk-host.ts`, a test's by a fake. The policy of each kind is decided here
 * ({@link specFor}); the SDK wiring that carries it out is `./sdk-host.ts`.
 */
export interface HostSpec {
  readonly kind: HostKind;
  /** Where akm keeps its OpenCode sessions. */
  readonly database: string;
  /** OpenCode config content akm supplies on top of what OpenCode loads. */
  readonly content?: Record<string, unknown>;
  readonly plugin: Plugin.Plugin;
  /** Cut off from the user's OpenCode: no project or Claude config, and its files under akm's own directories. */
  readonly isolated: boolean;
  /** Whether OpenCode may fetch the model catalog (models.dev); otherwise the bundled snapshot is used. */
  readonly fetchModels: boolean;
  /** The user's OpenCode database, whose logins the host reads (and refreshes) in place of its own. */
  readonly credentialsFrom?: string;
  /** The user's config directory, when `OPENCODE_CONFIG_DIR` moves it (the embedded OpenCode does not read that variable). */
  readonly configDirectory?: string;
}

/** A started host, with the settings of the sessions it is running. */
export interface HostHandle {
  readonly host: EmbeddedHost;
  readonly sessions: SessionRegistry;
}

/** Where akm keeps its OpenCode sessions: `<akm data dir>/opencode.db`. */
export function akmOpencodeDatabasePath(): string {
  const directory = getDataDir();
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, "opencode.db");
}

const hosts = new Map<HostKind, Promise<HostHandle>>();
let createHost: (spec: HostSpec) => Promise<EmbeddedHost> = createSdkHost;

/** Test seam: replace the host factory; undefined restores it. Hosts already open are closed. */
export function _setOpencodeHostFactoryForTests(
  factory: ((spec: HostSpec) => Promise<EmbeddedHost>) | undefined,
): void {
  createHost = factory ?? createSdkHost;
  void closeOpencodeSdk();
}

/** Answer everything that would wait for a person: every session on akm's hosts is unattended. */
async function answerRequests(host: EmbeddedHost, signal: AbortSignal): Promise<void> {
  try {
    await host.events.forEach(async (event) => {
      if (!isRecord(event) || !isRecord(event.data)) return;
      const data = event.data;
      if (event.type === "permission.asked" && typeof data.id === "string" && typeof data.sessionID === "string") {
        await host.permission
          .reply({ sessionID: data.sessionID, requestID: data.id, decision: "reject", message: NOBODY_TO_ASK })
          .catch(() => {});
      } else if (event.type === "form.created" && isRecord(data.form) && typeof data.form.id === "string") {
        const sessionID = typeof data.form.sessionID === "string" ? data.form.sessionID : undefined;
        if (sessionID) {
          await host.sessions.form.cancel({ sessionID, formID: data.form.id, message: NOBODY_TO_ASK }).catch(() => {});
        }
      }
    }, signal);
  } catch {
    // The host closed.
  }
}

/**
 * What each kind of host is. The runtime runs the user's connections and nothing
 * of the user's OpenCode. The opencode host is the user's OpenCode: their config
 * directory, providers and default model, with their logins read from their own
 * database (when it exists: akm never creates it) and akm's plugin added.
 */
function specFor(kind: HostKind, sessions: SessionRegistry): HostSpec {
  const database = akmOpencodeDatabasePath();
  const plugin = akmPlugin(sessions);
  if (kind === "runtime") {
    return {
      kind,
      database,
      plugin,
      content: runtimeConfigContent(loadConfig().connections),
      isolated: true,
      fetchModels: false,
    };
  }
  const userDatabase = path.join(opencodeDataDir(), "opencode.db");
  const configDirectory = process.env.OPENCODE_CONFIG_DIR?.trim();
  return {
    kind,
    database,
    plugin,
    isolated: false,
    fetchModels: true,
    ...(fs.existsSync(userDatabase) ? { credentialsFrom: userDatabase } : {}),
    ...(configDirectory ? { configDirectory } : {}),
  };
}

async function start(kind: HostKind): Promise<HostHandle> {
  const sessions: SessionRegistry = new Map();
  const host = await createHost(specFor(kind, sessions));
  const stop = new AbortController();
  void answerRequests(host, stop.signal);
  const close = host.close.bind(host);
  return {
    sessions,
    host: Object.assign(host, {
      close: async () => {
        stop.abort();
        await close();
      },
    }),
  };
}

/** The host of `kind`, started on first use. */
export function hostFor(kind: HostKind): Promise<HostHandle> {
  let handle = hosts.get(kind);
  if (!handle) {
    handle = start(kind);
    const started = handle;
    started.catch(() => {
      if (hosts.get(kind) === started) hosts.delete(kind);
    });
    hosts.set(kind, started);
  }
  return handle;
}

/** Close every embedded OpenCode this process started. */
export async function closeOpencodeSdk(): Promise<void> {
  const open = [...hosts.values()];
  hosts.clear();
  await Promise.all(open.map(async (handle) => (await handle.catch(() => undefined))?.host.close().catch(() => {})));
}
