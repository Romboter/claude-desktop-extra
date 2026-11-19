#!/usr/bin/env python3
"""Apply this repo's patches to a Claude Desktop bundle and say which ones fit.

Works on Windows, Linux and macOS (needs python3, git, node/npx, nim and make). Nothing is packaged or published: it is the quick
"does the new Anthropic release still match our patches?" loop.

Sources (pick one):
  --from windows        download Anthropic's current Windows .nupkg (default)
  --from FILE.nupkg     a downloaded Windows package
  --from FILE.deb       Anthropic's Linux .deb (the Linux patch set is used)
  --from DIR            an already extracted app.asar.contents folder

The .nupkg is checked against Anthropic's RELEASES SHA1 before use. The Windows
patch set runs on the overlaid sources (prepare-sources.sh), like the build.

  python3 scripts/windows/patch-check.py [--from ...] [--arch x64|arm64]
                                         [--work DIR] [--no-compile]
"""
import argparse, hashlib, os, re, shutil, subprocess, sys, tarfile, tempfile, urllib.request, zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BASE = "https://downloads.claude.ai/releases/win32"
ASAR = ["npx", "--yes", "@electron/asar@3.4.1"]
EXE = ".exe" if os.name == "nt" else ""


def run(cmd, **kw):
    # npx is npx.cmd on Windows
    if os.name == "nt" and cmd[0] == "npx":
        cmd = ["npx.cmd"] + cmd[1:]
    return subprocess.run(cmd, **kw)


def get(url, dest):
    print(f"[patch-check] downloading {url}")
    urllib.request.urlretrieve(url, dest)


def windows_nupkg(arch, work, local=None):
    releases = urllib.request.urlopen(f"{BASE}/{arch}/RELEASES").read().decode("utf-8-sig")
    entries = re.findall(r"^([0-9A-Fa-f]{40}) (AnthropicClaude-(\S+)-full\.nupkg) (\d+)", releases, re.M)
    if not entries:
        sys.exit("no full package in RELEASES")
    if local:
        name = Path(local).name
        match = [e for e in entries if e[1] == name]
        if not match:
            sys.exit(f"{name} is not the current release listed in RELEASES; cannot verify its SHA1")
        path = Path(local)
    else:
        match = [sorted(entries, key=lambda e: [int(x) for x in re.findall(r"\d+", e[2])])[-1]]
        path = work / match[0][1]
        get(f"{BASE}/{arch}/{match[0][1]}", path)
    sha1, _, version, size = match[0]
    if hashlib.sha1(path.read_bytes()).hexdigest() != sha1.lower():
        sys.exit("SHA1 mismatch against RELEASES")
    print(f"[patch-check] Windows {version} ({arch}): SHA1 verified")
    return path


def extract_nupkg(nupkg, work):
    out = work / "nupkg"
    with zipfile.ZipFile(nupkg) as z:
        for n in z.namelist():
            if n.startswith("lib/net45/resources/") and n.endswith((".asar", ".asar.unpacked")) or \
               n.startswith("lib/net45/resources/app.asar.unpacked/"):
                z.extract(n, out)
    res = out / "lib/net45/resources"
    return res / "app.asar", res / "ion-dist.asar"


def extract_deb(deb, work):
    data = Path(deb).read_bytes()
    assert data[:8] == b"!<arch>\n", "not a .deb"
    pos = 8
    while pos < len(data):
        name = data[pos:pos + 16].decode().strip()
        size = int(data[pos + 48:pos + 58])
        body = pos + 60
        if name.startswith("data.tar"):
            tar = work / name
            tar.write_bytes(data[body:body + size])
            with tarfile.open(tar) as t:
                members = [m for m in t.getmembers() if m.name.endswith(("resources/app.asar", "resources/ion-dist.asar"))]
                t.extractall(work / "deb", members=members, filter="data")
            found = {Path(m.name).name: work / "deb" / m.name for m in members}
            return found["app.asar"], found.get("ion-dist.asar")
        pos = body + size + (size & 1)
    sys.exit("no data.tar in the .deb")


def prepare_sources(dest):
    """What prepare-sources.sh does, without bash: tracked files + the overlay."""
    dest.mkdir(parents=True)
    files = subprocess.run(["git", "-C", str(REPO), "ls-files", "-z"], capture_output=True, check=True).stdout.split(b"\x00")
    for f in filter(None, files):
        rel = f.decode()
        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / rel, dest / rel)
    git = ["git", "-C", str(dest), "-c", "user.name=o", "-c", "user.email=o@l"]
    for cmd in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "pristine"], ["apply", str(REPO / "scripts/windows/upstream-overlay.patch")]):
        subprocess.run(git + cmd, check=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from", dest="source", default="windows")
    ap.add_argument("--arch", default="x64", choices=["x64", "arm64"])
    ap.add_argument("--work", help="work folder (kept); default is a temp folder that is removed")
    ap.add_argument("--no-compile", action="store_true", help="patches are already compiled")
    a = ap.parse_args()

    work = Path(a.work or tempfile.mkdtemp(prefix="cdb-patch-check."))
    work.mkdir(parents=True, exist_ok=True)
    try:
        windows = a.source == "windows" or a.source.endswith(".nupkg")
        app, ion = work / "app", None
        app.mkdir(exist_ok=True)
        if a.source == "windows" or a.source.endswith(".nupkg"):
            nupkg = windows_nupkg(a.arch, work, a.source if a.source.endswith(".nupkg") else None)
            asar, ion_asar = extract_nupkg(nupkg, work)
        elif a.source.endswith(".deb"):
            asar, ion_asar = extract_deb(a.source, work)
        elif Path(a.source).is_dir():
            asar, ion_asar = None, None
            shutil.copytree(a.source, app / "app.asar.contents", dirs_exist_ok=True)
        else:
            sys.exit(f"unknown --from {a.source}")
        if asar:
            run(ASAR + ["extract", str(asar), str(app / "app.asar.contents")], check=True)
        if ion_asar and Path(ion_asar).exists():
            ion = work / "ion-dist"
            run(ASAR + ["extract", str(ion_asar), str(ion)], check=True)

        # The sources the build uses: this repo plus the Windows overlay.
        src = work / "src"
        if not src.exists():
            prepare_sources(src)
        patches = src / "patches"
        if not a.no_compile:
            run(["make", "-C", str(patches), f"-j{os.cpu_count() or 2}"], check=True, stdout=subprocess.DEVNULL)
        if EXE:  # apply_patches.py looks for the binary without an extension
            for f in patches.glob("*/*.exe"):
                shutil.copy(f, f.with_suffix(""))

        cmd = [sys.executable, "-I", str(src / "scripts/apply_patches.py")] + (["--windows"] if windows else []) + [str(patches), str(app)]
        r = run(cmd, capture_output=True, text=True)
        out = r.stdout + r.stderr
        lines = [l for l in out.splitlines() if re.search(r"^=== Patch|FAIL|\[ERROR\]|Error:", l)]
        failed, cur = [], None
        for l in out.splitlines():
            m = re.match(r"=== Patch: (\S+)", l)
            if m:
                cur = m.group(1)
            elif "[FAIL]" in l and "exited with code" in l:
                failed.append(cur)
        print("\n".join(l for l in lines if "FAIL" in l or "ERROR" in l or "Error:" in l))
        print(f"[patch-check] {'ALL PATCHES APPLIED' if r.returncode == 0 else 'FAILED: ' + ', '.join(dict.fromkeys(failed)) or 'see output'}")
        if ion and windows:
            for p in ("community/add_feature_allow_non_anthropic_models_ion", "community/add_feature_auto_archive_grace_ion"):
                rr = run([str(patches / (p + EXE)), str(ion)], capture_output=True, text=True)
                print(f"[patch-check] ion {Path(p).name}: {'ok' if rr.returncode == 0 else 'FAILED ' + (rr.stdout + rr.stderr).strip()[:200]}")
                r.returncode |= rr.returncode
        sys.exit(r.returncode)
    finally:
        if not a.work:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
