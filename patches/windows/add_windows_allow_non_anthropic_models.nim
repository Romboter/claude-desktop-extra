# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Windows build only (patches/windows/ is applied by
# scripts/windows/build-windows.sh, never by the Linux packages).
#
# Index half of add_feature_allow_non_anthropic_models.nim for Windows bundles
# since 7.37095.0, which keep the 3P model-name checks in their own file,
# managedConfigSchemas.js. That file's guards (B validator, D tier-pin) are
# added by add_windows_allow_non_anthropic_models_schemas.nim; this patch keeps
# A (js/allow_non_anthropic_models.js injected at the head: the pref reader, the
# global `__cdbAllowNonAnthropicModels()` and the IPC handlers) and E (the
# setup window's `--desktop-features` signal for the ion-dist half,
# add_feature_allow_non_anthropic_models_ion.nim), and asserts that the gateway
# /v1/models discovery filter still goes through the provider validator.
# The shared patch is not in WINDOWS_PATCH_SET while this layout lasts.

import std/[os, strformat, strutils]
import regex

const MODULE_JS = staticRead("../../js/allow_non_anthropic_models.js")

const MARKER = "__CDB_ALLOW_NONANTHROPIC__"
const GUARD =
  "(globalThis.__cdbAllowNonAnthropicModels&&globalThis.__cdbAllowNonAnthropicModels())"
const MARK_B = "/*cdb-mb:validator*/"
const MARK_D = "/*cdb-mb:tier-pin*/"
const MARK_E = "/*cdb-mb:setup-window*/"
const ION_FLAG = "cdbAllowNonAnthropicModels:{status:\"supported\"}"
const EXPECTED_PATCHES = 2 # A module, E setup-window signal
const GUARD_SITES = 1 # E (B and D live in managedConfigSchemas.js since Windows 7.37095.0, see add_windows_allow_non_anthropic_models_schemas.nim)

proc endState(s: string): array[2, int] =
  [
    s.count(MARKER),
    s.count(MARK_E & "(" & GUARD & "?{..."),
  ]

proc apply*(input: string): string =
  result = input

  # Idempotency: positive end-state assertion - our module and the setup-window
  # guard must be present exactly once, and the guard text nowhere else (Rule 6).
  let have = endState(result)
  let guardTotal = result.count(GUARD)
  if have == [1, 1] and guardTotal == GUARD_SITES and result.count(ION_FLAG) == 1:
    echo "  [OK] allow-non-anthropic-models: module and setup-window guard already present (idempotent)"
    return
  if have != [0, 0] or guardTotal != 0 or result.count(ION_FLAG) != 0:
    echo &"  [FAIL] allow-non-anthropic-models: half-patched bundle (module x{have[0]}, setup-window x{have[1]}, guard text x{guardTotal}) - re-audit"
    quit(1)

  # Gateway /v1/models discovery must still filter through the provider
  # validator (which add_windows_allow_non_anthropic_models_schemas.nim guards).
  let discoveryRe =
    re2"""\.filter\(\(+[\w$]+=>([\w$]+)\([\w$]+,[\w$]+\.id\)\.ok\|\|[\w$]+\.anthropicFamilyTier\)"""
  let discoveryCount = result.findAll(discoveryRe).len
  if discoveryCount != 1:
    echo &"  [FAIL] allow-non-anthropic-models: gateway discovery filter matched {discoveryCount}/1 - re-audit"
    quit(1)

  # E. setup-window signal for the ion-dist half
  # (add_feature_allow_non_anthropic_models_ion.nim). The Setup window
  # (Developer -> Configure Third-Party Inference) validates its Model list in
  # the renderer with the SPA's own copy of the gateway check. Upstream hands
  # the window `--desktop-features=<JSON>` via additionalArguments; its preload
  # (mainView.js) exposes that JSON as `window.desktopBootFeatures` before any
  # page script runs. With the switch on, add our key to that JSON for this
  # window only; off -> the stock `JSON.stringify(DH())` value. Pinned by the
  # window's title string.
  var n = 0
  result = result.replace(
    re2"""(defaultMessage:["`]Configure Third-Party Inference\\u2026["`],id:["`][^"`]{1,40}["`][}]\),webPreferences:[{]preload:[^{}]{0,100}?mainView\.js["`]\),additionalArguments:\[`--desktop-features=\$[{]JSON\.stringify\()([\w$]+\(\))(\)[}]`\][}])""",
    proc(m: RegexMatch2, s: string): string =
      inc n
      let feats = s[m.group(1)]
      s[m.group(0)] & MARK_E & "(" & GUARD & "?{..." & feats & "," & ION_FLAG & "}:" &
        feats & ")" & s[m.group(2)],
  )
  if n != 1:
    echo &"  [FAIL] allow-non-anthropic-models: E setup-window --desktop-features matched {n}/1 - re-audit"
    quit(1)
  echo "  [OK] E setup-window --desktop-features: switch signal added"

  # A. inject at the head, after a leading "use strict"; when one is present
  # (directive prologues only work in first-statement position), else prepend.
  # Basename order puts this patch before add_growthbook_overrides, so on a
  # pristine stage the directive is usually still there; when an earlier patch
  # has already displaced it, the prepend is the normal case, not an error.
  # Same shape as add_feature_theme_picker.
  let strictPrefix = "\"use strict\";"
  if result.startsWith(strictPrefix):
    result = strictPrefix & MODULE_JS & "\n;\n" & result[strictPrefix.len .. ^1]
    echo "  [OK] A allow-non-anthropic-models module injected after \"use strict\""
  else:
    result = MODULE_JS & "\n;\n" & result
    echo "  [OK] A allow-non-anthropic-models module prepended"

  let after = endState(result)
  var applied = 0
  for c in after:
    if c == 1:
      inc applied
  if applied < EXPECTED_PATCHES or result.count(GUARD) != GUARD_SITES or
      result.count(ION_FLAG) != 1:
    echo &"  [FAIL] Only {applied}/{EXPECTED_PATCHES} allow-non-anthropic-models parts present exactly once after patching (guard text x{result.count(GUARD)}, want {GUARD_SITES})"
    quit(1)

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_windows_allow_non_anthropic_models <path_to_index.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_windows_allow_non_anthropic_models ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo &"  [PASS] allow non-Anthropic models applied ({EXPECTED_PATCHES}/{EXPECTED_PATCHES} parts)"
  else:
    if endState(output) != [1, 1]:
      echo "  [FAIL] No changes made and the patched end-state is absent"
      quit(1)
    echo "  [OK] Already applied (no changes needed)"
