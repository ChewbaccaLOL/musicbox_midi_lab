"""Copy the static app and give local scripts/styles content-based cache versions."""
import argparse
import hashlib
from pathlib import Path
import re
import shutil


def prepare_site(source: Path, output: Path) -> None:
    source, output = source.resolve(), output.resolve()
    if source == output or source in output.parents:
        raise ValueError("Output must be outside the source directory")
    shutil.copytree(source, output, dirs_exist_ok=True)
    index = output / "index.html"

    def version(match):
        prefix, name, _, quote = match.groups()
        asset = (output / name).resolve()
        if output not in asset.parents or not asset.is_file():
            return match.group(0)
        digest = hashlib.sha256(asset.read_bytes()).hexdigest()[:16]
        return f"{prefix}{name}?v={digest}{quote}"

    html = re.sub(r'''((?:src|href)=["'])([^"'?]+\.(?:js|css))(\?[^"']*)?(["'])''',
                  version, index.read_text(encoding="utf-8"))
    index.write_text(html, encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    prepare_site(args.source, args.output)
