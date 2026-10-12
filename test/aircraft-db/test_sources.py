import sys
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parents[2] / 'scripts/aircraft-db'))
from sources import resolve_aircraft_url


def listing(entries, extra='<IsTruncated>false</IsTruncated>'):
    contents = ''.join(f'<Contents><Key>{key}</Key><Size>{size}</Size></Contents>' for key, size in entries)
    return f'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">{contents}{extra}</ListBucketResult>'.encode()


class DiscoveryTests(unittest.TestCase):
    def test_latest_release_across_pages(self):
        urls = []
        pages = [
            listing([('metadata/aircraftDatabase-2026-10.csv', 1000), ('metadata/aircraft-database-complete-2024-04.csv', 1000)], '<IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;page</NextContinuationToken>'),
            listing([('metadata/aircraft-database-complete-2025-08.csv', 1000), ('metadata/aircraft-database-complete-2026-13.csv', 1000), ('metadata/aircraft-database-complete-2026-01.csv', 0)]),
        ]
        def fetch(url):
            urls.append(url)
            return pages.pop(0)
        self.assertTrue(resolve_aircraft_url(fetch).endswith('complete-2025-08.csv'))
        self.assertEqual(parse_qs(urlparse(urls[1]).query)['continuation-token'], ['next&page'])

    def test_no_complete_release_and_invalid_pagination_fail(self):
        with self.assertRaisesRegex(ValueError, 'No complete'):
            resolve_aircraft_url(lambda _: listing([('metadata/aircraftDatabase.csv', 1000)]))
        with self.assertRaisesRegex(ValueError, 'pagination'):
            resolve_aircraft_url(lambda _: listing([], '<IsTruncated>true</IsTruncated>'))

    def test_oversized_latest_release_does_not_select_older_snapshot(self):
        with self.assertRaisesRegex(ValueError, 'size limit'):
            resolve_aircraft_url(lambda _: listing([('metadata/aircraft-database-complete-2025-08.csv', 1000), ('metadata/aircraft-database-complete-2026-01.csv', 257 * 1024 * 1024)]))


if __name__ == '__main__':
    unittest.main()
