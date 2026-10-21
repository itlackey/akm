// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Proposal writes `akm ui` makes: accept and reject a proposal, and accept
 * several at once. Each handler calls the function `akm proposal accept` /
 * `reject` calls, with the arguments the CLI passes, so a UI decision is
 * recorded exactly like a CLI one (same state.db rows, events and commit).
 *
 * The server decides whether a request may reach this module (token header,
 * Origin, content type, body size); see `server.ts`. Everything else in the UI
 * is either a read in `api.ts` or an explicit action in `workspace-actions.ts`.
 */

import { AkmError, TransientError, UsageError } from "../../core/errors";
import { acquireAssetMutationLease } from "../../indexer/index-writer-lock";
import {
  akmProposalAccept,
  akmProposalAcceptMany,
  akmProposalReject,
  type ProposalAcceptFailure,
  type ProposalAcceptResult,
} from "../proposal/proposal";
import { proposalSummary } from "./api";
import { type GitCommitSummary, readBundleGitStatus } from "./git-read";

export const MAX_REJECT_REASON = 2000;
export const MAX_BATCH_IDS = 200;

export type WriteRoute = { kind: "accept"; id: string } | { kind: "reject"; id: string } | { kind: "accept-many" };

/** The three POST paths the UI may write through; `null` for anything else. */
export function matchWriteRoute(pathname: string): WriteRoute | null {
  if (pathname === "/api/proposals/accept") return { kind: "accept-many" };
  const match = /^\/api\/proposals\/([^/]+)\/(accept|reject)$/.exec(pathname);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1] as string);
  } catch {
    return null;
  }
  return { kind: match[2] as "accept" | "reject", id };
}

// ── Errors ───────────────────────────────────────────────────────────────────

const STALE_MESSAGE =
  /target (?:changed after|was created after) proposal|^Retire proposal \S+ (?:target \(.*\) no longer exists|is stale )/;
const NOT_PENDING_MESSAGE = /is not pending \(current status/;
const LEASE_MESSAGE = /timed out waiting for asset mutation lease/;
const NOT_FOUND_MESSAGE = /^Proposal ".*" not found|^No proposal found for ref/;

export interface ProposalActionError {
  status: number;
  code: string;
  message: string;
}

/** A stable code for an error the accept path reports only as text (a failed id inside a batch). */
function codeForMessage(message: string): string | null {
  if (STALE_MESSAGE.test(message)) return "PROPOSAL_STALE";
  if (NOT_PENDING_MESSAGE.test(message)) return "PROPOSAL_NOT_PENDING";
  if (LEASE_MESSAGE.test(message)) return "ASSET_MUTATION_LEASE_HELD";
  if (NOT_FOUND_MESSAGE.test(message)) return "PROPOSAL_NOT_FOUND";
  return null;
}

/** HTTP status and code for an error thrown by an accept or reject: 409 stale, not pending or lease held; 404; 400. */
export function classifyProposalError(error: unknown): ProposalActionError {
  const message = error instanceof Error ? error.message : String(error);
  const byMessage = codeForMessage(message);
  if (error instanceof AkmError) {
    if (error.code === "ASSET_CONTENT_CHANGED") return { status: 409, code: error.code, message };
    if (byMessage === "PROPOSAL_STALE" || byMessage === "PROPOSAL_NOT_PENDING") {
      return { status: 409, code: byMessage, message };
    }
    switch (error.kind) {
      case "transient":
        return { status: 409, code: error.code, message };
      case "not-found":
        return { status: 404, code: error.code, message };
      case "usage":
        return { status: 400, code: error.code, message };
      default:
        return { status: 500, code: error.code, message };
    }
  }
  if (byMessage === "ASSET_MUTATION_LEASE_HELD") return { status: 409, code: byMessage, message };
  return { status: 500, code: "INTERNAL_ERROR", message };
}

// ── Input ────────────────────────────────────────────────────────────────────

function bodyObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new UsageError("The request body must be a JSON object.", "INVALID_JSON_ARGUMENT");
  }
  return body as Record<string, unknown>;
}

function rejectReason(body: unknown): string {
  const reason = bodyObject(body).reason;
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new UsageError('A rejection needs a reason: {"reason": "..."}.', "MISSING_REQUIRED_ARGUMENT");
  }
  const trimmed = reason.trim();
  if (trimmed.length > MAX_REJECT_REASON) {
    throw new UsageError(`The reason is too long (${trimmed.length} characters; at most ${MAX_REJECT_REASON}).`);
  }
  return trimmed;
}

function batchIds(body: unknown): string[] {
  const ids = bodyObject(body).ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH_IDS) {
    throw new UsageError(`"ids" must be a list of 1 to ${MAX_BATCH_IDS} proposal ids.`, "MISSING_REQUIRED_ARGUMENT");
  }
  for (const id of ids) {
    if (typeof id !== "string" || id.trim() === "" || id.length > 200) {
      throw new UsageError('Every entry of "ids" must be a non-empty proposal id string.');
    }
  }
  return [...new Set((ids as string[]).map((id) => id.trim()))];
}

// ── Execution ────────────────────────────────────────────────────────────────

/**
 * Fail fast when another writer holds the asset-mutation lease. The accept and
 * reject functions would wait up to ten minutes for it, which in a browser is a
 * hung button; the probe turns a held lease into an immediate, retryable 409.
 */
export async function assertWriteLeaseFree(purpose: string): Promise<void> {
  const lease = await acquireAssetMutationLease({ mode: "try", purpose });
  if (!lease) {
    throw new TransientError(
      "Another akm process or request is writing to the bundle right now. Try again in a moment.",
      "ASSET_MUTATION_LEASE_HELD",
    );
  }
  lease.release();
}

type CommitSummary = GitCommitSummary & { repo: string };

/**
 * The commit an accept just made, if any. The accept functions do not return it,
 * so read the head commit of each accepted proposal's repository and keep one
 * that carries akm's accept subject and is newer than the request. `null` for a
 * bundle that is not a git repository (nothing was committed).
 */
async function acceptCommit(accepted: ProposalAcceptResult[], startedMs: number): Promise<CommitSummary | null> {
  const roots = new Set<string>();
  for (const result of accepted) {
    const root = result.proposal.acceptedTarget?.root;
    if (root) roots.add(root);
  }
  for (const root of roots) {
    const last = (await readBundleGitStatus(root))?.lastCommit;
    if (!last || !/^akm (?:proposal )?accept:/.test(last.subject)) continue;
    if (Date.parse(last.time) < startedMs - 2000) continue;
    return { ...last, repo: root };
  }
  return null;
}

function acceptedView(result: ProposalAcceptResult) {
  return { ...result, proposal: proposalSummary(result.proposal) };
}

function failedView(failure: ProposalAcceptFailure) {
  return { ...failure, code: codeForMessage(failure.error) ?? "ACCEPT_FAILED" };
}

/** Run one of the three write routes; errors propagate for the server to classify with {@link classifyProposalError}. */
export async function handleWriteRequest(route: WriteRoute, body: unknown): Promise<unknown> {
  const startedMs = Date.now();
  switch (route.kind) {
    case "accept": {
      await assertWriteLeaseFree("ui-proposal-accept");
      const result = await akmProposalAccept({ id: route.id });
      return { ...acceptedView(result), commit: await acceptCommit([result], startedMs) };
    }
    case "reject": {
      const reason = rejectReason(body);
      await assertWriteLeaseFree("ui-proposal-reject");
      const result = await akmProposalReject({ id: route.id, reason });
      return { ...result, proposal: proposalSummary(result.proposal) };
    }
    case "accept-many": {
      const ids = batchIds(body);
      await assertWriteLeaseFree("ui-proposal-accept");
      const results = await akmProposalAcceptMany({ ids });
      const accepted = results.filter((r): r is ProposalAcceptResult => r.ok);
      return {
        accepted: accepted.length,
        failed: results.length - accepted.length,
        results: results.map((r) => (r.ok ? acceptedView(r) : failedView(r))),
        commit: accepted.length > 0 ? await acceptCommit(accepted, startedMs) : null,
      };
    }
  }
}
