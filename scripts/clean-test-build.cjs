const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const testBuildDir = process.env.AGENTIKIT_TEST_BUILD_DIR || path.join(os.tmpdir(), "agentikit-test")

fs.rmSync(testBuildDir, { recursive: true, force: true })
