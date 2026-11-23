# @patch-target: app.asar.contents/.vite/build/index.pre.js
# @patch-type: nim
#
# Windows build only (patches/windows/ is applied by
# scripts/windows/build-windows.sh, never by the Linux packages).
#
# Files tab activity: append js/files_activity_main.js to index.pre.js
# (package.json's `main`), with js/files_activity_page.js and
# js/files_activity.css embedded as escaped strings. The module runs the page
# script in the Code tab (claude.ai, or app://localhost in 3P) when the switch
# filesActivity is on (Settings -> Extra -> Community); see its header.
#
# Appended, not prefixed: add_windows_profiles.nim keeps the first code of the
# file, and this module only registers an app "web-contents-created" handler.
#
# Break risk: LOW - no upstream anchor; the module is appended to the file.
# Idempotency: a rerun requires the exact current injection to be present once.

import std/[os, strutils]

const MAIN_JS = staticRead("../../js/files_activity_main.js")
const PAGE_JS = staticRead("../../js/files_activity_page.js")
const PAGE_CSS = staticRead("../../js/files_activity.css")
const MARKER = "/*__CDB_FILES_ACTIVITY__*/"
const PLACEHOLDER_PAGE = "\"__CDB_FILES_ACTIVITY_PAGE_SRC__\""
const PLACEHOLDER_CSS = "\"__CDB_FILES_ACTIVITY_CSS__\""

const EXPECTED_PATCHES = 1 # A (injection)

proc escapeJs(s: string): string =
  result = s
  result = result.replace("\\", "\\\\")
  result = result.replace("\"", "\\\"")
  result = result.replace("\n", "\\n")
  result = result.replace("\r", "")

proc injection(): string =
  if MAIN_JS.count(PLACEHOLDER_PAGE) != 1 or MAIN_JS.count(PLACEHOLDER_CSS) != 1 or
      MAIN_JS.count(MARKER) != 1:
    raise newException(ValueError, "main module lost a placeholder or its marker")
  for c in PAGE_JS:
    if ord(c) > 127:
      raise newException(ValueError, "page module must be ASCII")
  for c in PAGE_CSS:
    if ord(c) > 127:
      raise newException(ValueError, "stylesheet must be ASCII")
  result = MAIN_JS
  result = result.replace(PLACEHOLDER_PAGE, "\"" & escapeJs(PAGE_JS) & "\"")
  result = result.replace(PLACEHOLDER_CSS, "\"" & escapeJs(PAGE_CSS) & "\"")

proc apply*(input: string): string =
  var patchesApplied = 0
  let code = injection()
  # A. Injection. Idempotency: our exact, current injection present once.
  if MARKER in input:
    if input.count(MARKER) != 1 or input.count(code) != 1:
      raise newException(ValueError, "injection stale or duplicated")
    echo "  [OK] Files tab activity: injection already present (idempotent)"
    return input
  result = input & "\n" & code
  if result.count(MARKER) == 1 and result.count(code) == 1:
    inc patchesApplied
  if patchesApplied < EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES &
      " patches applied"
    quit(1)
  echo "  [OK] Files tab activity: main module appended (1/1)"

when isMainModule:
  if paramCount() != 1:
    echo "Usage: add_files_activity <path_to_index.pre.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_files_activity ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
    echo "  [PASS] Files tab activity installed"
  else:
    echo "  [OK] Already applied (no changes needed)"
