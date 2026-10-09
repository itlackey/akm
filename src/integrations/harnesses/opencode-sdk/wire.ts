// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The seam between the OpenCode SDK runner and one OpenCode major's wire
 * protocol (#1049).
 *
 * `sdk-runner.ts` owns everything the two majors share: the managed
 * `opencode serve` child (spawn, port, registry, cleanup), the child
 * environment, deadlines, abort handling and result shaping. A
 * {@link OpencodeWireAdapter} owns what differs: how to ask the binary to
 * serve, how to read its readiness line, how to authenticate, and how to
 * create a session, prompt it, abort it, watch its events and answer its
 * permission requests. `v1-adapter.ts` speaks OpenCode 1 through
 * `@opencode-ai/sdk`; `v2-adapter.ts` speaks OpenCode 2 through
 * `@opencode/client`.
 *
 * Selection is explicit (`AgentProfile.opencodeVersion`, default
 * `DEFAULT_OPENCODE_VERSION`). akm never probes `opencode --version`, and an
 * adapter that meets a server of the other major fails and names the remedy
 * ({@link otherMajorRemedy}); it never falls back to the other protocol.
 */

import type { AgentFailureReason, AgentTokenUsage } from "../../agent/spawn";

export type OpencodeMajor = 1 | 2;

/** The npm client package each major's adapter imports. Setup and health check the one the engine selects. */
export const OPENCODE_CLIENT_PACKAGE: Readonly<Record<OpencodeMajor, string>> = {
  1: "@opencode-ai/sdk",
  2: "@opencode/client",
};

/** How the dispatch wants its session set up. Each adapter uses what its wire protocol takes where it takes it. */
export interface WireSessionSpec {
  /** Working directory the session runs in. */
  readonly directory?: string;
  /** Exact native agent selector. */
  readonly agent?: string;
  /** Extra system text. */
  readonly system?: string;
  /** Per-tool enable (`true`) / disable (`false`) map. */
  readonly tools?: Record<string, boolean>;
}

/** A failure decoded from a reply, ready for `AgentRunResult`. */
export interface WireFailure {
  readonly reason: AgentFailureReason;
  readonly message: string;
}

/** What a finished prompt produced. */
export interface WirePromptResult {
  /** The answer text ("" when the reply had none). */
  readonly text: string;
  readonly usage?: AgentTokenUsage;
  /** Set when the server reported an error instead of (or alongside) an answer. */
  readonly failure?: WireFailure;
}

/** An event the runner acts on, decoded from a major's event stream. */
export type WireEvent =
  | { readonly kind: "session"; readonly id: string; readonly parentId?: string }
  | {
      readonly kind: "retry";
      readonly sessionId: string;
      readonly attempt?: number;
      readonly message: string;
      /** Epoch ms of the next attempt. */
      readonly next?: number;
      readonly provider?: string;
      /** True when OpenCode retries because the account hit a usage limit. */
      readonly accountLimit: boolean;
    }
  | {
      readonly kind: "permission";
      readonly requestId: string;
      readonly sessionId: string;
      /** Human-readable "<permission> (<patterns>)". */
      readonly description: string;
    };

/** What {@link OpencodeWireAdapter.authorize} decides for one spawned server. */
export interface WireAuthorization {
  /** Added to the child's environment at spawn. Never part of the registry key. */
  readonly env: Record<string, string>;
  /** Handed back to {@link OpencodeWireAdapter.connect}. */
  readonly credentials?: string;
}

/** The readiness verdict for one line of the child's output. */
export type WireReadiness = { readonly url: string } | { readonly error: string } | undefined;

export interface OpencodeWireAdapter {
  readonly major: OpencodeMajor;
  /** Full argv (including the binary) that starts a private server on `port`. */
  serveArgv(bin: string, port: number): string[];
  /** Choose the credentials for one server. Called once per spawn. */
  authorize(): WireAuthorization;
  /** Judge one output line of the child: the readiness line, a wrong-major line, or neither. */
  readiness(line: string): WireReadiness;
  /** Build a client for a ready server (and check it is this adapter's major). */
  connect(baseUrl: string, credentials: string | undefined): Promise<unknown>;
  /** Create the session; resolves to its id, or undefined when the server returned none. */
  createSession(client: unknown, spec: WireSessionSpec): Promise<string | undefined>;
  /** Send the prompt and resolve once the reply is complete. `signal` cancels in-flight requests. */
  prompt(
    client: unknown,
    sessionId: string,
    text: string,
    spec: WireSessionSpec,
    signal: AbortSignal,
  ): Promise<WirePromptResult>;
  /** Stop a session server-side so it stops calling the model. Never rejects. */
  abort(client: unknown, sessionId: string, spec: WireSessionSpec): void;
  /** False when the client has no event surface (a fake, say): there is then nothing to watch. */
  canWatch?(client: unknown): boolean;
  /** Open the event stream; the stream ends quietly when `signal` aborts. Rejects when it cannot be opened. */
  subscribe(client: unknown, spec: WireSessionSpec, signal: AbortSignal): Promise<AsyncIterable<unknown>>;
  /** Decode one raw event; undefined for any event the runner does not act on. */
  decodeEvent(raw: unknown): WireEvent | undefined;
  /** Answer a permission request with "reject". */
  rejectPermission(
    client: unknown,
    event: Extract<WireEvent, { kind: "permission" }>,
    spec: WireSessionSpec,
  ): Promise<void>;
}

/** The sentence every wrong-major failure ends with. */
export function otherMajorRemedy(selected: OpencodeMajor): string {
  return selected === 2
    ? `This engine targets OpenCode 2. For an OpenCode 1 binary set "opencodeVersion": 1 on the engine, or upgrade OpenCode to 2.`
    : `This engine targets OpenCode 1 ("opencodeVersion": 1). For an OpenCode 2 binary remove "opencodeVersion" (or set it to 2), or install OpenCode 1.`;
}
