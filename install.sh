#!/usr/bin/env bash
set -euo pipefail

REPO="itlackey/agentikit"
INSTALL_DIR="${AGENTIKIT_INSTALL_DIR:-/usr/local/bin}"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*)
    echo "On Windows, use install.ps1 instead:" >&2
    echo "  irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex" >&2
    exit 1
    ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

BINARY="agentikit-${OS}-${ARCH}"
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

echo "Downloading ${BINARY}..."
if command -v curl &>/dev/null; then
  curl -fsSL -o "$TMPFILE" "$DOWNLOAD_URL"
  curl -fsSL -o "$CHECKSUM_FILE" "$CHECKSUM_URL"
elif command -v wget &>/dev/null; then
  wget -qO "$TMPFILE" "$DOWNLOAD_URL"
  wget -qO "$CHECKSUM_FILE" "$CHECKSUM_URL"
else
  echo "Error: curl or wget is required" >&2
  exit 1
fi

EXPECTED_HASH="$(awk -v f="$BINARY" '$2 == f { print $1 }' "$CHECKSUM_FILE")"
if [ -z "$EXPECTED_HASH" ]; then
  echo "Error: checksum not found for ${BINARY}" >&2
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
  mv "$TMPFILE" "${INSTALL_DIR}/agentikit"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMPFILE" "${INSTALL_DIR}/agentikit"
fi

echo "agentikit installed to ${INSTALL_DIR}/agentikit"
