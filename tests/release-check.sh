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
	node -e 'const fs = require("node:fs"); const pkg = require("./package.json"); const bin = pkg.bin?.akm; if (!bin || !fs.existsSync(bin)) { console.error(`Missing npm bin target: ${bin ?? "<undefined>"}`); process.exit(1); } if (fs.existsSync("dist/tests")) { console.error("Publish build should not emit dist/tests"); process.exit(1); }'
run_step \
	"Install and Setup Regression Suite" \
	bun test ./tests/setup-run.integration.ts tests/install-script.test.ts tests/setup-wizard.test.ts tests/setup.test.ts
run_step "Full Test Suite" bun test

if [ "$SKIP_DOCKER" = false ]; then
	run_step "Docker Install Matrix" "$SCRIPT_DIR/docker/run-docker-tests.sh"
fi

echo "Release validation passed."
