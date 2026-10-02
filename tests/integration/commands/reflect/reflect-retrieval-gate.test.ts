// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #722 — reflect refuses a rewrite that grades lower on the queries that
 * retrieved the asset. Integration: reads the queries from a real state.db
 * and records the refusal in the improve ledger.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { akmReflect } from "../../../../src/commands/improve/reflect";
import { listProposals } from "../../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../../src/core/config/config";
import { openStateDatabase } from "../../../../src/core/state-db";
import type { SpawnedSubprocess, SpawnFn } from "../../../../src/core/subprocess";
import type { ChatMessage } from "../../../../src/llm/client";
import { listImproveLedgerRows } from "../../../../src/storage/repositories/improve-ledger-repository";
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
const OLD = `---\ndescription: How to rotate the VPN key\n---\n\nOLD_MARKER\n\n${BODY}\n`;
const NEW = `NEW_MARKER\n\n${BODY.replace("# Rotating the VPN key", "# Rotating the WireGuard VPN key")}`;

function config(): AkmConfig {
  return {
    ...quietQualityGateConfig(),
    engines: {
      "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
      judge: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "judge-model" },
    },
    defaults: { engine: "fake-agent", llmEngine: "judge", improveStrategy: "default" },
    improve: { strategies: { default: { processes: { reflect: { qualityGate: { enabled: true } } } } } },
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

/** The quality judge passes; relevance grades depend on which version is shown. */
function judge(grades: { old: number; new: number }, relevancePrompts: string[]) {
  return async (_connection: unknown, messages: ChatMessage[]) => {
    const user = messages.at(-1)?.content ?? "";
    if (!user.startsWith("Query:")) {
      return JSON.stringify({ scores: { need: 5, preservation: 5, quality: 5 }, reason: "fine" });
    }
    relevancePrompts.push(user);
    return JSON.stringify({ grade: user.includes("OLD_MARKER") ? grades.old : grades.new, reason: "graded" });
  };
}

async function reflect(grades: { old: number; new: number }, relevancePrompts: string[]) {
  return akmReflect({
    ref: "knowledge/vpn-rotation",
    stashDir: storage.stashDir,
    config: config(),
    assetContent: OLD,
    runAgentOptions: { spawn: fakeSpawn(reflectReply(NEW)) },
    chat: judge(grades, relevancePrompts),
  });
}

describe("reflect retrieval regression gate", () => {
  test("a rewrite that grades lower on the asset's own queries is refused and recorded", async () => {
    recordQuery("stash//knowledge/vpn-rotation", "how do I rotate the vpn key");
    recordQuery("stash//knowledge/vpn-rotation", "wireguard key rotation");
    const prompts: string[] = [];

    const result = await reflect({ old: 3, new: 1 }, prompts);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.reason).toBe("quality_rejected");
    expect(prompts).toHaveLength(4);
    expect(listProposals(storage.stashDir)).toHaveLength(0);
    const db = openStateDatabase();
    try {
      const rows = listImproveLedgerRows(db, storage.stashDir, ["reflect"]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ref: "knowledge/vpn-rotation", outcome: "quality_rejected" });
      expect(rows[0]?.detail).toContain("retrieval");
    } finally {
      db.close();
    }
  });

  test("a rewrite that grades the same is proposed", async () => {
    recordQuery("stash//knowledge/vpn-rotation", "how do I rotate the vpn key");
    const prompts: string[] = [];

    const result = await reflect({ old: 2, new: 2 }, prompts);

    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(listProposals(storage.stashDir)).toHaveLength(1);
  });

  test("only this asset's user queries count", async () => {
    recordQuery("stash//knowledge/other-asset", "how do I rotate the vpn key");
    recordQuery("stash//knowledge/vpn-rotation", "machine query", "task");
    const prompts: string[] = [];

    const result = await reflect({ old: 3, new: 0 }, prompts);

    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(0);
  });
});
