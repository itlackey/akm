const fs = require("node:fs")

fs.rmSync("/tmp/agentikit-test", { recursive: true, force: true })
