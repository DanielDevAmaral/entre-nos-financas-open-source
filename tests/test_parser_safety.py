import unittest
from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED
from tools.parser_safety import validate_xlsx


class ParserSafetyTest(unittest.TestCase):
    def archive(self, content):
        stream = BytesIO()
        with ZipFile(stream, "w", ZIP_DEFLATED) as archive:
            archive.writestr("xl/worksheets/sheet1.xml", content)
        return stream.getvalue()

    def test_small_archive(self):
        validate_xlsx(self.archive("<sheet>Fictitious</sheet>"))

    def test_large_expansion_rejected_before_extraction(self):
        with self.assertRaises(ValueError):
            validate_xlsx(self.archive(b"0" * (2 * 1024 * 1024)))

    def test_invalid_archive(self):
        with self.assertRaises(ValueError):
            validate_xlsx(b"not an archive")


if __name__ == "__main__":
    unittest.main()
