// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import os from "node:os";
import { WORKFLOW_MAX_CONCURRENCY } from "./resource-limits";

/**
 * Run-level ceiling on `workflow.maxConcurrency`. It is deliberately the SAME
 * value the frozen-plan decoder enforces on `execution.maxConcurrency` and on
 * per-step `map.concurrency` — a clamp above the decoder's bound would freeze
 * plans the decoder then rejects — so it reads the single shared constant
 * (`./resource-limits`) rather than repeating the literal.
 */
export const WORKFLOW_MAX_CONCURRENCY_CEILING = WORKFLOW_MAX_CONCURRENCY;

export function cpuDerivedUnitConcurrency(cpuCount = os.cpus()?.length ?? 4): number {
  return Math.min(16, Math.max(1, cpuCount - 2));
}

export function clampMaxConcurrency(value: number): number {
  return Math.min(WORKFLOW_MAX_CONCURRENCY_CEILING, Math.max(1, Math.floor(value)));
}

/** Resolve and freeze the engine-wide cap once when a workflow run starts. */
export function workflowMaxConcurrency(configured?: number, cpuCount = os.cpus()?.length ?? 4): number {
  return configured === undefined ? cpuDerivedUnitConcurrency(cpuCount) : clampMaxConcurrency(configured);
}

// ── Fan-out defaults ─────────────────────────────────────────────────────────
//
// Four independent limits clamp a `map` step's real width, and the effective
// value is their minimum:
//
//   1. the step's own `map.concurrency`            (this file's default below)
//   2. the run's frozen `execution.maxConcurrency` ({@link workflowMaxConcurrency})
//   3. the selected LLM engine's frozen concurrency ({@link defaultLlmEngineConcurrency})
//   4. the CURRENT host's CPU safety cap           ({@link cpuDerivedUnitConcurrency})
//
// (1) and (3) both defaulted to 1 before 0.9.1, which made every fan-out serial
// unless the author opted in at BOTH layers — so (2) and (4), the limits that
// actually encode machine capacity, never bound anything. The defaults below
// replace those two 1s. They are deliberately modest rather than "as wide as
// the host allows": a `map` is independent by construction, but its units call
// out to rate-limited providers and RAM-hungry agent processes, so the value
// that a plan freezes should be one a laptop and a CI box can both survive.

/**
 * Default width of a `map` step that declares no `concurrency:` (0.9.1+).
 *
 * 4 is chosen over the host cap on purpose. It is a real, predictable speedup
 * (4× on any fan-out longer than four items) while staying below
 * {@link cpuDerivedUnitConcurrency} on every machine with ≥6 cores, so the
 * frozen number — not the host — is what an author reasons about, and a plan
 * frozen on a 32-core CI box behaves the same when it resumes on a laptop.
 *
 * Overridable in both directions:
 *   - per step: `map.concurrency: <n>` (an explicit `1` still means serial),
 *   - per install: `workflow.defaultMapConcurrency` — set it to `1` to restore
 *     the pre-0.9.1 serial default for every workflow at once.
 */
export const DEFAULT_MAP_CONCURRENCY = 4;

/**
 * Default `engines.<name>.concurrency` for an LLM engine on a LOOPBACK
 * endpoint. Stays at 1, matching `getDefaultLlmConcurrency`
 * (`src/indexer/indexer.ts`) and AGENTS.md's "lowest common denominator — a
 * slow local model on a single-threaded server" rule. A local model server
 * (LM Studio, Ollama) holds ONE loaded model; parallel inference triggers
 * reload thrash and HTTP 500s, which is a hard failure, not a slow one.
 */
export const DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY = 1;

/**
 * Default `engines.<name>.concurrency` for an LLM engine on a REMOTE endpoint.
 *
 * Deliberately equal to {@link DEFAULT_MAP_CONCURRENCY} so this limit does not
 * silently re-serialize a fan-out the author already asked for: the step's own
 * `concurrency:` stays the number that decides. Indexing's remote default is a
 * lower 2 because indexing fans out implicitly over the whole stash; a
 * workflow `map` is an explicit, bounded, author-declared fan-out, and four
 * concurrent completions sit far inside any hosted provider's entry tier.
 * Rate-limited installs set `engines.<name>.concurrency` to pin their own.
 */
export const DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY = 4;

// ── Loopback classification ──────────────────────────────────────────────────
//
// Everything above turns on ONE question: does this endpoint name a model
// server running on THIS machine? The two ways to get it wrong are not
// symmetric. Calling a local server "remote" freezes width 4 and produces the
// hard failure this policy exists to prevent (one loaded model, reload thrash,
// HTTP 500 — AGENTS.md line 48). Calling a remote server "local" only freezes
// width 1 and costs throughput. Every ambiguous case below therefore resolves
// toward LOOPBACK.
//
// The classification is deliberately PURE and syntactic — no DNS, no reading
// the host's interface list. Freeze must produce the same plan on a laptop, on
// a CI box, and on a machine with no network at all; a resolver call would make
// a frozen width depend on what a name server happened to answer at freeze
// time, and on whether one could be reached at all.

/** One decimal IPv4 octet: 0–255, no leading zeros (`01` is not an octet). */
const IPV4_OCTET = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** One IPv6 group: 1–4 lowercase hex digits. */
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;
/** The `127.0.0.0/8` first octet — the WHOLE loopback block, not one address. */
const IPV4_LOOPBACK_FIRST_OCTET = 127;
const IPV6_GROUP_COUNT = 8;

/** Parse a dotted quad into its four octets, or undefined if it is not one. */
function parseIpv4(text: string): [number, number, number, number] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) return undefined;
    octets.push(Number(part));
  }
  return octets as [number, number, number, number];
}

/**
 * Expand an IPv6 address into its eight 16-bit groups, or undefined when it is
 * not a well-formed address. Handles the `::` zero run (at most one, standing
 * for at least one group) and the trailing dotted-quad spelling
 * (`::ffff:127.0.0.1`), which contributes the low TWO groups.
 */
function parseIpv6(text: string): number[] | undefined {
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const compressed = halves.length === 2;

  /** Groups of one side of the `::`, or undefined if any component is invalid. */
  const parseSide = (side: string, endsAddress: boolean): number[] | undefined => {
    if (side === "") return [];
    const parts = side.split(":");
    const groups: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as string;
      if (part.includes(".")) {
        // A dotted quad is legal ONLY as the last component of the whole
        // address, where it stands for the low two groups.
        if (!endsAddress || i !== parts.length - 1) return undefined;
        const quad = parseIpv4(part);
        if (!quad) return undefined;
        groups.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]);
        continue;
      }
      if (!IPV6_GROUP.test(part)) return undefined;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = parseSide(halves[0] as string, !compressed);
  if (!head) return undefined;
  if (!compressed) return head.length === IPV6_GROUP_COUNT ? head : undefined;
  const tail = parseSide(halves[1] as string, true);
  if (!tail) return undefined;
  const zeros = IPV6_GROUP_COUNT - head.length - tail.length;
  // `::` must stand for at least one omitted zero group.
  if (zeros < 1) return undefined;
  return [...head, ...(new Array(zeros).fill(0) as number[]), ...tail];
}

/** True when the eight expanded groups name an address on this machine. */
function isLoopbackIpv6(groups: number[]): boolean {
  const leadingZeros = (count: number) => groups.slice(0, count).every((group) => group === 0);
  // `::` — the unspecified address. A CLIENT connecting to it reaches this
  // machine's loopback, so an endpoint spelled that way is a local server.
  if (leadingZeros(IPV6_GROUP_COUNT)) return true;
  // `::1` in every spelling (`0:0:0:0:0:0:0:1` collapses to the same groups).
  if (leadingZeros(7) && groups[7] === 1) return true;
  // IPv4-mapped (`::ffff:127.0.0.1`, which WHATWG re-serializes as
  // `::ffff:7f00:1`) and the deprecated IPv4-compatible (`::127.0.0.1`) forms:
  // the embedded IPv4 address is the low 32 bits, and its high octet decides.
  const embeddedHighOctet = (groups[6] as number) >>> 8;
  const mapped = groups[5] === 0xffff || groups[5] === 0;
  return leadingZeros(5) && mapped && embeddedHighOctet === IPV4_LOOPBACK_FIRST_OCTET;
}

/**
 * True when `host` — a URL host component, with or without IPv6 brackets —
 * names this machine WITHOUT resolving anything.
 *
 * Recognized: `localhost` and any `*.localhost` name (RFC 6761 §6.3 reserves
 * the whole TLD to loopback), all of `127.0.0.0/8` (a local model server bound
 * to `127.0.0.2` is exactly as single-model as one on `127.0.0.1`), IPv6 `::1`
 * in any spelling, the IPv4-mapped/-compatible forms of `127.0.0.0/8`
 * (`::ffff:127.0.0.1`, `::ffff:7f00:1`), and the unspecified addresses
 * `0.0.0.0` / `::` (a client connecting there reaches local loopback).
 *
 * Deliberately NOT recognized: any other NAME. `db.internal` may well resolve
 * to 127.0.0.1, but finding that out needs DNS, and freeze must stay pure (see
 * the section comment above). Near-misses are rejected structurally rather
 * than by prefix matching: `127.0.0.1.evil.com` is not a dotted quad,
 * `1270.0.0.1` has no valid first octet, `12.7.0.0.1` has five parts, and
 * `127.example.com` is a name, not an address.
 */
export function isLoopbackHost(host: string): boolean {
  // Strip IPv6 brackets (`URL.hostname` keeps them) and the DNS root label.
  const name = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  // Nothing to judge (e.g. `new URL("localhost:1234")`, which parses as the
  // scheme `localhost:` with an EMPTY host) — fail safe, same as an
  // unparseable endpoint.
  if (name === "") return true;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  const ipv4 = parseIpv4(name);
  if (ipv4) return ipv4[0] === IPV4_LOOPBACK_FIRST_OCTET || ipv4.every((octet) => octet === 0);
  const ipv6 = parseIpv6(name);
  if (ipv6) return isLoopbackIpv6(ipv6);
  return false;
}

/** True when `endpoint` points at this machine (see {@link isLoopbackHost}). */
export function isLoopbackEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return true;
  try {
    return isLoopbackHost(new URL(endpoint).hostname);
  } catch {
    // An unparseable endpoint is treated as local: guessing "remote" here would
    // widen the pool on exactly the configs we understand least.
    return true;
  }
}

/**
 * Concurrency to freeze for an LLM engine. An explicit
 * `engines.<name>.concurrency` always wins (clamped into the decoder's
 * `[1, 64]` range so a fat-fingered config cannot freeze an unloadable plan);
 * otherwise the endpoint decides.
 */
export function defaultLlmEngineConcurrency(endpoint: string | undefined, configured?: number): number {
  if (typeof configured === "number" && Number.isFinite(configured)) return clampMaxConcurrency(configured);
  return isLoopbackEndpoint(endpoint) ? DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY : DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY;
}

/**
 * Width to freeze for a `map` step that declared no `concurrency:`. `configured`
 * is `workflow.defaultMapConcurrency`; unset means {@link DEFAULT_MAP_CONCURRENCY}.
 * An explicit `map.concurrency` never reaches this function — the caller keeps
 * "author wrote 1" distinguishable from "author wrote nothing".
 */
export function defaultMapConcurrency(configured?: number): number {
  return configured === undefined || !Number.isFinite(configured)
    ? DEFAULT_MAP_CONCURRENCY
    : clampMaxConcurrency(configured);
}
