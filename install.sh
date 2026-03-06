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
else
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY}"
fi

TMPFILE="$(mktemp)"
trap 'rm -f "$TMPFILE"' EXIT

echo "Downloading ${BINARY}..."
if command -v curl &>/dev/null; then
  curl -fsSL -o "$TMPFILE" "$DOWNLOAD_URL"
elif command -v wget &>/dev/null; then
  wget -qO "$TMPFILE" "$DOWNLOAD_URL"
else
  echo "Error: curl or wget is required" >&2
  exit 1
fi

chmod +x "$TMPFILE"

# Use sudo if needed
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "${INSTALL_DIR}/agentikit"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMPFILE" "${INSTALL_DIR}/agentikit"
fi

echo "agentikit installed to ${INSTALL_DIR}/agentikit"
