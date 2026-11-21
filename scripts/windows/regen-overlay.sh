#!/usr/bin/env bash
# Rewrite scripts/windows/overlay/*.patch from the edits in a prepared copy.
# Usage: scripts/windows/regen-overlay.sh DEST   (DEST from prepare-sources.sh)
# One file belongs to exactly one patch; a modified file in no group is an error.
set -euo pipefail
DEST="${1:?usage: regen-overlay.sh DEST}"
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/overlay"

group() {
    case "$1" in
        scripts/apply_patches.py|patches/Makefile|scripts/run-feature-tests.sh) echo 10-build-plumbing ;;
        js/extra_settings_*|js/theme_picker_page.html|patches/community/add_feature_theme_picker.nim|patches/core/add_feature_custom_themes.nim|patches/core/add_feature_extra_settings.nim|scripts/tests/core/test-extra-settings-dom.mjs) echo 20-extra-settings ;;
        js/auto_archive_grace_*|patches/community/add_feature_auto_archive_grace*.nim|scripts/tests/community/test-auto-archive-grace.mjs) echo 30-auto-archive ;;
        js/files_quick_open_*|patches/community/add_feature_files_quick_open_worker.nim|scripts/tests/community/test-files-quick-open-worker.mjs) echo 40-files-quick-open ;;
        js/jira_tracker_*|scripts/tests/community/test-jira-*.mjs) echo 50-jira-tracker ;;
        js/diff_views_main.js) echo 60-diff-views ;;
        js/allow_non_anthropic_models.js|patches/community/add_feature_custom_models.nim) echo 70-custom-models ;;
        js/transcript_limits_main.js|patches/community/add_feature_transcript_limits.nim) echo 71-transcript-limits ;;
        js/panel_tabs_main.js) echo 72-panel-tabs ;;
        patches/core/add_growthbook_overrides.nim) echo 73-growthbook-overrides ;;
        patches/core/fix_profile_window_title.nim) echo 74-profile-window-title ;;
        *) return 1 ;;
    esac
}

declare -A files
while IFS= read -r f; do
    g=$(group "$f") || { echo "[regen-overlay] $f is in no group; add it to group()" >&2; exit 1; }
    files[$g]+="$f"$'\n'
done < <(git -C "$DEST" diff --name-only)

rm -rf "$OUT"; mkdir -p "$OUT"
for g in "${!files[@]}"; do
    mapfile -t paths <<<"${files[$g]%$'\n'}"
    git -C "$DEST" diff --binary -- "${paths[@]}" > "$OUT/$g.patch"
done
ls "$OUT"
