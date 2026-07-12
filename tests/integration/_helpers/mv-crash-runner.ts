import fs from "node:fs";
import path from "node:path";

const [phase, marker, fromRef, toName] = process.argv.slice(2);
if (!phase || !marker || !fromRef || !toName) process.exit(2);

const originalWrite = fs.writeFileSync;
const originalRename = fs.renameSync;
let held = false;
let pendingJournalHold = false;
const hold = (): never => {
  held = true;
  originalWrite(marker, String(process.pid), "utf8");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  process.exit(3);
};

fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, ...args: unknown[]) => {
  const result = originalWrite(file, data, ...(args as [fs.WriteFileOptions?]));
  if (!held && String(file).endsWith("journal.json.tmp")) {
    const text = String(data);
    if (
      (phase === "filesystem-committed" &&
        (text.includes('"phase": "filesystem-committed"') || text.includes('"phase": "committed"'))) ||
      (phase === "state-finalized" && text.includes('"phase": "committed"')) ||
      text.includes(`"phase": "${phase}"`)
    ) {
      pendingJournalHold = true;
    }
  }
  return result;
}) as typeof fs.writeFileSync;

fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
  const result = originalRename(oldPath, newPath);
  if (
    !held &&
    pendingJournalHold &&
    String(oldPath).endsWith("journal.json.tmp") &&
    String(newPath).endsWith("journal.json")
  ) {
    hold();
  }
  if (!held && phase === "applying-partial" && path.basename(String(newPath)) === "owned-0") hold();
  return result;
}) as typeof fs.renameSync;

const { runCliCapture } = await import("../../_helpers/cli");
if (phase === "index-rekeyed" || phase === "state-asset_salience-rekeyed" || phase === "mv-event-persisted") {
  const mvModule = (await import("../../../src/commands/mv-cli")) as Record<string, unknown>;
  const setHook = mvModule._setMvMutationHookForTests as ((hook?: (point: string) => void) => void) | undefined;
  if (!setHook) {
    originalWrite(marker, "unsupported", "utf8");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    process.exit(4);
  }
  setHook((point) => {
    if (point === phase) hold();
  });
}
const result = await runCliCapture(["mv", fromRef, toName]);
process.stderr.write(result.stderr);
process.stdout.write(result.stdout);
process.exit(result.code);
