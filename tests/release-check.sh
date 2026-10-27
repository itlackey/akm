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

# The built CLI configures and reports models: a config with one connection,
# then a config with only a harness. Offline: the endpoint is a discard port and
# every command that would ask it passes --no-probe.
verify_model_surface() {
	local root="$CANDIDATE_DIR/model-surface"
	local out status

	akm_in() {
		local scenario="$1"
		shift
		env HOME="$root/$scenario/home" \
			XDG_CONFIG_HOME="$root/$scenario/config" XDG_DATA_HOME="$root/$scenario/data" \
			XDG_CACHE_HOME="$root/$scenario/cache" XDG_STATE_HOME="$root/$scenario/state" \
			AKM_BUNDLE_DIR="$root/$scenario/bundle" \
			"$PROJECT_ROOT/dist/akm" "$@"
	}

	# expect "<statuses>" "<needle>" "<label>" <scenario> <akm args...>
	expect() {
		local statuses="$1" needle="$2" label="$3"
		shift 3
		status=0
		out="$(akm_in "$@" 2>&1)" || status=$?
		if [[ " $statuses " != *" $status "* ]]; then
			echo "$label: exited $status, expected one of: $statuses" >&2
			echo "$out" >&2
			return 1
		fi
		if ! grep -q -- "$needle" <<<"$out"; then
			echo "$label: expected '$needle' in the output" >&2
			echo "$out" >&2
			return 1
		fi
	}

	mkdir -p "$root/connection" "$root/harness"
	expect "0" '"shape": "setup"' "setup --endpoint" \
		connection setup --yes --no-init --no-probe --endpoint http://127.0.0.1:9/v1
	expect "0" '"model": "smoke-model"' "models set" connection models set fast smoke-model --no-probe
	expect "0" '"fast": "smoke-model"' "models" connection models --no-probe
	expect "0 4" '"type": "connection"' "health --no-probe on a connection" connection health --no-probe
	expect "0" '"type": "connection"' "info on a connection" connection info

	expect "0" "" "config set harnesses.claude" harness config set harnesses.claude '{}' --silent
	expect "78" 'akm setup' "models with no connection" harness models --no-probe
	expect "0 4" '"type": "harness"' "health --no-probe on a harness" harness health --no-probe
	expect "0" '"type": "harness"' "info on a harness" harness info
}

# Release acceptance for the packaged artifact. Lint, typecheck, the unit and
# integration suites and the native-scheduler gates run in CI and Gated CI on
# the same commit; release.yml requires both before it publishes.
run_step "Workflow Syntax" validate_workflow_syntax
run_step "Build Package" bun run build
run_step \
	"Verify npm bin target" \
	node -e 'const fs = require("node:fs"); const pkg = require("./package.json"); const bins = [["akm", "dist/akm", "cli.js", "cli-node.mjs"], ["akm-migrate", "dist/akm-migrate", "scripts/akm-migrate.js"]]; for (const [name, expected, bunEntry, nodeEntry] of bins) { const actual = pkg.bin?.[name]; if (actual !== expected) { console.error(`npm bin ${name} must point at ${expected}, got ${actual ?? "<undefined>"}`); process.exit(1); } if (!fs.existsSync(actual)) { console.error(`Missing npm bin target: ${actual}`); process.exit(1); } if (!fs.existsSync(`dist/${bunEntry}`)) { console.error(`Missing bundled entry: dist/${bunEntry}`); process.exit(1); } const entry = fs.readFileSync(actual, "utf8"); if (!entry.startsWith("#!/usr/bin/env node")) { console.error(`npm bin ${name} must expose Node to npm platform shims`); process.exit(1); } if (!entry.includes(`new URL("./${bunEntry}", import.meta.url)`)) { console.error(`npm bin ${name} must select its Bun entry`); process.exit(1); } if (nodeEntry && !entry.includes(`await import("./${nodeEntry}")`)) { console.error(`npm bin ${name} must retain its Node fallback`); process.exit(1); } if (!nodeEntry && entry.includes("migrate-storage-node.mjs")) { console.error(`npm bin ${name} must not retain the removed Node fallback`); process.exit(1); } } if (!fs.existsSync("dist/cli-node.mjs")) { console.error("Missing Node wrapper: dist/cli-node.mjs"); process.exit(1); } if (pkg.bin?.["akm-migrate-storage"] !== undefined) { console.error("Removed akm-migrate-storage bin is still declared"); process.exit(1); } for (const removed of ["dist/akm-migrate-storage", "dist/migrate-storage-node.mjs", "dist/scripts/migrate-storage.js"]) { if (fs.existsSync(removed)) { console.error(`Removed migration artifact still exists: ${removed}`); process.exit(1); } } if (pkg.engines?.node !== ">=22") { console.error(`package engines.node must be >=22, got ${pkg.engines?.node ?? "<undefined>"}`); process.exit(1); } if (fs.existsSync("dist/tests")) { console.error("Publish build should not emit dist/tests"); process.exit(1); }'
	run_step \
		"Verify task migration bundle" \
		node -e 'const { spawnSync } = require("node:child_process"); const result = spawnSync("./dist/akm-migrate", ["--help"], { encoding: "utf8" }); if (result.error || result.status !== 0) { console.error(result.error?.message ?? result.stderr); process.exit(1); } if (!result.stdout.includes("Usage: akm-migrate <command>") || !result.stdout.includes("state.db")) { console.error("Packaged migrator does not expose the combined status/apply surface"); process.exit(1); }'
run_step \
	"Verify migration runtime entries" \
	node -e 'const fs = require("node:fs"); const launcher = fs.readFileSync("dist/akm-migrate", "utf8"); for (const entry of ["scripts/akm-migrate.js", "scripts/akm-migrate-node.js"]) { if (!fs.existsSync(`dist/${entry}`)) { console.error(`Missing migration runtime entry: dist/${entry}`); process.exit(1); } if (!launcher.includes(`new URL("./${entry}", import.meta.url)`)) { console.error(`Migration launcher does not select ${entry}`); process.exit(1); } }'
	run_step \
		"Verify Node task migration bundle" \
		node -e 'const { spawnSync } = require("node:child_process"); const result = spawnSync(process.execPath, ["./dist/scripts/akm-migrate-node.js", "--help"], { encoding: "utf8" }); if (result.error || result.status !== 0) { console.error(result.error?.message ?? result.stderr); process.exit(1); } if (!result.stdout.includes("Usage: akm-migrate <command>") || !result.stdout.includes("state.db")) { console.error("Packaged Node migrator does not expose the combined status/apply surface"); process.exit(1); }'
run_step "Verify model surface" verify_model_surface
# The compiled standalone binary's first run of akm's own runtime, with the OpenCode binary it runs fetched once into a cache the test shares (the registry is the one step that needs the network) and nothing downloaded for the provider.
run_step \
	"Verify standalone binary first run" \
	bun test --timeout=300000 tests/integration/standalone-first-run.test.ts
run_step "Package Acceptance" bun scripts/package-install.ts test-package --skip-build
run_step "Pack Package Candidate" pack_package_candidate
run_step \
	"Upgrade Rehearsal" \
	env AKM_UPGRADE_REHEARSAL=1 AKM_CANDIDATE_TARBALL="$PACKAGE_CANDIDATE" TMPDIR=/tmp bun test --timeout=900000 tests/integration/upgrade-rehearsal/
run_step \
	"Verify npm candidate release surface" \
	tar -tzf "$PACKAGE_CANDIDATE" \
	package/schemas/akm-task.json \
	package/docs/reference/tasks.md \
	package/docs/migration/v0.9.1-to-v0.9.2.md \
	package/docs/migration/release-notes/0.9.2.md \
	package/docs/reference/workflow-schema.md
if [ "$SKIP_DOCKER" = false ]; then
	run_step "Docker Install Matrix" "$SCRIPT_DIR/docker/run-docker-tests.sh"
fi

echo "Release validation passed."
