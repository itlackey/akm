// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The embedded OpenCode hosts akm runs, and what akm asks of one.
 *
 * A process runs at most two, created on first use and kept until
 * {@link closeOpencodeSdk}: the `runtime` host, akm's own agent runtime driven
 * by the connections its runs bring, and the `opencode` host, the user's own
 * OpenCode (their config, providers and logins) for the opencode harness. A host
 * serves any number of sessions; what differs per session (model, environment,
 * request fields) is set on the session, and the connection a runtime run brings
 * is declared on the host as it arrives, so a host is never keyed by its
 * configuration.
 *
 * The SDK itself is reached only through `./sdk-host.ts`. Everything here and in
 * the runner depends on the narrow {@link EmbeddedHost} below.
 */

import { isRecord, toErrorMessage } from "../../../../core/common";
import { warn } from "../../../../core/warn";
import { type HostKind, type HostSpec, specFor } from "./host-spec";
import type { SessionRegistry } from "./plugin";
import { RunnerModels } from "./runner-models";
import { createSdkHost } from "./sdk-host";

/** The text every session on a host is answered with when it asks for something only a person could give. */
const NOBODY_TO_ASK =
  "This is an unattended run: nobody can answer questions or approve requests. Continue without it.";

/** What a call on a host may be cancelled by. */
export interface CallOptions {
  readonly signal?: AbortSignal;
}

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
    create(input: SessionCreate, options?: CallOptions): Promise<{ readonly id: string }>;
    environment(input: { sessionID: string; variables: Record<string, string> }, options?: CallOptions): Promise<void>;
    instructions: {
      entry: { put(input: { sessionID: string; key: string; value: string }, options?: CallOptions): Promise<void> };
    };
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

/** A started host, with the settings of the sessions it is running and the models its runs have brought. */
export interface HostHandle {
  readonly host: EmbeddedHost;
  readonly sessions: SessionRegistry;
  readonly models: RunnerModels;
}

/** A host being started or started, and the means to stop it starting. */
interface Entry {
  readonly handle: Promise<HostHandle>;
  /** Aborted by {@link closeOpencodeSdk} so a start still in flight stops instead of being waited for. */
  readonly startup: AbortController;
}

/** How long closing may wait for a host to stop starting, and for a host to close, before moving on. */
const CLOSE_GRACE_MS = 5_000;

const hosts = new Map<HostKind, Entry>();
let createHost: (spec: HostSpec, signal?: AbortSignal) => Promise<EmbeddedHost> = createSdkHost;

/** Test seam: replace the host factory; undefined restores it. Hosts already open are closed. */
export function _setOpencodeHostFactoryForTests(
  factory: ((spec: HostSpec, signal?: AbortSignal) => Promise<EmbeddedHost>) | undefined,
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

async function start(kind: HostKind, startup: AbortSignal): Promise<HostHandle> {
  const sessions: SessionRegistry = new Map();
  const models = new RunnerModels();
  let started: EmbeddedHost | undefined;
  const host = await createHost(
    specFor(kind, sessions, models, async (sessionID, variables) => {
      await started?.sessions.environment({ sessionID, variables });
    }),
    startup,
  );
  // Closed while it was still starting, by a start that did not stop when it was asked to: nobody is left to use it.
  if (startup.aborted) {
    await host.close().catch(() => {});
    throw new Error(`the embedded OpenCode (${kind}) was closed while it started`);
  }
  started = host;
  const stop = new AbortController();
  void answerRequests(host, stop.signal);
  const close = host.close.bind(host);
  return {
    sessions,
    models,
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
  let entry = hosts.get(kind);
  if (!entry) {
    const startup = new AbortController();
    const started: Entry = { handle: start(kind, startup.signal), startup };
    started.handle.catch(() => {
      if (hosts.get(kind) === started) hosts.delete(kind);
    });
    hosts.set(kind, started);
    entry = started;
  }
  return entry.handle;
}

/** Closes in progress, started by whoever: `closeOpencodeSdk` waits for all of them, not only its own. */
let closing: Promise<void> = Promise.resolve();

const GAVE_UP = Symbol("gave up");

/** `work`, or {@link GAVE_UP} once `ms` have passed. */
function within<T>(work: Promise<T>, ms: number): Promise<T | typeof GAVE_UP> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof GAVE_UP>((resolve) => {
    timer = setTimeout(() => resolve(GAVE_UP), ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Stop one host: ask a start still in flight to stop, wait for it for at most {@link CLOSE_GRACE_MS}
 * (a start that never settles is left to close the host itself if it ever does, see {@link start}), then
 * close the host for at most as long. What did not finish in time is named, never waited for.
 */
async function closeEntry(kind: string, { handle, startup }: Entry): Promise<void> {
  startup.abort();
  const started = await within(
    handle.catch(() => undefined),
    CLOSE_GRACE_MS,
  );
  if (started === GAVE_UP) {
    warn(`The embedded OpenCode (${kind}) did not stop starting within ${CLOSE_GRACE_MS / 1000}s; it is left behind.`);
    return;
  }
  if (started === undefined) return;
  const closed = await within(
    started.host.close().then(
      () => undefined,
      (error: unknown) => warn(`The embedded OpenCode (${kind}) failed to close: ${toErrorMessage(error)}`),
    ),
    CLOSE_GRACE_MS,
  );
  if (closed === GAVE_UP) {
    warn(`The embedded OpenCode (${kind}) did not close within ${CLOSE_GRACE_MS / 1000}s; it is left behind.`);
  }
}

/** Close every embedded OpenCode this process started, each within a bounded time. */
export function closeOpencodeSdk(): Promise<void> {
  const open = [...hosts.entries()];
  hosts.clear();
  const closed = Promise.all(open.map(([kind, entry]) => closeEntry(kind, entry))).then(() => {});
  closing = Promise.all([closing, closed]).then(() => {});
  return closing;
}
