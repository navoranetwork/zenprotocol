#!/usr/bin/env python3
"""Mirror into the upstream-mirror release every package a node restore needs: the packages
src/Directory.Packages.props pins, and everything they depend on, so the node builds from the
mirror alone (nuget.mirror.config).

The closure follows NuGet's rules for these projects (net10.0, linux-x64, central transitive
pinning): a pinned package always resolves to its pinned version; for others, the .nuspec
dependency group nearest to net10.0 (net/netcoreapp, then netstandard, then no framework, then
.NETFramework as AssetTargetFallback) at the lowest version of each range; and, for packages in
the graph, the linux-x64 implementations named in runtime.json files (RIDs linux-x64, linux,
unix-x64, unix, any, base). Packages already in the release are read from it, not downloaded
from nuget.org. Safe to run again.

  python3 scripts/mirror_nuget.py                 # needs gh logged in with write access
  python3 scripts/mirror_nuget.py --dry-run --local packages-mirror   # offline: what is missing
"""
import argparse, io, json, os, re, subprocess, sys, tempfile, urllib.request, zipfile
import xml.etree.ElementTree as ET

REPO, TAG = "navoranetwork/zenprotocol", "upstream-mirror"
BASE = f"https://github.com/{REPO}/releases/download/{TAG}"
RIDS = ["linux-x64", "linux", "unix-x64", "unix", "any", "base"]


def norm(v):
    """nuget.org's normalized version: at least 3 parts, a 4th only if not 0."""
    pre = ""
    if "-" in v:
        v, pre = v.split("-", 1); pre = "-" + pre
    parts = [int(x) for x in v.split(".")]
    out = ".".join(str(x) for x in (parts + [0, 0, 0])[:3])
    if len(parts) > 3 and parts[3] != 0:
        out += "." + str(parts[3])
    return out + pre


def low(rng):
    """Lowest version allowed by a NuGet range ("4.3.0", "[4.3.0, )", "[1.0]")."""
    lo = re.sub(r"[\[\]\(\)\s]", "", rng or "").split(",")[0]
    return norm(lo) if lo else None


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()


def tf_rank(tf):
    """Rank a dependency group's framework for a net10.0 project: (priority, version); lower
    priority wins, then higher version. None: not usable."""
    if not tf:
        return (2, 0)
    t = tf.lower().replace(" ", "")
    m = re.fullmatch(r"(?:\.netcoreapp|netcoreapp)(\d+)\.?(\d*)", t) or re.fullmatch(r"net(\d+)\.(\d+)", t)
    if m:
        v = float(f"{m.group(1)}.{m.group(2) or 0}")
        return (0, -v) if v <= 10 else None
    m = re.fullmatch(r"(?:\.netstandard|netstandard)(\d+)\.?(\d*)", t)
    if m:
        v = float(f"{m.group(1)}.{m.group(2) or 0}")
        return (1, -v) if v <= 2.1 else None
    m = re.fullmatch(r"(?:\.netframework|net)(\d)\.?(\d)\.?(\d?)", t) or re.fullmatch(r"net(4)(\d)(\d?)", t)
    if m:
        return (3, -float(f"{m.group(1)}.{m.group(2)}{m.group(3)}"))
    return None


def read_package(data):
    """(id, version, deps for net10.0, runtime.json map {key id: [(impl id, version)]})."""
    z = zipfile.ZipFile(io.BytesIO(data))
    spec = next(n for n in z.namelist() if n.endswith(".nuspec") and "/" not in n)
    root = ET.fromstring(z.read(spec))
    ns = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""
    md = root.find(ns + "metadata")
    dnode = md.find(ns + "dependencies")
    deps = []
    if dnode is not None:
        groups = dnode.findall(ns + "group")
        if groups:
            ranked = [(tf_rank(g.get("targetFramework")), g) for g in groups]
            ranked = [(r, g) for r, g in ranked if r is not None]
            chosen = min(ranked, key=lambda x: x[0])[1] if ranked else None
            nodes = chosen.findall(ns + "dependency") if chosen is not None else []
        else:
            nodes = dnode.findall(ns + "dependency")
        for d in nodes:
            if d.get("version"):
                deps.append((d.get("id"), low(d.get("version"))))
    rmap = {}
    if "runtime.json" in z.namelist():
        text = z.read("runtime.json").decode("utf-8-sig")
        text = re.sub(r",(\s*[}\]])", r"\1", text)        # NuGet tolerates trailing commas; json does not
        rt = json.loads(text).get("runtimes", {})
        for rid in RIDS:
            for key, impls in (rt.get(rid) or {}).items():
                if isinstance(impls, dict):
                    rmap.setdefault(key.lower(), []).extend((i, norm(v)) for i, v in impls.items())
    return md.find(ns + "id").text, norm(md.find(ns + "version").text), deps, rmap


def pinned(props):
    s = open(props).read()
    return [(i, norm(v)) for i, v in re.findall(r'PackageVersion Include="([^"]+)" Version="\[?([^\]"]+)\]?"', s)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="only report what would be added")
    ap.add_argument("--local", help="read packages from this folder instead of the release (with --dry-run)")
    a = ap.parse_args()
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

    if a.local:
        have = {f[:-6].lower() for f in os.listdir(a.local) if f.endswith(".nupkg")}
        get_have = lambda name: open(os.path.join(a.local, name), "rb").read()
    else:
        names = json.loads(subprocess.check_output(
            ["gh", "release", "view", TAG, "--repo", REPO, "--json", "assets", "--jq", "[.assets[].name]"]))
        have = {n[len("packages__"):-6].lower() for n in names if n.startswith("packages__") and n.endswith(".nupkg")}
        assets = {n[len("packages__"):-6].lower(): n for n in names if n.startswith("packages__")}
        get_have = lambda name: fetch(f"{BASE}/{assets[name[:-6].lower()]}")

    pins = pinned("src/Directory.Packages.props")
    # packages the SDK adds by itself (net47 reference assemblies for src/ContractTool)
    pins += [("Microsoft.NETFramework.ReferenceAssemblies", "1.0.3")]
    pinned_ids = {i.lower() for i, _ in pins}
    todo = list(pins)
    seen, added, missing = set(), [], []
    ids_in_graph, runtime_maps = set(), {}
    tmp = tempfile.mkdtemp()
    while True:
        while todo:
            pid, ver = todo.pop()
            if pid.lower() in pinned_ids and (pid, ver) not in pins:
                continue                      # transitive pinning: the pinned version is used
            key = f"{pid}.{ver}".lower()
            if key in seen:
                continue
            seen.add(key)
            ids_in_graph.add(pid.lower())
            name = f"{pid}.{ver}.nupkg"
            data = None
            if key in have:
                try:
                    data = get_have(name)
                except Exception:
                    data = None
            if data is None:
                if a.local and a.dry_run:
                    missing.append(f"{pid} {ver}"); continue
                lid, lver = pid.lower(), ver.lower()
                try:
                    data = fetch(f"https://api.nuget.org/v3-flatcontainer/{lid}/{lver}/{lid}.{lver}.nupkg")
                except Exception as e:
                    print(f"NOT FOUND on nuget.org: {pid} {ver} ({e})"); missing.append(f"{pid} {ver}"); continue
                if a.dry_run:
                    print(f"would add {pid} {ver}")
                else:
                    path = os.path.join(tmp, f"packages__{name}")
                    open(path, "wb").write(data)
                    subprocess.check_call(["gh", "release", "upload", TAG, path, "--repo", REPO], stdout=subprocess.DEVNULL)
                    print(f"added {pid} {ver}")
                added.append(name)
            try:
                _, _, deps, rmap = read_package(data)
            except Exception as e:                 # report it, keep going with the rest
                print(f"CANNOT READ {pid} {ver}: {e}"); missing.append(f"{pid} {ver} (unreadable)"); continue
            for k, impls in rmap.items():
                runtime_maps.setdefault(k, []).extend(impls)
            todo += deps
        # runtime.json: implementations of packages that are in the graph
        more = [impl for k, impls in runtime_maps.items() if k in ids_in_graph for impl in impls
                if f"{impl[0]}.{impl[1]}".lower() not in seen]
        if not more:
            break
        todo += more

    print(f"closure: {len(seen)} packages; added {len(added)}; missing {len(missing)}")
    if missing:
        print("missing: " + ", ".join(sorted(missing)))
        sys.exit(1)


if __name__ == "__main__":
    main()
