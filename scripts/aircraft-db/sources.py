"""Discover complete OpenSky releases through the listing used by its datasets page."""

import re
import urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import urlencode

METADATA_BUCKET = 'https://s3.opensky-network.org/data-samples/'
SNAPSHOT_KEY = re.compile(r'metadata/aircraft-database-complete-\d{4}-(0[1-9]|1[0-2])\.csv')
NS = {'s': 'http://s3.amazonaws.com/doc/2006-03-01/'}


def resolve_aircraft_url(fetch_listing=None):
    latest, latest_size, token, seen = '', 0, None, set()
    for _ in range(10):
        query = {'list-type': '2', 'prefix': 'metadata/'}
        if token:
            query['continuation-token'] = token
        url = METADATA_BUCKET + '?' + urlencode(query)
        if fetch_listing:
            raw = fetch_listing(url)
        else:
            with urllib.request.urlopen(url, timeout=60) as response:
                raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError('OpenSky metadata listing exceeds size limit')
        root = ET.fromstring(raw)
        if root.tag != '{' + NS['s'] + '}ListBucketResult':
            raise ValueError('Invalid OpenSky metadata listing')
        for item in root.findall('s:Contents', NS):
            key = item.findtext('s:Key', default='', namespaces=NS)
            size = int(item.findtext('s:Size', default='0', namespaces=NS))
            if SNAPSHOT_KEY.fullmatch(key) and size > 0 and key > latest:
                latest, latest_size = key, size
        truncated = root.findtext('s:IsTruncated', namespaces=NS)
        if truncated == 'false':
            if not latest:
                raise ValueError('No complete OpenSky aircraft snapshot found')
            if latest_size > 256 * 1024 * 1024:
                raise ValueError('Latest OpenSky snapshot exceeds source size limit')
            return METADATA_BUCKET + latest
        token = root.findtext('s:NextContinuationToken', namespaces=NS)
        if truncated != 'true' or not token or token in seen:
            raise ValueError('Invalid OpenSky listing pagination')
        seen.add(token)
    raise ValueError('OpenSky metadata listing exceeds page limit')
