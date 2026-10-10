import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


def load_script(relative):
    path = Path(__file__).resolve().parents[2] / relative
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


airport_build = load_script("scripts/airport-db/build.py")
label_build = load_script("scripts/acars-data/build-labels.py")
HEADER = "id,name,icao_code,iata_code,type,gps_code,ident\n"


class AirportBuildTests(unittest.TestCase):
    def test_preserves_iata_only_and_icao_only_records_and_quoted_names(self):
        rows = airport_build.airport_rows(HEADER + '1,"Airport, One",ABCD,ABC,small_airport,,\n2,Heliport,,DEF,heliport,,\n3,Old field,EFGH,,closed,,\n')
        self.assertEqual(len(rows), 3)
        self.assertIn(["Airport, One", "ABCD", "ABC"], rows)
        self.assertIn(["Old field", "EFGH", ""], rows)

    def test_does_not_treat_local_or_gps_identifiers_as_icao(self):
        self.assertEqual(airport_build.airport_rows(HEADER + '1,Local field,,,small_airport,K00A,00A\n'), [])

    def test_rejects_ambiguous_or_invalid_codes(self):
        for data in ['1,One,ABCD,ABC,,,\n2,Two,ABCD,DEF,,,\n', '1,One,ABC1,ABC,,,\n', '1,One,ABCD,abc,,,\n']:
            with self.subTest(data=data), self.assertRaises(ValueError):
                airport_build.airport_rows(HEADER + data)

    def test_reproducible_output_and_source_counts(self):
        raw = (HEADER + '1,One,ABCD,ABC,,,\n2,Two,,DEF,,,\n').encode()
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            first = airport_build.build(raw, output)
            contents = (output / "airports.json").read_bytes()
            self.assertEqual(airport_build.build(raw, output), first)
            self.assertEqual((output / "airports.json").read_bytes(), contents)
            self.assertEqual((first["airportCount"], first["icaoCount"], first["iataCount"]), (2, 1, 2))

    def test_imports_all_two_character_label_entries_without_executing_code(self):
        raw = b'raise RuntimeError("must not execute")\narinc620 = {"Q3":["GMT clock update"], "D":["Sublabel"]}\n'
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp)
            result = label_build.build(raw, output)
            self.assertEqual(result["labelCount"], 1)
            self.assertEqual(json.loads((output / "labels.json").read_text()), {"Q3": ["GMT clock update"]})


if __name__ == "__main__":
    unittest.main()
