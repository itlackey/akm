import fs from "node:fs";

const [phase, marker, proposalId, operation = "accept", target] = process.argv.slice(2);
if (!phase || !marker || !proposalId) process.exit(2);

const originalRename = fs.renameSync;
let held = false;
fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
  const result = originalRename(oldPath, newPath);
  if (!held && String(oldPath).endsWith("journal.json.tmp") && String(newPath).endsWith("journal.json")) {
    const journal = JSON.parse(fs.readFileSync(String(newPath), "utf8")) as { phase?: string };
    if (journal.phase === phase) {
      held = true;
      fs.writeFileSync(marker, String(process.pid), "utf8");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    }
  }
  return result;
}) as typeof fs.renameSync;

if (phase === "event-persisted" || phase.startsWith("reject-") || phase === "legacy-target-derived") {
  const repository = (await import("../../../src/commands/proposal/repository")) as Record<string, unknown>;
  const setHook = repository._setProposalMutationHookForTests as ((hook?: (point: string) => void) => void) | undefined;
  if (!setHook) {
    fs.writeFileSync(marker, "unsupported", "utf8");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    process.exit(4);
  }
  setHook((point) => {
    if (point !== phase) return;
    fs.writeFileSync(marker, String(process.pid), "utf8");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  });
}

const { akmProposalAccept, akmProposalReject, akmProposalRevert } = await import(
  "../../../src/commands/proposal/proposal"
);
try {
  if (operation === "revert") await akmProposalRevert({ id: proposalId, target });
  else if (operation === "reject") await akmProposalReject({ id: proposalId, reason: "durable reject" });
  else await akmProposalAccept({ id: proposalId, target });
} catch (error) {
  fs.writeFileSync(marker, `error:${error instanceof Error ? error.stack : String(error)}`, "utf8");
  process.exit(5);
}
