#!/usr/bin/env bash
# run-bench.sh — run akm-bench inside a container, mirroring the local CLI shape.
#
# Usage:
#   ./tests/docker/run-bench.sh <config.json> [overrides...]
#
# Examples:
#   # Bench against the current source tree (default).
#   ./tests/docker/run-bench.sh tests/bench/configs/nano-quick.json
#
#   # Bench against the published npm version.
#   AKM_INSTALL=npm AKM_VERSION=latest \
#     ./tests/docker/run-bench.sh tests/bench/configs/nano-quick.json
#
#   # Pin to a specific published version + restrict to one task.
#   AKM_INSTALL=npm AKM_VERSION=0.7.2 \
#     ./tests/docker/run-bench.sh tests/bench/configs/full.json \
#     --tasks drillbit/backup-policy --seeds 1 --json
#
# Provider discovery (host side) — same chain as run-config.ts:
#   1. BENCH_OPENCODE_CONFIG env var (absolute path).
#   2. Inline `providers` in the config file.
#   3. `providersRef` in the config file (~ and ${VAR} expanded).
#   4. ${XDG_CONFIG_HOME:-~/.config}/akm/bench-providers.json.
#
# The wrapper resolves the providers file on the HOST, bind-mounts it at
# /opt/akm/.docker/providers.json inside the container, and lets the
# in-container BENCH_OPENCODE_CONFIG env var (set in Dockerfile.bench)
# pick it up. This means an operator's ~/.config/akm/bench-providers.json
# drives both local and docker runs with no extra wiring.
#
# Output: JSON reports land on the host at $BENCH_OUT_DIR (default
# ./bench-results/) at <config-name>-<timestamp>.json.
#
# Env var overrides:
#   AKM_INSTALL=source|npm        default: source
#   AKM_VERSION=<x.y.z|latest>    default: latest (only used when AKM_INSTALL=npm)
#   BENCH_OUT_DIR=<host path>     default: ./bench-results
#   IMAGE_TAG=<tag>               default: akm-bench:${AKM_INSTALL}
set -euo pipefail

if [ $# -eq 0 ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
	cat <<'USAGE'
Usage: ./tests/docker/run-bench.sh <config.json> [overrides...]

Env:
  AKM_INSTALL    source (default) | npm
  AKM_VERSION    npm version when AKM_INSTALL=npm (default: latest)
  BENCH_OUT_DIR  host output dir (default: ./bench-results)
  IMAGE_TAG      docker image tag (default: akm-bench:${AKM_INSTALL})

The first positional arg is a path to a tests/bench/configs/*.json file
(host path; resolved relative to the project root). Remaining args are
forwarded to the in-container `bun run tests/bench/cli.ts` invocation —
typically --json, --seeds N, --parallel N, --tasks <list>.
USAGE
	exit 0
fi

CONFIG_PATH="$1"
shift
EXTRA_ARGS=("$@")

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

# Resolve config to an absolute host path so we can bind-mount it.
if [ ! -f "$CONFIG_PATH" ]; then
	CONFIG_PATH="$PROJECT_ROOT/$CONFIG_PATH"
fi
if [ ! -f "$CONFIG_PATH" ]; then
	echo "run-bench.sh: config not found: $1" >&2
	exit 2
fi
CONFIG_PATH="$(cd "$(dirname "$CONFIG_PATH")" && pwd)/$(basename "$CONFIG_PATH")"
CONFIG_BASENAME="$(basename "$CONFIG_PATH" .json)"

AKM_INSTALL="${AKM_INSTALL:-source}"
AKM_VERSION="${AKM_VERSION:-latest}"
IMAGE_TAG="${IMAGE_TAG:-akm-bench:${AKM_INSTALL}}"
BENCH_OUT_DIR="${BENCH_OUT_DIR:-${PROJECT_ROOT}/bench-results}"

if [ "$AKM_INSTALL" != "source" ] && [ "$AKM_INSTALL" != "npm" ]; then
	echo "run-bench.sh: AKM_INSTALL must be 'source' or 'npm', got: $AKM_INSTALL" >&2
	exit 2
fi

# ── Resolve the providers file on the HOST ────────────────────────────────
expand_path() {
	# Tilde + ${VAR} expansion. Mirrors run-config.ts:resolvePathString.
	local s="$1"
	local base="$2"
	# Expand ${VAR} forms.
	s="$(echo "$s" | envsubst)"
	# Tilde expansion.
	if [ "$s" = "~" ]; then
		s="$HOME"
	elif [ "${s#~/}" != "$s" ]; then
		s="$HOME/${s#~/}"
	fi
	# Resolve relative paths against base.
	case "$s" in
	/*) ;;
	*) s="$base/$s" ;;
	esac
	echo "$s"
}

PROVIDERS_PATH=""
if [ -n "${BENCH_OPENCODE_CONFIG:-}" ] && [ -f "$BENCH_OPENCODE_CONFIG" ]; then
	PROVIDERS_PATH="$BENCH_OPENCODE_CONFIG"
fi

if [ -z "$PROVIDERS_PATH" ]; then
	# Try `providersRef` in the config file. Use `node` to read it (already
	# required transitively by bun) — keeps us out of brittle JSON-in-bash.
	PROVIDERS_REF="$(node -e '
		const fs = require("node:fs");
		const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		if (c.providers !== undefined) { process.stdout.write("__INLINE__"); return; }
		if (typeof c.providersRef === "string") process.stdout.write(c.providersRef);
	' "$CONFIG_PATH" 2>/dev/null || true)"
	if [ "$PROVIDERS_REF" = "__INLINE__" ]; then
		# Inline providers — leave PROVIDERS_PATH empty; the in-container
		# loader will materialise from the config itself.
		PROVIDERS_PATH=""
	elif [ -n "$PROVIDERS_REF" ]; then
		CONFIG_DIR="$(dirname "$CONFIG_PATH")"
		PROVIDERS_PATH="$(expand_path "$PROVIDERS_REF" "$CONFIG_DIR")"
	fi
fi

if [ -z "$PROVIDERS_PATH" ] && [ -z "${PROVIDERS_REF:-}" ]; then
	# Fall back to per-operator default location.
	XDG="${XDG_CONFIG_HOME:-$HOME/.config}"
	if [ -f "$XDG/akm/bench-providers.json" ]; then
		PROVIDERS_PATH="$XDG/akm/bench-providers.json"
	fi
fi

INLINE_PROVIDERS="false"
if [ "${PROVIDERS_REF:-}" = "__INLINE__" ]; then
	INLINE_PROVIDERS="true"
fi

if [ "$INLINE_PROVIDERS" = "false" ] && [ -z "$PROVIDERS_PATH" ]; then
	cat >&2 <<'NOPROV'
run-bench.sh: no opencode providers found.
  Set one of:
    - BENCH_OPENCODE_CONFIG=/abs/path/to/providers.json
    - `providersRef` in the run config (relative to its dir, ~/... or ${VAR}/...)
    - ~/.config/akm/bench-providers.json
NOPROV
	exit 2
fi

if [ -n "$PROVIDERS_PATH" ] && [ ! -f "$PROVIDERS_PATH" ]; then
	echo "run-bench.sh: providers file not found at $PROVIDERS_PATH" >&2
	exit 2
fi

# ── Build the image (cached) ──────────────────────────────────────────────
echo "==> Building $IMAGE_TAG (AKM_INSTALL=$AKM_INSTALL${AKM_INSTALL:+, AKM_VERSION=$AKM_VERSION})" >&2
docker build \
	-f "$SCRIPT_DIR/Dockerfile.bench" \
	--build-arg "AKM_INSTALL=$AKM_INSTALL" \
	--build-arg "AKM_VERSION=$AKM_VERSION" \
	-t "$IMAGE_TAG" \
	"$PROJECT_ROOT" >&2

# ── Run the bench ─────────────────────────────────────────────────────────
mkdir -p "$BENCH_OUT_DIR"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILENAME="${CONFIG_BASENAME}-${TIMESTAMP}.json"

# Compute the in-container path of the config — mounted at the same
# project-relative path so `providersRef` resolution still works.
RELATIVE_CONFIG="${CONFIG_PATH#$PROJECT_ROOT/}"
CONTAINER_CONFIG="/opt/akm/$RELATIVE_CONFIG"

DOCKER_ARGS=(
	run --rm
	-v "$BENCH_OUT_DIR:/out"
)

# Forward common API-key env vars when present so {env:VAR} env-refs in
# the providers file resolve inside the container.
for v in OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY GROQ_API_KEY \
	GOOGLE_API_KEY GEMINI_API_KEY MISTRAL_API_KEY DEEPSEEK_API_KEY \
	BENCH_OPENCODE_MODEL; do
	if [ -n "${!v:-}" ]; then
		DOCKER_ARGS+=(-e "$v=${!v}")
	fi
done

# Bind-mount the providers file when one was resolved on the host. The
# Dockerfile sets BENCH_OPENCODE_CONFIG=/opt/akm/.docker/providers.json so
# the in-container loader picks it up regardless of the config's own
# providersRef. For inline providers (__INLINE__), we unset the env var
# so the config-internal `providers` block wins.
if [ -n "$PROVIDERS_PATH" ]; then
	DOCKER_ARGS+=(-v "$PROVIDERS_PATH:/opt/akm/.docker/providers.json:ro")
elif [ "$INLINE_PROVIDERS" = "true" ]; then
	DOCKER_ARGS+=(-e "BENCH_OPENCODE_CONFIG=")
fi

echo "==> Running bench: $CONFIG_BASENAME → $BENCH_OUT_DIR/$OUT_FILENAME" >&2

# Stdout JSON is captured to the output file; stderr (markdown summary +
# trace lines) is shown on the host's stderr in real time.
docker "${DOCKER_ARGS[@]}" "$IMAGE_TAG" \
	"$CONTAINER_CONFIG" "${EXTRA_ARGS[@]}" >"$BENCH_OUT_DIR/$OUT_FILENAME"

echo "==> Wrote $BENCH_OUT_DIR/$OUT_FILENAME" >&2
