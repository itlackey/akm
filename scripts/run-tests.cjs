const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")

const buildDir = process.env.AGENTIKIT_TEST_BUILD_DIR || path.join(os.tmpdir(), "agentikit-test")
const env = { ...process.env, AGENTIKIT_TEST_BUILD_DIR: buildDir }

runOrExit(process.execPath, ["./scripts/clean-test-build.cjs"], env)
runOrExit(
  "tsc",
  [
    "--project",
    "./tsconfig.build.json",
    "--emitDeclarationOnly",
    "false",
    "--declaration",
    "false",
    "--outDir",
    buildDir,
  ],
  env,
)
runOrExit(process.execPath, ["--test", "./tests/stash.test.mjs"], env)

function runOrExit(command, args, commandEnv) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: commandEnv,
  })
  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status)
  }
  if (result.error) {
    throw result.error
  }
}
