# @patch-target: app.asar.contents/.vite/build/index.js
# @patch-type: nim
#
# Opt-in (default OFF): cache warmer. Sends one tiny turn to an idle Code session shortly before
# its prompt cache would lapse, under two user-set caps. Switch and caps: Settings -> Extra ->
# Community Features (key cacheWarm = {enabled, hours, rewrites}), read live through
# globalThis.__cdbCacheWarmConfig() from js/extra_settings_main.js; absent or off = inert.
#
# Two sub-patches, each anchor must match exactly once:
#   A  the session-manager register function (found through its export key
#      `_registerClaudeCodeSessionManager:()=>NAME`): after `VAR=E;` builds the policy helper
#      js/cache_warm.js around the manager and stores it in globalThis.__cdbCacheWarm.
#   B  the cycle-close helper (`function NAME(S,{health:H,...usage:U,...turnCompleted:T=!1,...}){`):
#      at the start of the body, a healthy completed turn with a pending cycle reports (session id, usage, the cycle's
#      userMessageUuid) to the helper, inside try/catch so nothing it throws reaches upstream.
# Idempotency asserts the exact injected end states, rebuilt from the identifiers they were
# written with.
import std/[os, strutils]
import regex

const helper = staticRead("../../js/cache_warm.js")

const pokeText = "(cache keep-alive: reply with the single word ok)"
proc diag(name: string): string =
  "globalThis.__cdbDiag?.(\"[cache-warm] \"+String(" & name & "))"

proc installFor(manager: string): string =
  "try{globalThis.__cdbCacheWarm?.stopAll();globalThis.__cdbCacheWarm=(" & helper &
    ")({now:Date.now,setTimer:(f,ms)=>{const t=setTimeout(f,ms);t.unref?.();return t}," &
    "clearTimer:t=>clearTimeout(t),config:()=>globalThis.__cdbCacheWarmConfig?.()??{enabled:false}," &
    "newUuid:()=>require(\"node:crypto\").randomUUID(),log:l=>globalThis.__cdbDiag?.(l)," &
    "sendPoke:async(i,u)=>{const v=await " & manager &
    ".getSession(i);if(!v||v.isArchived)return{delivered:false,reason:\"gone\"};" &
    "if(v.isRunning||v.turnRunning)return{delivered:false,reason:\"busy\"};return await " & manager &
    ".sendMessage(i,\"" & pokeText &
    "\",void 0,{origin:{kind:\"auto-continuation\"},initiator:\"cache-warm\",messageUuid:u})}});" &
    "{let n=0;const w=()=>globalThis.__cdbDiag?globalThis.__cdbDiag(\"[cache-warm] installed\"):n++<60&&setTimeout(w,500);w()}" &
    "}catch(__cdbCwE1){" &
    diag("__cdbCwE1") & "}"

proc hookFor(session, health, usage, completed: string): string =
  "if(" & completed & "&&" & health & "===\"healthy\"&&" & session & ".pendingCycle)try{globalThis.__cdbCacheWarm?.turnEnded(" &
    session & ".sessionId," & usage & "," & session & ".pendingCycle?.userMessageUuid)}catch(__cdbCwE2){" &
    diag("__cdbCwE2") & "}"

proc escaped(name: string): string =
  name.replace("$", "\\$")

let exportRe = re2"_registerClaudeCodeSessionManager:\(\)=>([\w$]+)"
const cycleHeader =
  """function ([\w$]+)\(([\w$]+),\{health:([\w$]+),(?:[\w$]+:[\w$]+,){0,12}usage:([\w$]+),[^}]*?turnCompleted:([\w$]+)=!1,[^}]*\}\)\{"""

proc fail(message: string) =
  raise newException(ValueError, "cache-warm: " & message & "; re-audit")

# A: returns the patched text and whether the exact end state was already there.
proc registerSite(s: string, present: var bool): string =
  let exports = s.findAll(exportRe)
  if exports.len != 1:
    fail("register export count " & $exports.len & ", expected 1")
  let name = escaped(s[exports[0].group(0)])
  let sites = s.findAll(re2("function " & name & """\(([\w$]+)\)\{([\w$]+)=([\w$]+);"""))
  if sites.len != 1:
    fail("register function count " & $sites.len & ", expected 1")
  let m = sites[0]
  let manager = s[m.group(0)]
  if s[m.group(2)] != manager:
    fail("register function no longer stores its argument")
  let whole = s[m.boundaries]
  if s.find(whole & "try{globalThis.__cdbCacheWarm?.stopAll()") == m.boundaries.a:
    if s.count(whole & installFor(manager)) != 1:
      fail("install differs from this build")
    present = true
    return s
  s[0 ..< m.boundaries.b + 1] & installFor(manager) & s[m.boundaries.b + 1 .. ^1]

# B
proc cycleSite(s: string, present: var bool): string =
  let sites = s.findAll(re2(cycleHeader))
  if sites.len != 1:
    fail("cycle-close header count " & $sites.len & ", expected 1")
  let m = sites[0]
  let whole = s[m.boundaries]
  let hook = hookFor(s[m.group(1)], s[m.group(2)], s[m.group(3)], s[m.group(4)])
  if s.find(whole & "if(") == m.boundaries.a and s.count(whole & hook) == 1:
    present = true
    return s
  if "__cdbCacheWarm?.turnEnded(" in s:
    fail("hook present but differs from this build")
  s[0 ..< m.boundaries.b + 1] & hook & s[m.boundaries.b + 1 .. ^1]

proc apply*(input: string): string =
  const EXPECTED_PATCHES = 2 # A, B
  var patchesApplied = 0
  var aPresent, bPresent = false
  result = registerSite(input, aPresent)
  inc patchesApplied
  result = cycleSite(result, bPresent)
  inc patchesApplied
  if patchesApplied != EXPECTED_PATCHES:
    echo "  [FAIL] Only " & $patchesApplied & "/" & $EXPECTED_PATCHES & " patches applied"
    quit(1)
  if aPresent and bPresent:
    echo "  [OK] cache-warm install and turn hook already present"
  else:
    echo "  [OK] cache-warm install and turn hook applied"

when isMainModule:
  if paramCount() != 1:
    quit("Usage: add_cache_warm <bundle.js>", 1)
  let file = paramStr(1)
  writeFile(file, apply(readFile(file)))
