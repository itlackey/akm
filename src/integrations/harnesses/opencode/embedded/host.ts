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

import { isRecord } from "../../../../core/common";
import { type HostKind, type HostSpec, specFor } from "./host-spec";
import type { SessionRegistry } from "./plugin";
import { createSdkHost } from "./sdk-host";

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

/** A started host, with the settings of the sessions it is running. */
export interface HostHandle {
  readonly host: EmbeddedHost;
  readonly sessions: SessionRegistry;
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

async function start(kind: HostKind): Promise<HostHandle> {
  const sessions: SessionRegistry = new Map();
  let started: EmbeddedHost | undefined;
  const host = await createHost(
    specFor(kind, sessions, async (sessionID, variables) => {
      await started?.sessions.environment({ sessionID, variables });
    }),
  );
  started = host;
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

/** Closes in progress, started by whoever: `closeOpencodeSdk` waits for all of them, not only its own. */
let closing: Promise<void> = Promise.resolve();

/** Close every embedded OpenCode this process started. */
export function closeOpencodeSdk(): Promise<void> {
  const open = [...hosts.values()];
  hosts.clear();
  const closed = Promise.all(
    open.map(async (handle) => (await handle.catch(() => undefined))?.host.close().catch(() => {})),
  ).then(() => {});
  closing = Promise.all([closing, closed]).then(() => {});
  return closing;
}
