#!/usr/bin/env bash
# Copy this repo's tracked files to DEST and apply the Windows overlay there.
#
# The fork never edits upstream files in place (that is what keeps the scheduled
# upstream sync conflict-free). The upstream files the Windows build needs
# changed - the win32 gates of the shipped features, the Windows Settings ->
# Extra nav and Community list, Windows fixes (diff views git resolution,
# quick open path joins, theme engine details, the 3P folder),
# apply_patches.py --windows, the windows category of run-feature-tests.sh, the
# patches/windows Makefile rule and the Windows test cases - live in
# scripts/windows/overlay/*.patch (one per feature) and
# are applied to a copy at build time. If upstream moved the lines it touches,
# `git apply` fails here, loudly, instead of the sync conflicting.
#
# Usage: scripts/windows/prepare-sources.sh DEST
#
# To change the overlay: edit the files in a prepared copy, then run
# scripts/windows/regen-overlay.sh DEST (DEST is a git repo whose first commit
# is the pristine copy; the script's group() map says which patch a file is in).

set -euo pipefail

DEST="${1:?usage: prepare-sources.sh DEST}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OVERLAY_DIR="$REPO_DIR/scripts/windows/overlay"
shopt -s nullglob
PATCHES=("$OVERLAY_DIR"/*.patch)
[ ${#PATCHES[@]} -gt 0 ] || { echo "[prepare-sources] no patches in $OVERLAY_DIR" >&2; exit 1; }
mkdir -p "$DEST"
[ -z "$(ls -A "$DEST")" ] || { echo "[prepare-sources] $DEST is not empty" >&2; exit 1; }

# Tracked files only, as they are in the working tree.
( cd "$REPO_DIR" && git ls-files -z | tar --null -T - -cf - ) | tar -xf - -C "$DEST"

# A throwaway repo, so git apply works on DEST and nowhere else, and
# `git -C DEST diff` shows the overlay afterwards.
git -C "$DEST" init -q
git -C "$DEST" add -A
git -C "$DEST" -c user.name=overlay -c user.email=overlay@localhost commit -qm pristine

for patch in "${PATCHES[@]}"; do
    if ! git -C "$DEST" apply --check "$patch" 2>"$DEST/.overlay-error"; then
        echo "[prepare-sources] ERROR: scripts/windows/overlay/$(basename "$patch") no longer applies:" >&2
        cat "$DEST/.overlay-error" >&2
        echo "[prepare-sources] Upstream changed lines the Windows build edits. Re-fit that patch (see the header of this script)." >&2
        exit 1
    fi
    git -C "$DEST" apply "$patch"
done
rm -f "$DEST/.overlay-error"
echo "[prepare-sources] Windows overlay applied: $(git -C "$DEST" diff --stat | tail -1)"
