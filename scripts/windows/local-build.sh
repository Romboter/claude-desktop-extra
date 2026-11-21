#!/usr/bin/env bash
# Local twin of the CI "build" job (x64): overlay, feature tests, build.
# Run it in WSL/Linux (build-windows.sh is Linux-only); local-test.ps1 calls it.
# Tool versions come from the workflow, so they cannot drift. Output: dist-local/.
# Usage: scripts/windows/local-build.sh [--skip-tests]
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WF="$REPO/.github/workflows/build-windows.yml"
ver() { sed -n "s/^  $1: *//p" "$WF" | head -1; }
NODE_VERSION=$(ver NODE_VERSION); NIM_VERSION=$(ver NIM_VERSION); ASAR_VERSION=$(ver ASAR_VERSION)

missing=(); for c in curl make gcc zip unzip python3 xz git; do command -v "$c" >/dev/null || missing+=("$c"); done
[ ${#missing[@]} -eq 0 ] || { echo "Missing: ${missing[*]}  ->  sudo apt-get install -y build-essential zip unzip python3 xz-utils curl git" >&2; exit 1; }

T="$HOME/.cache/cde-tools"; mkdir -p "$T"
[ -d "$T/node-v$NODE_VERSION-linux-x64" ] || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C "$T"
[ -d "$T/nim-$NIM_VERSION" ] || curl -fsSL "https://nim-lang.org/download/nim-$NIM_VERSION-linux_x64.tar.xz" | tar -xJ -C "$T"
export PATH="$T/node-v$NODE_VERSION-linux-x64/bin:$T/nim-$NIM_VERSION/bin:$HOME/.nimble/bin:$PATH"
command -v asar >/dev/null || npm install -g "@electron/asar@$ASAR_VERSION"
[ -d "$HOME/.nimble/pkgs2" ] && ls "$HOME/.nimble/pkgs2" | grep -q '^regex-' || nimble install -y regex

# Work from a Linux-side copy: /mnt/c is slow and tars with CRLF risk.
SRC=$(mktemp -d); trap 'rm -rf "$SRC"' EXIT
"$REPO/scripts/windows/prepare-sources.sh" "$SRC/src"
if [ "${1:-}" != "--skip-tests" ]; then
  make -C "$SRC/src/patches" -j"$(nproc)" >/dev/null
  for cat in core community windows; do bash "$SRC/src/scripts/run-feature-tests.sh" "$cat"; done
fi

cd "$REPO"; rm -rf dist-local; mkdir dist-local
CDB_ORIGINAL_EXE_OUT=dist-local/original-claude-x64.exe scripts/windows/build-windows.sh --arch x64 --out dist-local
ls -1 dist-local
