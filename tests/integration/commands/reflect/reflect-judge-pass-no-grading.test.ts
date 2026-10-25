// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A judge-passed reflect revision becomes a proposal with no further check:
 * the retrieval regression gate (#1171) is gone, so the asset's recorded
 * retrieval queries are never graded. Integration: real state.db.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmReflect } from "../../../../src/commands/improve/reflect";
import { listProposals } from "../../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../../src/core/config/config";
import { openStateDatabase } from "../../../../src/core/state-db";
import type { SpawnedSubprocess, SpawnFn } from "../../../../src/core/subprocess";
import type { ChatMessage } from "../../../../src/llm/client";
import { quietQualityGateConfig, reflectReply } from "../../../_helpers/factories";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

function fakeSpawn(stdout: string): SpawnFn {
  const stream = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    });
  return () =>
    ({
      exitCode: 0,
      exited: Promise.resolve(0),
      stdout: stream(),
      stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      stdin: null,
      kill: () => undefined,
    }) as SpawnedSubprocess;
}

const BODY = [
  "# Rotating the VPN key",
  "",
  "1. Generate a new key with `wg genkey` on the gateway.",
  "2. Push the public key to every peer's `[Peer]` block.",
  "3. Restart `wg-quick@wg0` on the gateway, then on each peer.",
  "4. Confirm the handshake with `wg show` within two minutes.",
].join("\n");
const OLD = `---\ndescription: OLD_MARKER How to rotate the VPN key\n---\n\n${BODY}\n`;
const PATCH = { description: "NEW_MARKER How to rotate the WireGuard VPN key" };

function config(): AkmConfig {
  return {
    ...quietQualityGateConfig(),
    connections: { judge: { endpoint: "http://localhost:11434/v1/chat/completions", models: { fast: "judge-model" } } },
    harnesses: { "fake-agent": { platform: "claude", bin: "fake-agent" } },
    improve: {
      strategy: "default",
      strategies: { default: { processes: { reflect: { qualityGate: { enabled: true } } } } },
    },
  } as AkmConfig;
}

function recordQuery(entryRef: string, query: string, source = "user"): void {
  const db = openStateDatabase();
  try {
    db.prepare("INSERT INTO usage_events (event_type, entry_ref, query, source) VALUES ('search', ?, ?, ?)").run(
      entryRef,
      query,
      source,
    );
  } finally {
    db.close();
  }
}

describe("reflect after a judge pass", () => {
  test("a revision is minted with no grading call even when the asset has retrieval queries", async () => {
    recordQuery("stash//knowledge/vpn-rotation", "how do I rotate the vpn key");
    recordQuery("stash//knowledge/vpn-rotation", "wireguard key rotation");
    const prompts: string[] = [];

    const result = await akmReflect({
      ref: "knowledge/vpn-rotation",
      stashDir: storage.stashDir,
      config: config(),
      // Reflect runs on the harness; the judge, with no harness named, on the default connection.
      engine: "fake-agent",
      assetContent: OLD,
      runAgentOptions: { spawn: fakeSpawn(reflectReply(PATCH)) },
      chat: async (_connection: unknown, messages: ChatMessage[]) => {
        prompts.push(messages.at(-1)?.content ?? "");
        return JSON.stringify({ scores: { need: 5, preservation: 5, quality: 5 }, reason: "fine" });
      },
    });

    if (!result.ok) throw new Error(`expected a proposal, got: ${result.error}`);
    // The quality judge is the only model call: nothing was graded against a query.
    expect(prompts).toHaveLength(1);
    expect(prompts.some((p) => p.startsWith("Query:"))).toBe(false);
    expect(listProposals(storage.stashDir)).toHaveLength(1);
  });
});
