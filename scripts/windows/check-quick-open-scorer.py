#!/usr/bin/env python3
"""Precondition of add_feature_files_quick_open_worker for Windows bundles.

Since Windows 7.37095.0 the file-index worker's scorer lives in a sibling
chunk (file-index-worker/sdk-<hash>.js), which the patch cannot see. The
helper scans the whole match set with an unbounded limit, which is only
complete while, exactly once each in that chunk:
  (1) the index wrapper hands a non-empty query and the limit straight to the
      table: search(e,t){return t<=0?[]:e.length===0?...:this.table.search(e,t)}
  (2) the table's top-N keeps pushing until it holds `limit` entries:
      (,)s.length<t)s.push({pathIndex:
Usage: check-quick-open-scorer.py <app.asar.contents>
"""
import re, sys
from pathlib import Path

d = Path(sys.argv[1]) / ".vite/build/file-index-worker"
wrap = re.compile(r"search\(([\w$]+),([\w$]+)\)\{return ([\w$]+)<=0\?\[\]:([\w$]+)\.length===0\?[^;]*?:this\.table\.search\(([\w$]+),([\w$]+)\)\}")
topn = re.compile(r"[(,]([\w$]+)\.length<([\w$]+)\)([\w$]+)\.push\(\{pathIndex:")
nw = nt = 0
for f in d.glob("*.js"):
    t = f.read_bytes().decode("latin1")
    for m in wrap.finditer(t):
        q, lim = m.group(1), m.group(2)
        if (m.group(3), m.group(4), m.group(5), m.group(6)) == (lim, q, q, lim):
            nw += 1
    nt += sum(1 for m in topn.finditer(t) if m.group(1) == m.group(3))
if (nw, nt) != (1, 1):
    sys.exit(f"[FAIL] quick open scorer contract moved (index wrapper {nw}/1, top-N fill {nt}/1) - re-audit")
print("[OK] quick open scorer: full-set contract holds")
