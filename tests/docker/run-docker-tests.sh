#!/usr/bin/env bash
# run-docker-tests.sh — Build and run akm Docker install tests across OS variants.
#
# Usage:
#   ./tests/docker/run-docker-tests.sh              # Run all tests
#   ./tests/docker/run-docker-tests.sh ubuntu-bun   # Run a single variant
#   ./tests/docker/run-docker-tests.sh --bun-only   # Only bun install tests
#   ./tests/docker/run-docker-tests.sh --binary-only # Only binary install tests
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_ROOT"

ALL_VARIANTS=(
	ubuntu-bun
	ubuntu-binary
	debian-bun
	debian-binary
	debian-npm
	alpine-bun
	fedora-bun
	fedora-binary
)

# Parse arguments
VARIANTS=()
for arg in "$@"; do
	case "$arg" in
	--bun-only)
		VARIANTS=(ubuntu-bun debian-bun alpine-bun fedora-bun)
		;;
	--binary-only)
		VARIANTS=(ubuntu-binary debian-binary fedora-binary)
		;;
	--help | -h)
		echo "Usage: $0 [variant...] [--bun-only|--binary-only]"
		echo ""
		echo "Variants: ${ALL_VARIANTS[*]}"
		exit 0
		;;
	*)
		VARIANTS+=("$arg")
		;;
	esac
done

if [ ${#VARIANTS[@]} -eq 0 ]; then
	VARIANTS=("${ALL_VARIANTS[@]}")
fi

# Check if any binary variants are requested
NEED_BINARY=false
for v in "${VARIANTS[@]}"; do
	if [[ "$v" == *-binary ]]; then
		NEED_BINARY=true
		break
	fi
done

# Build the Linux x64 binary if needed
if [ "$NEED_BINARY" = true ]; then
	echo "=== Building akm binary for linux-x64 ==="
	mkdir -p "$SCRIPT_DIR/.build"

	if ! command -v bun &>/dev/null; then
		echo "Error: bun is required to build the binary" >&2
		exit 1
	fi

	bun scripts/build-standalone.ts --target bun-linux-x64 --outfile "$SCRIPT_DIR/.build/akm"
	echo "Binary built: $SCRIPT_DIR/.build/akm"
	echo ""
fi

# Run tests
PASSED=0
FAILED=0
SKIPPED=0
FAILURES=""
SKIPS=""

for variant in "${VARIANTS[@]}"; do
	dockerfile="$SCRIPT_DIR/Dockerfile.${variant}"
	if [ ! -f "$dockerfile" ]; then
		echo "Warning: Dockerfile not found for variant '$variant', skipping."
		((++SKIPPED))
		SKIPS+="  $variant (no Dockerfile.${variant})\n"
		continue
	fi

	image_tag="akm-test-${variant}"
	echo "=== Testing: $variant ==="

	# Build the image
	if ! docker build \
		-f "$dockerfile" \
		-t "$image_tag" \
		--quiet \
		"$PROJECT_ROOT" 2>&1; then
		echo "  FAILED (build error)"
		((++FAILED))
		FAILURES+="  $variant (build failed)\n"
		echo ""
		continue
	fi

	# Run the smoke test
	if docker run --rm "$image_tag" 2>&1; then
		((++PASSED))
	else
		echo "  FAILED (test error)"
		((++FAILED))
		FAILURES+="  $variant (test failed)\n"
	fi

	echo ""
done

# Cleanup build artifacts
rm -rf "$SCRIPT_DIR/.build"

# Summary
echo "========================================"
echo "  Docker Install Test Results"
echo "========================================"
echo "  Passed: $PASSED / $((PASSED + FAILED))"
echo "  Failed: $FAILED / $((PASSED + FAILED))"
if [ "$SKIPPED" -gt 0 ]; then
	echo "  Skipped: $SKIPPED (requested variant(s) with no matching Dockerfile)"
	echo -e "$SKIPS"
fi

# A gate that never ran a variant must not report success: a typo'd variant
# name, an empty VARIANTS list, or every requested Dockerfile being missing
# would otherwise leave PASSED=0 and FAILED=0, falling through to "All tests
# passed" without having verified anything.
if [ "$((PASSED + FAILED))" -eq 0 ]; then
	echo ""
	echo "  ERROR: 0 of ${#VARIANTS[@]} requested variant(s) actually ran."
	if [ "$SKIPPED" -gt 0 ]; then
		echo "  All requested variants were skipped (missing Dockerfile) — see above."
	else
		echo "  No variants were requested. Nothing was verified."
	fi
	exit 1
fi

if [ "$FAILED" -gt 0 ]; then
	echo ""
	echo "  Failures:"
	echo -e "$FAILURES"
	exit 1
fi

echo ""
echo "  All tests passed."
exit 0
