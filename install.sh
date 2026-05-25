#!/usr/bin/env bash
set -euo pipefail

REPO="itlackey/akm"
INSTALL_DIR="${AKM_INSTALL_DIR:-/usr/local/bin}"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "On Windows, use install.ps1 instead:" >&2
    echo "  irm https://github.com/${REPO}/releases/latest/download/install.ps1 | iex" >&2
    exit 1
    ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

# Print sudo notice up-front so users know what's coming before the prompt
if [ ! -w "$INSTALL_DIR" ] && [ "$INSTALL_DIR" = "/usr/local/bin" ]; then
  echo "Note: installing to $INSTALL_DIR will require sudo."
  echo "      To install user-local (no sudo), re-run with:"
  echo "        AKM_INSTALL_DIR=\$HOME/.local/bin $0"
  echo ""
fi

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

BINARY="akm-${OS}-${ARCH}"
TAG="${1:-latest}"

if [ "$TAG" = "latest" ]; then
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${BINARY}"
  CHECKSUM_URL="https://github.com/${REPO}/releases/latest/download/checksums.txt"
else
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY}"
  CHECKSUM_URL="https://github.com/${REPO}/releases/download/${TAG}/checksums.txt"
fi

TMPFILE="$(mktemp)"
CHECKSUM_FILE="$(mktemp)"
trap 'rm -f "$TMPFILE" "$CHECKSUM_FILE"' EXIT

# Fetch a URL with friendly errors. curl -f returns exit code 22 on HTTP 4xx;
# we map that (and the most common case, 404) to a "no release artifact for
# this OS/arch" message so users don't see a bare `curl: (22)` line and assume
# a build was tampered with (#470).
fetch_url() {
  local url="$1" out="$2" what="$3" rc=0
  if command -v curl &>/dev/null; then
    curl -fsSL -o "$out" "$url" || rc=$?
  elif command -v wget &>/dev/null; then
    wget -qO "$out" "$url" || rc=$?
  else
    echo "Error: curl or wget is required" >&2
    exit 1
  fi
  if [ "$rc" -eq 0 ]; then
    return 0
  fi
  rm -f "$out"
  # curl exit 22 / wget exit 8 ≈ HTTP error response (most commonly 404).
  if [ "$rc" -eq 22 ] || [ "$rc" -eq 8 ]; then
    echo "Error: ${what} not found (HTTP error) at:" >&2
    echo "  $url" >&2
    echo "" >&2
    echo "This usually means no release artifact exists for ${OS}-${ARCH}." >&2
    echo "Check available builds at: https://github.com/${REPO}/releases" >&2
  else
    echo "Error: download of ${what} failed (downloader exit ${rc})." >&2
    echo "  $url" >&2
    echo "Check connectivity and retry." >&2
  fi
  exit 1
}

echo "Downloading ${BINARY}..."
fetch_url "$DOWNLOAD_URL"  "$TMPFILE"        "binary ${BINARY}"
fetch_url "$CHECKSUM_URL"  "$CHECKSUM_FILE"  "checksums.txt"

EXPECTED_HASH="$(awk -v f="$BINARY" '$2 == f { print $1 }' "$CHECKSUM_FILE")"
if [ -z "$EXPECTED_HASH" ]; then
  echo "Error: checksum not found for ${BINARY} (missing from checksums.txt — release may be incomplete)." >&2
  echo "Report at: https://github.com/${REPO}/issues" >&2
  exit 1
fi

if command -v sha256sum &>/dev/null; then
  ACTUAL_HASH="$(sha256sum "$TMPFILE" | awk '{ print $1 }')"
elif command -v shasum &>/dev/null; then
  ACTUAL_HASH="$(shasum -a 256 "$TMPFILE" | awk '{ print $1 }')"
else
  echo "Error: sha256sum or shasum is required" >&2
  exit 1
fi

if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
  echo "Error: checksum verification failed for ${BINARY}" >&2
  exit 1
fi

echo "Checksum verified for ${BINARY}."

chmod +x "$TMPFILE"

# Use sudo if needed
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "${INSTALL_DIR}/akm"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMPFILE" "${INSTALL_DIR}/akm"
fi

echo "akm installed to ${INSTALL_DIR}/akm"

echo ""
echo "To get started, run:"
echo "  akm setup"
