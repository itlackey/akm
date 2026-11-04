// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Hand-written declarations for `akm-cli/workspace` (the build emits no .d.ts).
// tests/contracts/workspace-surface.test.ts keeps this file and src/workspace.ts in step.

export type AkmErrorKind = "config" | "usage" | "not-found" | "transient";

export abstract class AkmError extends Error {
  abstract readonly kind: AkmErrorKind;
  /** Stable, machine-readable code. */
  abstract readonly code: string;
  abstract hint(): string | undefined;
}

export class UsageError extends AkmError {
  readonly kind: "usage";
  readonly code: string;
  constructor(msg: string, code?: "INVALID_FLAG_VALUE" | "RESOURCE_ALREADY_EXISTS" | "ASSET_CONTENT_CHANGED", hint?: string);
  hint(): string | undefined;
}

/** HTTP status, stable code and message for a failed request. */
export interface ProposalActionError {
  status: number;
  code: string;
  message: string;
}

export type WorkspaceAction =
  | "feedback"
  | "bundle-add"
  | "bundle-remove"
  | "bundle-update"
  | "bundle-rename"
  | "bundle-settings"
  | "config-set"
  | "document-save"
  | "document-retire"
  | "knowledge-create";

export type WriteRoute =
  | { kind: "accept"; id: string }
  | { kind: "reject"; id: string }
  | { kind: "revert"; id: string }
  | { kind: "reopen"; id: string }
  | { kind: "accept-many" }
  | { kind: "reject-many" };

export interface CloneOptions {
  /** Source ref (e.g., npm:@scope/pkg//script:deploy.sh) */
  sourceRef: string;
  /** Optional new name for the cloned asset */
  newName?: string;
  /** If true, overwrite existing asset in working stash */
  force?: boolean;
  /** Unmanaged destination directory escape hatch */
  dest?: string;
  /** Configured bundle to receive the managed clone */
  target?: string;
}

export interface CloneResponse {
  source: { path: string; registryId?: string };
  destination: { path: string; ref?: string };
  overwritten: boolean;
  remoteFetched?: { origin: string; stashRoot: string; cacheDir: string };
}

/** The bundle a write lands in, as `resolve*WriteTarget` returns it and `withEnvSecretWrite` takes it back. */
export interface ResolvedWriteTarget {
  readonly source: { readonly name: string; readonly path: string };
}

export const NO_SUCH_ROUTE: symbol;
export function handleApiRequest(pathname: string, query: URLSearchParams): Promise<unknown>;
export function matchWorkspaceAction(path: string): WorkspaceAction | null;
export function handleWorkspaceAction(action: WorkspaceAction, value: unknown): Promise<unknown>;
export function matchWriteRoute(pathname: string): WriteRoute | null;
export function handleWriteRequest(route: WriteRoute, body: unknown): Promise<unknown>;
export function classifyWorkspaceError(error: unknown): ProposalActionError;
export function classifyProposalError(error: unknown): ProposalActionError;
export function scrubUrlCredentials(value: unknown): unknown;
export function akmClone(options: CloneOptions): Promise<CloneResponse>;

export function deriveCanonicalAssetName(assetType: string, typeRoot: string, filePath: string): string | undefined;
export function sensitiveMarkerPath(filePath: string, type: "env" | "secret"): string;
export function resolveEnvPath(ref: string): { name: string; absPath: string; source: { path: string } };
export function resolveSecretPath(ref: string): { name: string; absPath: string; source: { path: string } };
export function resolveEnvWriteTarget(
  ref: string,
  writeTarget: string | undefined,
  create?: { subPath?: string },
): { name: string; absPath: string; target: ResolvedWriteTarget; ref: string };
export function resolveSecretWriteTarget(
  ref: string,
  writeTarget: string | undefined,
  create?: { subPath?: string },
): { name: string; absPath: string; target: ResolvedWriteTarget; ref: string };
export function withEnvSecretWrite<T>(
  target: ResolvedWriteTarget,
  ref: { type: "env" | "secret"; name: string },
  op: "Update" | "Remove",
  paths: string[],
  mutate: () => T,
): T;
export function writeEnv(envPath: string, content: string): void;
export function removeEnv(envPath: string): boolean;
export function setSecret(secretPath: string, value: Buffer): void;
export function removeSecret(secretPath: string): boolean;
