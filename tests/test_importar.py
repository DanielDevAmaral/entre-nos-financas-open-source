from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from tools.importar import csv_preview, nubank, wise


class PreviewTests(unittest.TestCase):
    def nu_header(self, incoming="100,00", outgoing="0,00", closing="100,00"):
        return f"""01 DE JANEIRO DE 2026 a 31 DE JANEIRO DE 2026
Saldo inicial
Rendimento líquido
Total de entradas
Total de saídas
Saldo final do período
0,00
0,00
+{incoming}
-{outgoing}
{closing}
Movimentações
"""

    def test_multiline_and_page_continuation(self):
        first = self.nu_header() + "01 JAN 2026 Total de entradas + 100,00\nTransferência recebida pelo Pix\nPessoa fictícia\n40,00\nTem alguma dúvida?\nExtrato gerado"
        second = "Cabeçalho fictício\nPAGAMENTO S.A. Agência: fictícia\nTransferência recebida pelo Pix Outra pessoa fictícia\n60,00\nO saldo líquido corresponde\nNu Pagamentos\nPagamento"
        result = nubank([first, second])
        self.assertEqual(len(result["rows"]), 2)
        self.assertTrue(all(check["passed"] for check in result["checks"]))
        self.assertEqual(sum(int(r["amount_cents"]) for r in result["rows"]), 10000)

    def test_unknown_item_causes_failed_reconciliation(self):
        page = self.nu_header() + "01 JAN 2026 Total de entradas + 100,00\nFormato desconhecido 100,00\nO saldo líquido corresponde"
        result = nubank([page])
        self.assertFalse(result["checks"][-1]["passed"])
        self.assertEqual(result["rows"], [])

    def test_negative_daily_group_applies_sign_once(self):
        page = self.nu_header("0,00", "25,00", "-25,00") + "01 JAN 2026 Total de saídas - 25,00\nPagamento de fatura 25,00\nO saldo líquido corresponde"
        result = nubank([page])
        self.assertEqual(result["rows"][0]["amount_cents"], "-2500")
        self.assertTrue(all(c["passed"] for c in result["checks"]))

    def test_wise_repeated_ids_and_currency_amounts_are_preserved(self):
        page = """Extrato em BRL
1 de janeiro de 2026 - 31 de janeiro de 2026
Descrição Entrada Saída Valor
10,00 USD convertidos para 50,00 BRL 50,00 150,00
2 de janeiro de 2026 | Transação: CARD-ficticio
Recebimento 100,00 100,00
1 de janeiro de 2026 | Transação: CARD-ficticio
"""
        result = wise([page])
        self.assertEqual(len(result["rows"]), 2)
        self.assertEqual(result["rows"][0]["counter_amount_cents"], "-1000")
        self.assertEqual(result["rows"][0]["counter_currency"], "USD")
        self.assertEqual(result["rows"][0]["bank_id"], result["rows"][1]["bank_id"])
        self.assertEqual(result["period_end"], "2026-01-31")

    def test_csv_quotes_decimal_and_date(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "ficticio.csv"
            path.write_text('data;descricao;valor;moeda\n21/10/2026;"Exemplo; fictício";-1.234,56;BRL\n', encoding="utf-8-sig")
            result = csv_preview(path, "BRL")
            self.assertEqual(result["rows"][0]["amount_cents"], "-123456")
            self.assertEqual(result["rows"][0]["date"], "2026-10-21")
            self.assertEqual(result["rows"][0]["description"], "Exemplo; fictício")

    def test_csv_other_currency_is_rejected(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "ficticio.csv"
            path.write_text('data;descricao;valor;moeda\n21/10/2026;Fictício;1,00;USD\n', encoding="utf-8")
            with self.assertRaises(ValueError):
                csv_preview(path, "BRL")

    def test_wise_charges_are_fees_not_consumption(self):
        from tools.importar import suggest
        self.assertEqual(suggest("Wise Charges for: BALANCE-ficticio", "-1131")[0], "fee")


if __name__ == "__main__":
    unittest.main()
