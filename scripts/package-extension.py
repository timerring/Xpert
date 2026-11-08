"""Validate Xpert resources and build a reproducible Chrome Web Store ZIP."""

import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path, PurePosixPath
from posixpath import normpath
import re
import subprocess
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


class PageResources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script" and attrs.get("src"):
            self.paths.append(attrs["src"])
        if tag == "link" and attrs.get("rel") == "stylesheet":
            self.paths.append(attrs["href"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--tag")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    tracked = subprocess.check_output(
        ["git", "ls-files", "-z"], cwd=root
    ).decode().split("\0")
    docs = {"manifest.json", "README.md", "LICENSE", "PRIVACY.md",
            "docs/online-posts-investigation.md"}
    names = sorted(p for p in tracked if p in docs or p.startswith(("src/", "assets/icons/")))
    files = {name: (root / name).read_bytes() for name in names}
    manifest = json.loads(files["manifest.json"])
    version = manifest["version"]
    release_versions = json.loads((root / ".release-please-manifest.json").read_bytes())
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version):
        raise SystemExit(f"Invalid extension version: {version}")
    if version != release_versions["."] or args.tag not in (None, f"v{version}"):
        raise SystemExit("Manifest, release metadata, and tag versions must agree")
    if (manifest["manifest_version"] != 3
            or set(manifest["permissions"]) != {"alarms", "storage"}
            or set(manifest["host_permissions"]) != {"https://x.com/*", "https://twitter.com/*"}
            or manifest.get("optional_permissions") or manifest.get("optional_host_permissions")):
        raise SystemExit("Manifest permissions differ from the reviewed release")

    worker = manifest["background"]["service_worker"]
    action = manifest["action"]
    pages = [manifest["options_page"], action["default_popup"]]
    refs = [worker, *pages, *manifest["icons"].values(), *action["default_icon"].values()]
    for entry in manifest["content_scripts"]:
        refs.extend(entry.get("js", []))
        refs.extend(entry.get("css", []))
    for page in pages:
        resources = PageResources()
        resources.feed(files[page].decode())
        refs.extend(normpath(str(PurePosixPath(page).parent / path)) for path in resources.paths)
    for imports in re.findall(r"\bimportScripts\(([^)]*)\)", files[worker].decode()):
        refs.extend(str(PurePosixPath(worker).parent / path)
                    for path in re.findall(r"""['"]([^'"]+)['"]""", imports))
    missing = set(refs) - files.keys()
    if missing:
        raise SystemExit(f"Missing package resources: {', '.join(sorted(missing))}")

    args.output.mkdir(parents=True, exist_ok=True)
    package = args.output / f"xpert-v{version}-chrome-web-store.zip"
    with ZipFile(package, "w") as archive:
        for name, data in files.items():
            entry = ZipInfo(name)
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, data, compress_type=ZIP_DEFLATED, compresslevel=9)
    with ZipFile(package) as archive:
        if archive.testzip() is not None:
            raise SystemExit("ZIP integrity check failed")
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    (args.output / "SHA256SUMS").write_text(f"{digest}  {package.name}\n")
    print(f"Packaged {len(files)} files: {package}")


if __name__ == "__main__":
    main()
