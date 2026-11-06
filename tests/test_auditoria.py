import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from decimal import Decimal

from tools.auditoria import audit, file_digest, itau_summary, money, nubank_summary, wise_summary


def nu(incoming="+100,00", outgoing="-25,00", closing="75,00"):
    return f"""Saldo inicial
Rendimento líquido
Total de entradas
Total de saídas
Saldo final do período
0,00
+0,00
{incoming}
{outgoing}
{closing}
01 JAN 2026 Total de entradas + 100,00
Total de saídas - 25,00
"""


class MoneyTests(unittest.TestCase):
    def test_decimal_exact(self):
        self.assertEqual(money("0,10") + money("0,20"), money("0,30"))

    def test_sign_and_thousands(self):
        self.assertEqual(money("-1.234,56"), Decimal("-1234.56"))

    def test_reject_ambiguous_formats(self):
        for value in ["1,234.56", "1.23,45", "1,2", "NaN", "100", "R$ 10,00", "1e5", "1,001"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                money(value)


class NubankTests(unittest.TestCase):
    def test_balanced_summary_and_daily_groups(self):
        result = nubank_summary(nu())
        self.assertTrue(result["summary_balanced"])
        self.assertTrue(result["daily_in_balanced"])
        self.assertTrue(result["daily_out_balanced"])

    def test_unbalanced_summary_is_visible(self):
        self.assertFalse(nubank_summary(nu(closing="70,00"))["summary_balanced"])

    def test_daily_error_is_visible_even_with_balanced_summary(self):
        result = nubank_summary(nu(incoming="+101,00", closing="76,00"))
        self.assertTrue(result["summary_balanced"])
        self.assertFalse(result["daily_in_balanced"])

    def test_missing_summary_fails(self):
        with self.assertRaises((StopIteration, ValueError)):
            nubank_summary("Sem resumo")


class WiseTests(unittest.TestCase):
    def test_repeated_bank_id_keeps_both_rows(self):
        text = """Ajuste 20,00 70,00
2 de janeiro de 2026 | Transação: CARD-ficticio
Compra -50,00 50,00
2 de janeiro de 2026 | Transação: CARD-ficticio
Recebimento 100,00 100,00
1 de janeiro de 2026 | Transação: TRANSFER-ficticio
"""
        result = wise_summary(text)
        self.assertEqual(result["parsed_records"], 3)
        self.assertEqual(result["unique_bank_ids"], 2)
        self.assertEqual(result["repeated_id_groups"], 1)
        self.assertEqual(result["balanced_pairs"], 2)

    def test_conversion_description_does_not_replace_amount_column(self):
        text = """10,00 USD convertidos para 50,00 BRL 50,00 150,00
2 de janeiro de 2026 | Transação: BALANCE-ficticio
Recebimento 100,00 100,00
1 de janeiro de 2026 | Transação: TRANSFER-ficticio
"""
        self.assertEqual(wise_summary(text)["balanced_pairs"], 1)

    def test_unparsed_record_and_drift_are_visible(self):
        result = wise_summary("texto\n1 de janeiro de 2026 | Transação: CARD-ficticio")
        self.assertFalse(result["all_identified_records_parsed"])
        drift = wise_summary("Compra -20,00 90,00\n2 de janeiro de 2026 | Transação: CARD-A\nRecebimento 100,00 100,00\n1 de janeiro de 2026 | Transação: TRANSFER-B")
        self.assertEqual(drift["unbalanced_pairs"], 1)


class ItauTests(unittest.TestCase):
    def test_opening_balance_not_treated_as_income(self):
        text = """período de visualização: 01/01/2026 até 30/06/2026 emitido em: 21/10/2026
09/10/2026 SALDO DO DIA 0,00
30/06/2026 SALDO DO DIA 125,00
30/06/2026 Compra -25,00
29/06/2026 Recebimento 50,00
31/12/2025 SALDO DO DIA 100,00
"""
        result = itau_summary(text)
        self.assertTrue(result["period_balanced"])
        self.assertEqual(result["movement_rows"], 2)
        self.assertEqual(result["outside_balance_dates"], ["2026-10-09", "2025-12-31"])

    def test_changed_layout_not_silently_complete(self):
        text = """período de visualização: 01/01/2026 até 31/01/2026
31/01/2026 SALDO DO DIA 100,00
02/01/2026 Valor ilegível
31/12/2025 SALDO DO DIA 100,00
"""
        self.assertFalse(itau_summary(text)["all_dated_lines_parsed"])


class IntegrityTests(unittest.TestCase):
    def test_byte_duplicate_only_audited_once_and_original_preserved(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory)
            a = folder / "a.xlsx"
            b = folder / "b.xlsx"
            a.write_bytes(b"conteudo ficticio")
            b.write_bytes(a.read_bytes())
            before = file_digest(a)
            with patch("tools.auditoria.workbook_summary", return_value={"sheets": []}) as reader:
                result = audit(folder)
            self.assertEqual(reader.call_count, 1)
            self.assertEqual(result["unique_file_count"], 1)
            self.assertEqual(result["files"][1]["duplicate_of"], "F01")
            self.assertEqual(file_digest(a), before)
            self.assertTrue(all(f["original_unchanged"] for f in result["files"]))
            self.assertTrue(all(not f["commit_allowed"] for f in result["files"]))
            self.assertNotIn("conteudo", json.dumps(result))

    def test_exception_messages_are_not_exposed(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "a.xlsx").write_bytes(b"ficticio")
            with patch("tools.auditoria.workbook_summary", side_effect=ValueError("segredo ficticio")):
                result = audit(folder)
            self.assertIn("error", result["files"][0])
            self.assertNotIn("segredo", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
