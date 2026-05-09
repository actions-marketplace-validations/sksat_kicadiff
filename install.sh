#!/bin/sh
# kicadiff installer.
#
#   curl -fsSL https://raw.githubusercontent.com/sksat/kicadiff/main/install.sh | sh
#
# Detects OS / arch, downloads the matching release binary, drops it under
# $HOME/.local/bin (or KICADIFF_INSTALL_DIR), and makes it executable.
# kicad-cli must already be on PATH for the installed binary to be useful;
# this script does not install KiCad.
set -eu

REPO=sksat/kicadiff
INSTALL_DIR=${KICADIFF_INSTALL_DIR:-"$HOME/.local/bin"}
# `latest` resolves to the most recent non-draft / non-prerelease tag via
# GitHub's release API. Override with KICADIFF_VERSION=v0.1.0 to pin.
VERSION=${KICADIFF_VERSION:-latest}

err() { echo "kicadiff/install: $*" >&2; exit 1; }

# --- Detect platform -----------------------------------------------------
os=$(uname -s 2>/dev/null || echo unknown)
arch=$(uname -m 2>/dev/null || echo unknown)
case "$os" in
  Linux)  os_tag=linux ;;
  Darwin) os_tag=darwin ;;
  *)      err "unsupported OS: $os (Linux and macOS supported)" ;;
esac
case "$arch" in
  x86_64|amd64)        arch_tag=x64 ;;
  aarch64|arm64)       arch_tag=arm64 ;;
  *)                   err "unsupported arch: $arch (x86_64 and arm64 supported)" ;;
esac
asset="kicadiff-${os_tag}-${arch_tag}"

# --- Resolve download URL -------------------------------------------------
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

# --- Download ------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
target="$INSTALL_DIR/kicadiff"
tmp=$(mktemp) || err "could not create temp file"
trap 'rm -f "$tmp"' EXIT INT HUP TERM

echo "Downloading $url"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url"
else
  err "need curl or wget on PATH to download the release binary"
fi

mv "$tmp" "$target"
chmod +x "$target"
trap - EXIT INT HUP TERM

echo "Installed: $target"

# --- PATH hint -----------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    ;;
  *)
    echo
    echo "Note: $INSTALL_DIR is not in PATH."
    echo "Add this to your shell config (e.g. ~/.bashrc, ~/.zshrc):"
    echo
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

# --- kicad-cli sanity check ----------------------------------------------
if ! command -v kicad-cli >/dev/null 2>&1; then
  echo
  echo "Heads up: kicad-cli was not found on PATH. kicadiff needs"
  echo "kicad-cli (KiCad 9.0+) to render anything; install KiCad first."
fi
