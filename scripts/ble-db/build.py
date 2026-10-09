"""Bundle a pinned PortaPack Mayhem MAC vendor database and integrity manifest."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.request

DEFAULT_COMMIT = "6ea6de6582e0c1cb43aa3d73194505d75bf11f85"


def validate(data):
    count, remainder = divmod(len(data), 71)
    if remainder or not 30000 <= count <= 100000:
        raise ValueError("Invalid MAC database size")
    previous = b""
    for i in range(count):
        key = data[i * 7 : (i + 1) * 7]
        vendor = data[count * 7 + i * 64 : count * 7 + (i + 1) * 64]
        if (not re.fullmatch(rb"[0-9A-F]{6}\x00", key) or key < previous
                or not re.fullmatch(rb"[\x20-\x7e]{1,63}\x00+", vendor)):
            raise ValueError("Invalid MAC database record")
        previous = key
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", default=DEFAULT_COMMIT)
    parser.add_argument("--output", type=Path, default=Path("public/ble-db"))
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{40}", args.commit):
        parser.error("--commit must be a full Git commit SHA")
    source = ("https://raw.githubusercontent.com/portapack-mayhem/mayhem-firmware/"
              f"{args.commit}/sdcard/MACADDRESS/macaddress.db")
    with urllib.request.urlopen(source, timeout=30) as response:
        data = response.read(7100001)
    count = validate(data)
    digest = hashlib.sha256(data).hexdigest()
    manifest = {"schema": 1, "revision": digest[:24], "bytes": len(data),
                "count": count, "sha256": digest, "source": source,
                "upstreamCommit": args.commit,
                "allocationSource": "https://standards-oui.ieee.org/oui/oui.txt"}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "macaddress.db").write_bytes(data)
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, indent="\t") + "\n", encoding="utf-8", newline="\n")
    print(f"Bundled {count:,} vendors ({len(data):,} bytes), revision {digest[:24]}")


if __name__ == "__main__":
    main()
