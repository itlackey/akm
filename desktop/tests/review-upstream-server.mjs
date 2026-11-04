import assert from "node:assert/strict";
import path from "node:path";

assert.ok(path.basename(process.env.AKM_DESKTOP_TEST_ROOT ?? "").startsWith("akm-desktop-fixture-"));
assert.equal(process.env.AKM_BUNDLE_DIR, path.join(process.env.AKM_DESKTOP_TEST_ROOT, "personal"));
await import("akm-cli/workspace");
const { startUiServer } = await import("akm-cli/dist/commands/ui/server.js");
const server = await startUiServer();
process.send?.({ url: server.url });
process.on("message", async (message) => {
  if (message === "shutdown") {
    await server.close();
    process.exit(0);
  }
});
process.on("disconnect", async () => {
  await server.close();
  process.exit(0);
});
