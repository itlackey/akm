/**
 * `akm judge`: one of akm's judges on one input read from stdin, on the runner the call selects.
 * Spawns the real CLI against a stub chat-completions server.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { saveConfig } from "../../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../../_helpers/sandbox";

const repoRoot = path.resolve(import.meta.dir, "../../..");

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

async function akm(args: string[], stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "src/cli.ts", ...args, "--format", "json"], {
    cwd: repoRoot,
    env: { ...process.env },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function serve(reply: string): { server: ReturnType<typeof Bun.serve>; prompts: string[] } {
  const prompts: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      prompts.push(body.messages.at(-1)?.content ?? "");
      return Response.json({ choices: [{ message: { role: "assistant", content: reply } }] });
    },
  });
  return { server, prompts };
}

function configure(port: number): void {
  saveConfig({
    semanticSearchMode: "off",
    connections: {
      gate: { endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, models: { fast: "gate-model" } },
    },
  });
}

const INPUT = {
  source: "description: Deploys the",
  candidate: "description: Deploys the app",
  feedback: ["truncated"],
};

describe("akm judge", () => {
  test("--list names every judge and --schema prints one's schemas and version", async () => {
    const list = JSON.parse((await akm(["judge", "--list"])).stdout);
    expect(list.judges.map((judge: { name: string }) => judge.name)).toEqual(
      expect.arrayContaining(["reflect.quality", "distill.lesson", "consolidate.pair", "proposal.judgment"]),
    );
    const schema = JSON.parse((await akm(["judge", "distill.lesson", "--schema"])).stdout);
    expect(schema).toMatchObject({ judge: "distill.lesson", schemaVersion: 1 });
    expect(schema.inputSchema.required).toEqual(["lesson", "source"]);
    expect(schema.outputSchema.type).toBe("object");
  });

  test("a verdict comes back in one envelope that names the runner", async () => {
    const { server, prompts } = serve(
      JSON.stringify({ scores: { need: 5, preservation: 5, quality: 4 }, reason: "Fixes the truncated description." }),
    );
    try {
      configure(server.port as number);
      const result = await akm(["judge", "reflect.quality", "--connection", "gate"], JSON.stringify(INPUT));

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        judge: "reflect.quality",
        schemaVersion: 2,
        runner: { kind: "connection", name: "gate", model: "gate-model" },
        outcome: "verdict",
        verdict: { pass: true, criteria: { need: 5, preservation: 5, quality: 4 } },
      });
      expect(prompts[0]).toContain("description: Deploys the app");
    } finally {
      server.stop(true);
    }
  });

  test("an unreadable reply is outcome unparseable and exits 1, never a verdict", async () => {
    const { server } = serve("this is not json");
    try {
      configure(server.port as number);
      const result = await akm(["judge", "reflect.quality", "--connection", "gate"], JSON.stringify(INPUT));

      expect(result.code).toBe(1);
      const envelope = JSON.parse(result.stdout);
      expect(envelope).toMatchObject({ ok: false, judge: "reflect.quality", outcome: "unparseable" });
      expect(envelope).not.toHaveProperty("verdict");
    } finally {
      server.stop(true);
    }
  });

  test("an unknown field or an unknown judge is refused", async () => {
    configure(1);
    const extra = await akm(
      ["judge", "reflect.quality", "--connection", "gate"],
      JSON.stringify({ ...INPUT, kind: "x" }),
    );
    expect(extra.code).toBe(2);
    expect(extra.stdout + extra.stderr).toContain("kind");
    const unknown = await akm(["judge", "nope.nothing"], "{}");
    expect(unknown.code).toBe(2);
    expect(unknown.stdout + unknown.stderr).toContain("Unknown judge");
  });
});
