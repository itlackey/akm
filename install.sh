#!/usr/bin/env bash
set -euo pipefail

REPO="itlackey/akm"
INSTALL_URL="https://raw.githubusercontent.com/${REPO}/main/install.sh"
INSTALL_DIR="${AKM_INSTALL_DIR:-}"
SYSTEM=0
TAG="latest"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --system) SYSTEM=1; shift ;;
    --dir)
      if [ "$#" -lt 2 ]; then echo "Error: --dir needs a directory" >&2; exit 1; fi
      INSTALL_DIR="$2"; shift 2 ;;
    -*) echo "Error: unknown option $1 (use --system, --dir <dir>, or a release tag)" >&2; exit 1 ;;
    *) TAG="$1"; shift ;;
  esac
done
INSTALL_DIR="${INSTALL_DIR%/}"

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

if [ -z "${HOME:-}" ] && [ -z "$INSTALL_DIR" ] && [ "$SYSTEM" -eq 0 ]; then
  echo "Error: HOME is not set; pass --dir <dir> or --system." >&2
  exit 1
fi

# Pick the install dir. --dir / AKM_INSTALL_DIR win; --system means
# /usr/local/bin (sudo when needed); otherwise /usr/local/bin only if we can
# already write there, else a user install in ~/.local/bin. A root-owned dir
# makes every later `akm upgrade` fail, so sudo is never used implicitly.
if [ -z "$INSTALL_DIR" ]; then
  if [ "$SYSTEM" -eq 1 ] || [ "$(id -u)" -eq 0 ] || [ -w /usr/local/bin ]; then
    INSTALL_DIR="/usr/local/bin"
  else
    INSTALL_DIR="$HOME/.local/bin"
    echo "Note: installing for the current user in $INSTALL_DIR (no sudo)."
    echo "      For a system-wide install in /usr/local/bin instead, run:"
    echo "        curl -fsSL $INSTALL_URL | bash -s -- --system"
    echo ""
  fi
fi

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

BINARY="akm-${OS}-${ARCH}"

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

# Install, using sudo only for an explicit --system install.
USE_SUDO=0
if [ ! -d "$INSTALL_DIR" ]; then
  mkdir -p "$INSTALL_DIR" 2>/dev/null || USE_SUDO=1
elif [ ! -w "$INSTALL_DIR" ]; then
  USE_SUDO=1
fi
if [ "$USE_SUDO" -eq 1 ]; then
  if [ "$SYSTEM" -ne 1 ]; then
    echo "Error: cannot write to ${INSTALL_DIR}." >&2
    echo "Pick a directory you own, or ask for a system install (uses sudo):" >&2
    echo "  curl -fsSL $INSTALL_URL | bash -s -- --dir \$HOME/.local/bin" >&2
    echo "  curl -fsSL $INSTALL_URL | bash -s -- --system" >&2
    exit 1
  fi
  if ! command -v sudo &>/dev/null; then
    echo "Error: --system needs write access to ${INSTALL_DIR}, but sudo is not available." >&2
    echo "Re-run as root, or install for your user:" >&2
    echo "  curl -fsSL $INSTALL_URL | bash -s -- --dir \$HOME/.local/bin" >&2
    exit 1
  fi
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mkdir -p "$INSTALL_DIR"
  sudo mv "$TMPFILE" "${INSTALL_DIR}/akm"
else
  mv "$TMPFILE" "${INSTALL_DIR}/akm"
fi

echo "akm installed to ${INSTALL_DIR}/akm"

if [ "$USE_SUDO" -eq 1 ]; then
  echo ""
  echo "Note: ${INSTALL_DIR} is owned by root, so upgrade with: sudo akm upgrade"
fi

# PATH checks
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    case "$(basename "${SHELL:-}")" in
      zsh)  PROFILE="$HOME/.zshrc" ;;
      bash) if [ "$OS" = "darwin" ]; then PROFILE="$HOME/.bash_profile"; else PROFILE="$HOME/.bashrc"; fi ;;
      *)    PROFILE="your shell profile" ;;
    esac
    echo ""
    echo "Warning: ${INSTALL_DIR} is not on your PATH. Add it to ${PROFILE}:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

FOUND="$(command -v akm 2>/dev/null || true)"
if [ -n "$FOUND" ] && [ "$FOUND" != "${INSTALL_DIR}/akm" ]; then
  echo ""
  echo "Warning: another akm on your PATH may shadow this install:"
  echo "  $FOUND"
  echo "Remove it, or put ${INSTALL_DIR} before it on PATH."
fi

echo ""
echo "To get started, run:"
echo "  akm setup"
