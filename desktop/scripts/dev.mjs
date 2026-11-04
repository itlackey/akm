import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const token = randomBytes(32).toString("hex");
const origin = "http://127.0.0.1:5173";
const env = {
  ...process.env,
  AKM_DESKTOP_SESSION_TOKEN: token,
  AKM_DESKTOP_ORIGIN: origin,
  AKM_LAUNCHER_NODE: process.execPath,
};
delete env.AKM_DESKTOP_SESSION;
delete env.AKM_LAUNCHER_PATH;
delete env.AKM_LAUNCHER_PID;
const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url))], {
  stdio: "inherit",
  env,
});
console.log(`Open this launch-only URL: ${origin}/?desktop_session=${token}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
