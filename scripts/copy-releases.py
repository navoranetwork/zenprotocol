#!/usr/bin/env python3
"""Copy every GitHub release (tag, name, notes, assets) from one repository to another.

Used once to move the releases (snapshot-latest, upstream-mirror) to a new repository.
The tags must already exist in the target (push them first). Safe to run again: releases
and assets already in the target are skipped, so an interrupted copy resumes where it stopped.
Assets are streamed one at a time through a temporary file, so the disk only needs room
for the largest single asset.

  read -rs GH_TOKEN; export GH_TOKEN      # token with write access to the target repository
  python3 scripts/copy-releases.py OLD_OWNER/REPO NEW_OWNER/REPO
"""
import json, os, sys, tempfile, urllib.parse, urllib.request

API = "https://api.github.com"
TOKEN = os.environ.get("GH_TOKEN") or sys.exit("set GH_TOKEN (read -rs GH_TOKEN; export GH_TOKEN)")
HDR = {"Authorization": f"Bearer {TOKEN}", "Accept": "application/vnd.github+json",
       "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "copy-releases"}


def call(method, url, data=None, headers=None, ok=(200, 201)):
    body = json.dumps(data).encode() if isinstance(data, dict) else data
    req = urllib.request.Request(url, data=body, method=method, headers={**HDR, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        if e.code in ok:
            return None
        if e.code == 404 and method == "GET":
            return None
        sys.exit(f"{method} {url}: HTTP {e.code} {e.read()[:300]!r}")


def releases(repo):
    page, out = 1, []
    while True:
        batch = call("GET", f"{API}/repos/{repo}/releases?per_page=100&page={page}") or []
        out += batch
        if len(batch) < 100:
            return out
        page += 1


def assets(repo, rid):
    page, out = 1, []
    while True:
        batch = call("GET", f"{API}/repos/{repo}/releases/{rid}/assets?per_page=100&page={page}") or []
        out += batch
        if len(batch) < 100:
            return out
        page += 1


def download(asset, path):
    req = urllib.request.Request(asset["url"], headers={**HDR, "Accept": "application/octet-stream"})
    with urllib.request.urlopen(req, timeout=600) as r, open(path, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)


def upload(repo, rid, name, path):
    size = os.path.getsize(path)
    url = f"https://uploads.github.com/repos/{repo}/releases/{rid}/assets?name={urllib.parse.quote(name)}"
    with open(path, "rb") as f:
        req = urllib.request.Request(url, data=f, method="POST", headers={
            **HDR, "Content-Type": "application/octet-stream", "Content-Length": str(size)})
        with urllib.request.urlopen(req, timeout=3600) as r:
            r.read()


def main(src, dst):
    for rel in reversed(releases(src)):
        tag = rel["tag_name"]
        new = call("GET", f"{API}/repos/{dst}/releases/tags/{urllib.parse.quote(tag)}")
        if not new:
            new = call("POST", f"{API}/repos/{dst}/releases", {
                "tag_name": tag, "name": rel["name"] or tag, "body": rel["body"] or "",
                "prerelease": rel["prerelease"], "draft": False, "make_latest": "false"})
            print(f"release {tag}: created")
        have = {a["name"] for a in assets(dst, new["id"])}
        todo = [a for a in assets(src, rel["id"]) if a["name"] not in have]
        print(f"release {tag}: {len(have)} assets present, {len(todo)} to copy")
        for i, a in enumerate(todo, 1):
            with tempfile.TemporaryDirectory() as d:
                p = os.path.join(d, "asset")
                download(a, p)
                upload(dst, new["id"], a["name"], p)
            print(f"  [{i}/{len(todo)}] {a['name']} ({a['size'] // 1048576} MB)", flush=True)
    print("done")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
