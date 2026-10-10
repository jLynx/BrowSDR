"""Build the offline ICAO/IATA name index from public-domain OurAirports data."""

import argparse
import csv
import hashlib
import io
import json
import re
from pathlib import Path
from urllib.request import urlopen

SOURCE_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"


def airport_rows(contents):
    rows = csv.DictReader(io.StringIO(contents))
    required = {"id", "name", "icao_code", "iata_code"}
    if not required.issubset(rows.fieldnames or []):
        raise ValueError("OurAirports CSV is missing required columns")
    entries = []
    seen = {}
    for row in rows:
        name = row["name"].strip()
        codes = [row["icao_code"].strip(), row["iata_code"].strip()]
        if not any(codes):
            continue
        if not name:
            raise ValueError("Coded airport has no name")
        for code, pattern in zip(codes, (r"[A-Z]{4}", r"[A-Z]{3}")):
            if code and not re.fullmatch(pattern, code):
                raise ValueError(f"Invalid airport code: {code}")
            if code and code in seen:
                raise ValueError(f"Ambiguous airport code: {code}")
            if code:
                seen[code] = row["id"]
        entries.append([name, *codes])
    return sorted(entries, key=lambda entry: (entry[1], entry[2], entry[0]))


def build(raw, output):
    entries = airport_rows(raw.decode("utf-8-sig"))
    output.mkdir(parents=True, exist_ok=True)
    data = json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n"
    (output / "airports.json").write_text(data, encoding="utf-8", newline="\n")
    metadata = {
        "source": "OurAirports",
        "url": SOURCE_URL,
        "license": "Public domain",
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "airportCount": len(entries),
        "icaoCount": sum(bool(row[1]) for row in entries),
        "iataCount": sum(bool(row[2]) for row in entries),
    }
    (output / "metadata.json").write_text(json.dumps(metadata, indent="\t") + "\n", encoding="utf-8", newline="\n")
    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="Saved OurAirports CSV (otherwise download official data)")
    parser.add_argument("--output", type=Path, default=Path("src/client/data/aviation"))
    args = parser.parse_args()
    if args.input:
        raw_data = args.input.read_bytes()
    else:
        with urlopen(SOURCE_URL, timeout=60) as response:
            raw_data = response.read()
    print(json.dumps(build(raw_data, args.output)))
