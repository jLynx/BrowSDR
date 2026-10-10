"""Import the pinned Skyshark label catalogue without executing third-party code."""

import argparse
import ast
import hashlib
import json
import re
from pathlib import Path
from urllib.request import urlopen

REVISION = "3d66e7d27ce5b9616643faa8a3b29ca9801b9007"
SOURCE_URL = f"https://raw.githubusercontent.com/ckuethe/skyshark/{REVISION}/expn.py"


def build(raw, output):
    tree = ast.parse(raw.decode("utf-8"))
    assignment = next(
        node for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(target, ast.Name) and target.id == "arinc620" for target in node.targets)
    )
    entries = ast.literal_eval(assignment.value)
    if not isinstance(entries, dict):
        raise ValueError("Label catalogue must be a dictionary")
    # Skyshark also lists the one-character D application sublabel; it is not an ACARS label.
    entries = {code: meanings for code, meanings in entries.items() if len(code) == 2}
    for code, meanings in entries.items():
        if not re.fullmatch(r"[ -~]{2}", code) or not isinstance(meanings, list):
            raise ValueError(f"Invalid label: {code}")
        if not meanings or any(not isinstance(item, str) or not item for item in meanings):
            raise ValueError(f"Invalid meanings for label: {code}")
    output.mkdir(parents=True, exist_ok=True)
    (output / "labels.json").write_text(json.dumps(entries, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    metadata = {"source": "Skyshark", "url": SOURCE_URL, "revision": REVISION,
                "license": "MIT", "sourceSha256": hashlib.sha256(raw).hexdigest(), "labelCount": len(entries)}
    (output / "labels-source.json").write_text(json.dumps(metadata, indent="\t") + "\n", encoding="utf-8", newline="\n")
    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path, default=Path("src/client/app/decoders/acars/reference"))
    args = parser.parse_args()
    if args.input:
        raw_data = args.input.read_bytes()
    else:
        with urlopen(SOURCE_URL, timeout=60) as response:
            raw_data = response.read()
    print(json.dumps(build(raw_data, args.output)))
