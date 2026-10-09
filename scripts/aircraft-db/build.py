"""Build versioned, browser-readable ADS-B metadata using Python's standard library."""

import argparse
import csv
import hashlib
import json
import re
import tempfile
import unicodedata
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from sources import resolve_aircraft_url

AIRLINE_URL = 'https://raw.githubusercontent.com/kx1t/planefence-airlinecodes/main/airlinecodes.txt'
AIRCRAFT_FIELDS = [9, 33, 33, 5, 33, 33]
AIRLINE_FIELDS = [32, 32]


def download(url, path):
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=180) as source, path.open('wb') as target:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            target.write(chunk)
    return digest.hexdigest()


def parse_aircraft(path):
    records = {}
    required = {'icao24', 'registration', 'manufacturername', 'model', 'typecode', 'icaoaircrafttype', 'owner', 'operator'}
    with path.open(encoding='utf-8-sig', newline='') as source:
        header = source.readline()
        source.seek(0)
        reader = csv.DictReader(source, quotechar="'" if header.lstrip().startswith("'") else '"')
        reader.fieldnames = [name.lower().replace('icaoaircraftclass', 'icaoaircrafttype') for name in (reader.fieldnames or [])]
        if not required.issubset(reader.fieldnames or []):
            raise ValueError('Aircraft CSV has an unsupported header')
        for row in reader:
            key = (row['icao24'] or '').strip().upper()
            if not re.fullmatch('[0-9A-F]{6}', key) or not row['registration']:
                continue
            category = row['icaoaircrafttype'] or ''
            record = [row['registration'], row['manufacturername'], row['model'], category if len(category) == 3 else row['typecode'], row['owner'], row['operator']]
            # Resolve duplicate addresses deterministically, preferring the most complete record.
            previous = records.get(key)
            score = lambda values: (sum(bool(value) for value in values), tuple(values))
            if previous is None or score(record) > score(previous):
                records[key] = record
    if not records:
        raise ValueError('Aircraft source produced no valid records')
    return records


def parse_airlines(path):
    records = {}
    raw = path.read_bytes()
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = raw.decode('cp1252')
    for row in csv.reader(text.splitlines(), skipinitialspace=True):
        if len(row) < 4:
            continue
        key = row[0].strip().upper()
        if not re.fullmatch('[A-Z0-9]{3}', key):
            continue
        record = [row[1].strip(), row[3].strip()]
        if key not in records or tuple(record) > tuple(records[key]):
            records[key] = record
    if not records:
        raise ValueError('Airline source produced no valid records')
    return records


def field(value, width):
    data = unicodedata.normalize('NFKD', value or '').encode('ascii', 'ignore')[:width - 1]
    return data.ljust(width, b'\0')


def database(records, key_size, field_sizes):
    keys, values = bytearray(), bytearray()
    for key, row in sorted(records.items()):
        keys.extend(field(key, key_size))
        for value, width in zip(row, field_sizes, strict=True):
            values.extend(field(value, width))
    return keys + values


def build_snapshot(aircraft_path, airline_path, output, source_hashes, source_urls=None):
    aircraft, airlines = parse_aircraft(aircraft_path), parse_airlines(airline_path)
    shards = {}
    for key, row in aircraft.items():
        shards.setdefault(key[:2], {})[key] = row
    files = {f'aircraft-{prefix}.db': (database(rows, 7, AIRCRAFT_FIELDS), len(rows)) for prefix, rows in shards.items()}
    files['airlines.db'] = (database(airlines, 4, AIRLINE_FIELDS), len(airlines))
    hashes = {name: hashlib.sha256(data).hexdigest() for name, (data, _) in files.items()}
    revision = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()[:24]
    destination = output / revision
    destination.mkdir(parents=True, exist_ok=True)
    for name, (data, _) in files.items():
        if len(data) > 25 * 1024 * 1024:
            raise ValueError(f'{name} exceeds the static asset size limit')
        (destination / name).write_bytes(data)
    manifest = {
        'schema': 1, 'revision': revision, 'builtAt': datetime.now(timezone.utc).isoformat(),
        'sources': [{'url': url, 'sha256': digest} for url, digest in zip(source_urls or [aircraft_path.resolve().as_uri(), airline_path.resolve().as_uri()], source_hashes, strict=True)],
        'files': {name: {'path': f'{revision}/{name}', 'bytes': len(data), 'count': count, 'sha256': hashes[name]} for name, (data, count) in sorted(files.items())},
    }
    # Replace the manifest only after every immutable data file is ready.
    pending = output / 'manifest.tmp'
    pending.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    pending.replace(output / 'manifest.json')
    print(f'Built {len(aircraft):,} aircraft and {len(airlines):,} airlines; revision {revision}')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--aircraft', type=Path, help='Use a local OpenSky CSV instead of downloading')
    parser.add_argument('--airlines', type=Path, help='Use a local airlinecodes.txt instead of downloading')
    args = parser.parse_args()
    aircraft_url = args.aircraft.resolve().as_uri() if args.aircraft else resolve_aircraft_url()
    airline_url = args.airlines.resolve().as_uri() if args.airlines else AIRLINE_URL
    with tempfile.TemporaryDirectory(prefix='browsdr-aircraft-') as directory:
        paths, hashes = [], []
        for local, url, name in [(args.aircraft, aircraft_url, 'aircraft.csv'), (args.airlines, airline_url, 'airlines.txt')]:
            path = local or Path(directory) / name
            digest = hashlib.sha256(path.read_bytes()).hexdigest() if local else download(url, path)
            paths.append(path)
            hashes.append(digest)
        build_snapshot(*paths, args.output, hashes, [aircraft_url, airline_url])


if __name__ == '__main__':
    main()
