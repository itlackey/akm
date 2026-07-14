#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CANDIDATE_DIR="$(mktemp -d)"
PACKAGE_CANDIDATE=""
trap 'rm -rf "$CANDIDATE_DIR"' EXIT

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

pack_package_candidate() {
	npm pack --ignore-scripts --pack-destination "$CANDIDATE_DIR"
	shopt -s nullglob
	local tarballs=("$CANDIDATE_DIR"/*.tgz)
	if [ "${#tarballs[@]}" -ne 1 ]; then
		echo "Expected one package candidate, found ${#tarballs[@]}" >&2
		return 1
	fi
	PACKAGE_CANDIDATE="${tarballs[0]}"
}

validate_workflow_syntax() {
	if command -v actionlint >/dev/null 2>&1; then
		actionlint "$PROJECT_ROOT"/.github/workflows/*.yml
		return
	fi

	local version="1.7.12"
	local platform arch archive checksum
	case "$(uname -s):$(uname -m)" in
	Linux:x86_64)
		platform="linux"
		arch="amd64"
		checksum="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
		;;
	Linux:aarch64 | Linux:arm64)
		platform="linux"
		arch="arm64"
		checksum="325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6"
		;;
	Darwin:x86_64)
		platform="darwin"
		arch="amd64"
		checksum="5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644"
		;;
	Darwin:arm64 | Darwin:aarch64)
		platform="darwin"
		arch="arm64"
		checksum="aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f"
		;;
	*)
		echo "No pinned actionlint binary for $(uname -s) $(uname -m)" >&2
		return 1
		;;
	esac

	archive="$CANDIDATE_DIR/actionlint_${version}_${platform}_${arch}.tar.gz"
	curl -fsSL "https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_${platform}_${arch}.tar.gz" -o "$archive"
	if [ "$platform" = "darwin" ]; then
		printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 -c -
	else
		printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
	fi
	mkdir -p "$CANDIDATE_DIR/actionlint"
	tar -xzf "$archive" -C "$CANDIDATE_DIR/actionlint" actionlint
	"$CANDIDATE_DIR/actionlint/actionlint" "$PROJECT_ROOT"/.github/workflows/*.yml
}

run_step "Workflow Syntax" validate_workflow_syntax
run_step "Workflow Release Contract" bun test tests/workflow-release.test.ts
run_step "Lint" bunx biome check --write src/ tests/
run_step "Type Check" bunx tsc --noEmit
run_step "Build Package" bun run build
run_step \
	"Verify npm bin target" \
	node -e 'const fs = require("node:fs"); const pkg = require("./package.json"); const bins = [["akm", "dist/akm", "cli.js", "cli-node.mjs"], ["akm-migrate-storage", "dist/akm-migrate-storage", "scripts/migrate-storage.js", "migrate-storage-node.mjs"]]; for (const [name, expected, bunEntry, nodeEntry] of bins) { const actual = pkg.bin?.[name]; if (actual !== expected) { console.error(`npm bin ${name} must point at ${expected}, got ${actual ?? "<undefined>"}`); process.exit(1); } if (!fs.existsSync(actual)) { console.error(`Missing npm bin target: ${actual}`); process.exit(1); } const entry = fs.readFileSync(actual, "utf8"); if (!entry.startsWith("#!/usr/bin/env node")) { console.error(`npm bin ${name} must expose Node to npm platform shims`); process.exit(1); } if (!entry.includes(`new URL("./${bunEntry}", import.meta.url)`) || !entry.includes(`await import("./${nodeEntry}")`)) { console.error(`npm bin ${name} must select the Bun entry with a Node-wrapper fallback`); process.exit(1); } } for (const nodeWrapper of ["dist/cli-node.mjs", "dist/migrate-storage-node.mjs"]) { if (!fs.existsSync(nodeWrapper)) { console.error(`Missing Node wrapper: ${nodeWrapper}`); process.exit(1); } const entry = fs.readFileSync(nodeWrapper, "utf8"); if (!entry.startsWith("#!/usr/bin/env node")) { console.error(`Node wrapper ${nodeWrapper} must keep the node shebang`); process.exit(1); } } if (pkg.engines?.node !== ">=20.12.0") { console.error(`package engines.node must be >=20.12.0, got ${pkg.engines?.node ?? "<undefined>"}`); process.exit(1); } if (fs.existsSync("dist/tests")) { console.error("Publish build should not emit dist/tests"); process.exit(1); }'
run_step "Pack Package Candidate" pack_package_candidate
run_step \
  "Install and Setup Regression Suite" \
  bun test tests/setup.test.ts ./tests/integration/setup-run.test.ts tests/install-script.test.ts tests/setup-wizard.test.ts
run_step \
  "Published 0.8 Task Upgrade" \
  env AKM_PUBLISHED_UPGRADE_TESTS=1 AKM_PUBLISHED_UPGRADE_TARBALL="$PACKAGE_CANDIDATE" AKM_CANDIDATE_VERSION="$(node -p "require('./package.json').version")" bun test tests/integration/published-task-upgrade.test.ts
if [ "$(uname -s)" = "Linux" ]; then
	run_step \
		"Build Linux Standalone Scheduler Artifact" \
		bun build ./src/cli.ts --compile --external @huggingface/transformers --outfile "$CANDIDATE_DIR/akm-linux-x64" --define "AKM_VERSION='$(node -p "require('./package.json').version")'"
	run_step \
		"Linux Standalone Outside PATH" \
		env AKM_STANDALONE_SCHEDULER_TESTS=1 AKM_STANDALONE_TEST_BIN="$CANDIDATE_DIR/akm-linux-x64" AKM_CANDIDATE_ARCH="$(node -p 'process.arch')" AKM_CANDIDATE_VERSION="$(node -p "require('./package.json').version")" bun test tests/integration/linux-standalone-scheduler.test.ts
fi
run_step "Full Test Suite" bun test --timeout=30000

if [ "$SKIP_DOCKER" = false ]; then
	run_step "Docker Install Matrix" "$SCRIPT_DIR/docker/run-docker-tests.sh"
fi

echo "Release validation passed."
