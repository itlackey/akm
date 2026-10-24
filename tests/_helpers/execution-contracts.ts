/**
 * Test-only support for the 0.9.2 execution-contract characterization suite.
 *
 * Nothing in `src/` imports this module. The normalized request below is a
 * comparison projection, not the production resolved-request type planned by
 * WP1. It intentionally removes entry-point envelopes, timestamps, and other
 * transport details while retaining dispatch-significant values.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ResolvedExecutionRequestV1 } from "../../src/execution/resolved-request";

export const EXECUTION_CONTRACT_FIXTURES = path.join(import.meta.dir, "../fixtures/execution-contracts");

/** Base64 retains exact bytes (including BOMs, CRLFs, and final-newline state). */
export type FixtureByteSnapshot = Readonly<Record<string, string>>;

function walkFiles(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
  return files;
}

/** Capture every regular file below `root` without decoding it as text. */
export function captureFixtureBytes(root: string): FixtureByteSnapshot {
  return Object.fromEntries(
    walkFiles(root).map((relative) => [relative, fs.readFileSync(path.join(root, relative)).toString("base64")]),
  );
}

/** Throw a path-specific diagnostic if a supposedly read-only fixture changed. */
export function assertFixtureBytesUnchanged(root: string, before: FixtureByteSnapshot): void {
  const after = captureFixtureBytes(root);
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = paths.filter((relative) => before[relative] !== after[relative]);
  if (changed.length > 0) throw new Error(`fixture bytes changed: ${changed.join(", ")}`);
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface TestSourceIdentity {
  ref: string;
  bundle: string;
  adapter: string;
  file: string;
  hash: string;
}

export interface TestResolvedRequestInput {
  command: {
    content: string;
    arguments?: string;
    source?: TestSourceIdentity | null;
  };
  agent?: string | null;
  persona?: {
    content: string;
    source?: TestSourceIdentity | null;
  } | null;
  target: {
    name: string;
    kind: "connection" | "harness";
    platform?: string | null;
  };
  model?: string | null;
  effort?: string | null;
  schema?: Readonly<Record<string, unknown>> | null;
  inference?: Readonly<Record<string, unknown>>;
  modelWork?: boolean;
  timeoutMs: number | null;
  workspace?: string | null;
  environment?: Readonly<Record<string, string>>;
}

export interface TestNormalizedResolvedRequest {
  schemaVersion: 1;
  command: {
    content: string;
    arguments: string;
    source: TestSourceIdentity | null;
  };
  agent: string | null;
  persona: {
    content: string;
    source: TestSourceIdentity | null;
  } | null;
  target: {
    name: string;
    kind: "connection" | "harness";
    platform: string | null;
  };
  model: string | null;
  effort: string | null;
  schema: Record<string, unknown> | null;
  inference: Record<string, unknown>;
  modelWork: boolean;
  timeoutMs: number | null;
  workspace: string | null;
  environment: Record<string, string>;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

/**
 * Remove entry-point-specific envelopes and fill resolved optional values with
 * one canonical spelling. Array order is retained; object keys are sorted.
 */
export function normalizeResolvedRequestForTest(input: TestResolvedRequestInput): TestNormalizedResolvedRequest {
  return {
    schemaVersion: 1,
    command: {
      content: input.command.content,
      arguments: input.command.arguments ?? "",
      source: input.command.source ? (sortJson(input.command.source) as unknown as TestSourceIdentity) : null,
    },
    agent: input.agent ?? null,
    persona: input.persona
      ? {
          content: input.persona.content,
          source: input.persona.source ? (sortJson(input.persona.source) as unknown as TestSourceIdentity) : null,
        }
      : null,
    target: {
      name: input.target.name,
      kind: input.target.kind,
      platform: input.target.platform ?? null,
    },
    model: input.model ?? null,
    effort: input.effort ?? null,
    schema: input.schema ? (sortJson(input.schema) as Record<string, unknown>) : null,
    inference: sortJson(input.inference ?? {}) as Record<string, unknown>,
    modelWork: input.modelWork ?? false,
    timeoutMs: input.timeoutMs,
    workspace: input.workspace ?? null,
    environment: sortJson(input.environment ?? {}) as Record<string, string>,
  };
}

/** Stable bytes used by cross-entry-point equivalence assertions. */
export function canonicalResolvedRequestForTest(input: TestResolvedRequestInput): string {
  return `${JSON.stringify(normalizeResolvedRequestForTest(input))}\n`;
}

/** Project the production WP1 request without branching on its target kind. */
export function projectResolvedExecutionRequestForTest(request: ResolvedExecutionRequestV1): TestResolvedRequestInput {
  const effort = request.inference?.reasoningEffort;
  return {
    command: {
      content: request.command.content,
      ...(Object.hasOwn(request.command, "argumentInput") ? { arguments: request.command.argumentInput } : {}),
      source: request.command.source ? { ...request.command.source } : null,
    },
    ...(Object.hasOwn(request, "agent") ? { agent: request.agent } : {}),
    persona: request.persona ? { content: request.persona.content, source: { ...request.persona.source } } : null,
    target: {
      name: request.target.name,
      kind: request.target.kind,
      ...(Object.hasOwn(request.target, "platform") ? { platform: request.target.platform } : {}),
    },
    model: request.model?.model ?? null,
    effort: typeof effort === "string" ? effort : null,
    schema: request.outputSchema as Readonly<Record<string, unknown>> | null | undefined,
    inference: request.inference as Readonly<Record<string, unknown>> | undefined,
    modelWork: request.modelWork,
    timeoutMs: request.runtime.timeoutMs ?? null,
    workspace: request.runtime.workspace,
    environment: request.runtime.environment ?? undefined,
  };
}
