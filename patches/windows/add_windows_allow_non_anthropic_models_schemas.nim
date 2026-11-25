# @patch-target: app.asar.contents/.vite/build/managedConfigSchemas.js
# @patch-type: nim
#
# Windows build only (patches/windows/ is applied by
# scripts/windows/build-windows.sh, never by the Linux packages).
#
# Since Windows 7.37095.0 upstream keeps the 3P model-name checks in their own
# file, managedConfigSchemas.js, instead of the main bundle. The shared
# add_feature_allow_non_anthropic_models.nim therefore keeps only the module (A)
# and the setup-window signal (E) there, and this patch adds its two guards,
# with the same switch (`globalThis.__cdbAllowNonAnthropicModels()`):
#   B. the gateway/mantle model validator (pinned by its reason string, and by
#      the provider switch's gateway/mantle arm calling it);
#   D. the `[custom-3p]` tier-pin check's `why:"not_anthropic"` branch.
# Each guard tests the global before calling it, so a missing module degrades
# to stock behavior.

import std/[strformat, strutils]
import regex

const GUARD =
  "(globalThis.__cdbAllowNonAnthropicModels&&globalThis.__cdbAllowNonAnthropicModels())"
const MARK_B = "/*cdb-mb:validator*/"
const MARK_D = "/*cdb-mb:tier-pin*/"

proc apply*(input: string): string =
  result = input

  let haveB = result.count(MARK_B & GUARD)
  let haveD = result.count(MARK_D & GUARD)
  if haveB == 1 and haveD == 1 and result.count(GUARD) == 2:
    echo "  [OK] allow-non-anthropic-models (schemas): both guards already present (idempotent)"
    return
  if haveB != 0 or haveD != 0 or result.count(GUARD) != 0:
    echo &"  [FAIL] allow-non-anthropic-models (schemas): half-patched file (validator x{haveB}, tier-pin x{haveD}) - re-audit"
    quit(1)

  # B precondition: the provider switch's gateway/mantle arm calls the function
  # B guards (the one carrying the gateway reason string).
  var armCallees: seq[string] = @[]
  for m in result.findAll(re2"""case["`]gateway["`]:case["`]mantle["`]:return ([\w$]+)\("""):
    armCallees.add(result[m.group(0)])
  var guardedFns: seq[string] = @[]
  for m in result.findAll(
    re2"""function ([\w$]+)\([\w$]+\)[{]return [\w$]+\([\w$]+\)\?[{]ok:!0[}]:[{]ok:!1,reason:"expected a gateway model route"""
  ):
    guardedFns.add(result[m.group(0)])
  if armCallees.len != 1 or guardedFns.len != 1 or armCallees[0] != guardedFns[0]:
    echo &"  [FAIL] allow-non-anthropic-models (schemas): validator arm calls {armCallees}, guarded function {guardedFns} - re-audit"
    quit(1)

  var n = 0
  result = result.replace(
    re2"""(function [\w$]+\([\w$]+\)[{]return )([\w$]+\([\w$]+\))(\?[{]ok:!0[}]:[{]ok:!1,reason:"expected a gateway model route)""",
    proc(m: RegexMatch2, s: string): string =
      inc n
      s[m.group(0)] & MARK_B & GUARD & "||" & s[m.group(1)] & s[m.group(2)],
  )
  if n != 1:
    echo &"  [FAIL] allow-non-anthropic-models (schemas): B gateway validator matched {n}/1 - re-audit"
    quit(1)

  n = 0
  result = result.replace(
    re2"""(if\(![\w$]+\([\w$]+\)\)return )([\w$]+\([\w$]+\)&&![\w$]+\([\w$]+\)\?[{]ok:!1,why:"not_anthropic"[}])""",
    proc(m: RegexMatch2, s: string): string =
      inc n
      s[m.group(0)] & "!" & MARK_D & GUARD & "&&" & s[m.group(1)],
  )
  if n != 1:
    echo &"  [FAIL] allow-non-anthropic-models (schemas): D tier-pin check matched {n}/1 - re-audit"
    quit(1)

  if result.count(MARK_B & GUARD) != 1 or result.count(MARK_D & GUARD) != 1 or
      result.count(GUARD) != 2:
    echo "  [FAIL] allow-non-anthropic-models (schemas): end state absent after patching"
    quit(1)
  echo "  [OK] allow-non-anthropic-models (schemas): validator and tier-pin guards added"

when isMainModule:
  import std/os
  if paramCount() != 1:
    echo "Usage: add_windows_allow_non_anthropic_models_schemas <path_to_managedConfigSchemas.js>"
    quit(1)
  let filePath = paramStr(1)
  echo "=== Patch: add_windows_allow_non_anthropic_models_schemas ==="
  echo "  Target: " & filePath
  if not fileExists(filePath):
    echo "  [FAIL] File not found: " & filePath
    quit(1)
  let input = readFile(filePath)
  let output = apply(input)
  if output != input:
    writeFile(filePath, output)
  echo "  [PASS] allow non-Anthropic models (schemas) applied"
