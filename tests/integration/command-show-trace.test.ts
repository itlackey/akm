// Integration: a dispatched command and its persona leave a show trace under
// their indexed type and entry name, built from the refs the dispatch holds.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  type CommandExecutionSourceLoader,
  dispatchPreparedCommandInvocation,
  prepareCommandInvocation,
} from "../../src/commands/command/command-execution";
import type { AkmConfig } from "../../src/core/config/config-types";
import { readEvents } from "../../src/core/events";
import { createAdapterRenderedExecutionSource } from "../../src/execution/source";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => storage.cleanup());

const config: AkmConfig = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  harnesses: { reviewer: { platform: "claude", bin: "/bin/true" } },
};

function rendered(kind: "command" | "persona", ref: string, defaults: Record<string, unknown> = {}) {
  const [bundle = "fixture", concept = ""] = ref.split("//");
  return createAdapterRenderedExecutionSource({
    kind,
    content: "Review this.",
    defaults,
    identity: { ref, bundle, adapter: "akm", file: `${concept}.md`, hash: "a".repeat(64) },
  });
}

test("the show trace names the indexed type and entry name of the command and its persona", async () => {
  const command = rendered("command", "fixture//commands/team/review", { agent: "agents/team/reviewer" });
  const persona = rendered("persona", "fixture//agents/team/reviewer");
  const sourceLoader: CommandExecutionSourceLoader = async (_ref, kind) =>
    (kind === "command" ? command : persona) as never;
  const prepared = await prepareCommandInvocation({
    action: { ref: "fixture//commands/team/review" },
    config,
    sourceLoader,
  });
  await dispatchPreparedCommandInvocation(prepared, {
    runAgent: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
  });

  const traces = readEvents({ type: "show" }).events.map((event) => ({
    ref: event.ref,
    type: event.metadata?.type,
    name: event.metadata?.name,
  }));
  expect(traces).toContainEqual({ ref: "fixture//commands/team/review", type: "command", name: "team/review" });
  expect(traces).toContainEqual({ ref: "fixture//agents/team/reviewer", type: "agent", name: "team/reviewer" });
});
