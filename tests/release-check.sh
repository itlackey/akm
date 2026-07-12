#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SKIP_DOCKER=false

for arg in "$@"; do
	case "$arg" in
	--skip-docker)
		SKIP_DOCKER=true
		;;
	--help | -h)
		echo "Usage: $0 [--skip-docker]"
		exit 0
		;;
	*)
		echo "Unknown argument: $arg" >&2
		exit 1
		;;
	esac
done

run_step() {
	local label="$1"
	shift
	echo "=== $label ==="
	"$@"
	echo ""
}

run_step "Lint" bunx biome check --write src/ tests/
run_step "Type Check" bunx tsc --noEmit
run_step "Build Package" bun run build
run_step \
	"Verify npm bin target" \
	node -e 'const fs = require("node:fs"); const pkg = require("./package.json"); const bins = [["akm", "dist/akm", "cli.js", "cli-node.mjs"], ["akm-migrate-storage", "dist/akm-migrate-storage", "scripts/migrate-storage.js", "migrate-storage-node.mjs"]]; for (const [name, expected, bunEntry, nodeEntry] of bins) { const actual = pkg.bin?.[name]; if (actual !== expected) { console.error(`npm bin ${name} must point at ${expected}, got ${actual ?? "<undefined>"}`); process.exit(1); } if (!fs.existsSync(actual)) { console.error(`Missing npm bin target: ${actual}`); process.exit(1); } const entry = fs.readFileSync(actual, "utf8"); if (!entry.startsWith("#!/bin/sh")) { console.error(`npm bin ${name} must be a portable shell launcher`); process.exit(1); } if (!entry.includes(`exec bun \"$SCRIPT_DIR/${bunEntry}\" \"$@\"`) || !entry.includes(`exec node \"$SCRIPT_DIR/${nodeEntry}\" \"$@\"`)) { console.error(`npm bin ${name} must fall back from bun to node`); process.exit(1); } } for (const nodeWrapper of ["dist/cli-node.mjs", "dist/migrate-storage-node.mjs"]) { if (!fs.existsSync(nodeWrapper)) { console.error(`Missing Node wrapper: ${nodeWrapper}`); process.exit(1); } const entry = fs.readFileSync(nodeWrapper, "utf8"); if (!entry.startsWith("#!/usr/bin/env node")) { console.error(`Node wrapper ${nodeWrapper} must keep the node shebang`); process.exit(1); } } if (pkg.engines?.node !== ">=20.12.0") { console.error(`package engines.node must be >=20.12.0, got ${pkg.engines?.node ?? "<undefined>"}`); process.exit(1); } if (fs.existsSync("dist/tests")) { console.error("Publish build should not emit dist/tests"); process.exit(1); }'
run_step \
  "Install and Setup Regression Suite" \
  bun test tests/setup.test.ts ./tests/integration/setup-run.test.ts tests/install-script.test.ts tests/setup-wizard.test.ts
run_step "Full Test Suite" bun test --timeout=30000

if [ "$SKIP_DOCKER" = false ]; then
	run_step "Docker Install Matrix" "$SCRIPT_DIR/docker/run-docker-tests.sh"
fi

echo "Release validation passed."
