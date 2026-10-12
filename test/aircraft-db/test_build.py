import csv
import importlib.util
import tempfile
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[2] / 'scripts/aircraft-db'))
spec = importlib.util.spec_from_file_location('builder', Path(__file__).parents[2] / 'scripts/aircraft-db/build.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class DatabaseTests(unittest.TestCase):
    def test_complete_single_quoted_csv_with_camel_case_headers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'complete.csv'
            path.write_text("'icao24','registration','manufacturerName','model','typecode','icaoAircraftClass','owner','operator'\n'C827EE','ZK-NNF','Airbus','A320, test','A320','L2J','Owner''s aircraft','Operator'\n", encoding='utf-8')
            self.assertEqual(builder.parse_aircraft(path)['C827EE'], ['ZK-NNF', 'Airbus', 'A320, test', 'L2J', "Owner's aircraft", 'Operator'])

    def test_sorted_fixed_width_records_and_header_parsing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            aircraft = root / 'aircraft.csv'
            fields = ['icao24', 'registration', 'manufacturername', 'model', 'typecode', 'icaoaircrafttype', 'owner', 'operator']
            with aircraft.open('w', encoding='utf-8', newline='') as stream:
                writer = csv.DictWriter(stream, fieldnames=fields)
                writer.writeheader()
                writer.writerows([
                    {'icao24': 'c827ee', 'registration': 'ZK-NNF', 'icaoaircrafttype': 'L2J'},
                    {'icao24': 'a00001', 'registration': 'N1', 'manufacturername': 'Cessna', 'model': '680'},
                    {'icao24': 'invalid', 'registration': 'IGNORE'},
                    {'icao24': 'c827ee', 'registration': 'ZK-NNF', 'icaoaircrafttype': 'L2J', 'model': 'Example'},
                ])
            airlines = root / 'airlines.txt'
            airlines.write_text('0MM,First Airline,,Mexico\nANZ,"Air, New Zealand",KIWI,New Zealand\n', encoding='utf-8')
            output = root / 'out'
            first = builder.build_snapshot(aircraft, airlines, output, ['a', 'b'])
            second = builder.build_snapshot(aircraft, airlines, output, ['a', 'b'])
            self.assertEqual(first['revision'], second['revision'])
            self.assertEqual(first['files']['aircraft-C8.db']['count'], 1)
            data = (output / first['files']['aircraft-C8.db']['path']).read_bytes()
            self.assertEqual(len(data), 153)
            self.assertEqual(data[:7], b'C827EE\0')
            self.assertEqual(data[7:16], b'ZK-NNF\0\0\0')
            self.assertIn(b'Example\0', data)
            self.assertEqual(builder.parse_airlines(airlines)['0MM'][0], 'First Airline')
            self.assertEqual(builder.parse_airlines(airlines)['ANZ'][0], 'Air, New Zealand')

    def test_invalid_input_and_unicode_padding(self):
        self.assertEqual(len(builder.field('É' * 80, 33)), 33)
        self.assertEqual(builder.field('É' * 80, 33), b'E' * 32 + b'\0')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad.csv'
            path.write_text('bad,header\n1,2\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'header'):
                builder.parse_aircraft(path)


if __name__ == '__main__':
    unittest.main()
