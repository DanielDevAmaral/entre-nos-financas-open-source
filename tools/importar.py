"""Extrai somente para prévia local. Entrada/saída nunca devem ir para logs."""
from __future__ import annotations

import csv
from datetime import datetime, timedelta
import io
import json
from pathlib import Path
import re
import sys
import zipfile

from pypdf import PdfReader
from tools.auditoria import MONEY, MONTHS, itau_summary, money, nubank_summary, wise_summary, workbook_summary

ABBR = dict(zip("JAN FEV MAR ABR MAI JUN JUL AGO SET OUT NOV DEZ".split(), range(1, 13)))


def minor(value: str) -> str:
    return str(int(money(value) * 100))


def suggest(description: str, amount: str) -> tuple[str, float]:
    text = description.casefold()
    if text.startswith("wise charges for:"):
        return "fee", 0.99
    if "convertidos para" in text:
        return "fx", 0.95
    if "pagamento de fatura" in text:
        return "card_payment", 0.98
    if "reembolso" in text or "estorno" in text or "devolução" in text:
        return "refund", 0.75
    if "aplicação" in text:
        return "investment_buy", 0.8
    if "resgate" in text:
        return "investment_sell", 0.8
    if "rendimento" in text or "rend pago" in text or "cashback" in text:
        return "yield", 0.75
    if "taxa" in text or "tarifa" in text or "iof" in text:
        return "fee", 0.75
    if "remuneracao/salario" in text:
        return "income", 0.9
    if "compra no débito" in text or "pix qrs" in text or "transação por cartão" in text:
        return "expense", 0.65
    return ("income" if int(amount) > 0 else "expense"), 0.25


def record(day: str, description: str, amount: str, currency: str, locator: str, bank_id: str | None = None) -> dict:
    kind, confidence = suggest(description, amount)
    return {"date": day, "description": description.strip(), "original_description": description.strip(),
            "amount_cents": amount, "currency": currency, "locator": locator, "bank_id": bank_id,
            "suggested_kind": kind, "confidence": confidence}


def itau(pages: list[str]) -> dict:
    text = "\n".join(pages)
    summary = itau_summary(text)
    start, end = summary["period_start"], summary["period_end"]
    rows, checkpoints = [], []
    for page_no, page in enumerate(pages, 1):
        for line_no, line in enumerate(page.splitlines(), 1):
            match = re.match(r"^(\d{2}/\d{2}/\d{4}) (.+?)\s+(" + MONEY + r")\s*$", line)
            if not match:
                continue
            day = datetime.strptime(match[1], "%d/%m/%Y").date().isoformat()
            if match[2] == "SALDO DO DIA":
                checkpoints.append({"date": day, "cents": minor(match[3])})
            elif start <= day <= end:
                rows.append(record(day, match[2], minor(match[3]), "BRL", f"página {page_no}, linha {line_no}"))
    opening = next(x for x in checkpoints if x["date"] == summary["opening_date"])
    closing = next(x for x in checkpoints if x["date"] == summary["closing_date"])
    return {"parser": "itau-pdf-v1", "currency": "BRL", "rows": rows,
            "period_start": start, "period_end": end, "opening": opening, "closing": closing,
            "checks": [{"label": "Todas as linhas datadas reconhecidas", "passed": summary["all_dated_lines_parsed"]},
                       {"label": "Saldo inicial + movimentos = saldo final do período", "passed": summary["period_balanced"]}],
            "warnings": ["Linhas de saldo não são transações. Há referências de saldo fora do período declarado."]}


def wise(pages: list[str]) -> dict:
    text = "\n".join(pages)
    currency = re.search(r"Extrato em (BRL|USD|EUR)", text)[1]
    rows = []
    closing = None
    for page_no, page in enumerate(pages, 1):
        lines = page.splitlines()
        for index, line in enumerate(lines):
            match = re.search(r"Transação:\s*([\w-]+)", line)
            if not match:
                continue
            date_match = re.search(r"(\d{1,2}) de (\w+) de (\d{4})", line)
            if not date_match:
                raise ValueError("Data não reconhecida")
            day = datetime(int(date_match[3]), MONTHS.index(date_match[2]) + 1, int(date_match[1])).date().isoformat()
            amounts = list(re.finditer(MONEY, lines[index - 1]))
            if len(amounts) < 2:
                raise ValueError("Colunas não reconhecidas")
            description = lines[index - 1][:amounts[-2].start()].strip()
            # Descrições podem ocupar mais de uma linha, sem carregar cabeçalhos.
            prior = index - 2
            while prior >= 0 and lines[prior].strip() and not re.search(r"Transação:|Descrição|Entrada|Saída|Valor|\d{1,2} de \w+ de \d{4}", lines[prior]) and not re.search(MONEY + r"\s+" + MONEY + r"\s*$", lines[prior]):
                description = lines[prior].strip() + " " + description
                prior -= 1
            row = record(day, description, minor(amounts[-2][0]), currency,
                         f"página {page_no}, linha {index + 1}", match[1])
            conversion = re.search(r"(" + MONEY + r") (BRL|USD|EUR) convertidos para (" + MONEY + r") (BRL|USD|EUR)", description)
            if conversion:
                if currency == conversion[4]:
                    row.update(counter_currency=conversion[2], counter_amount_cents=str(-int(minor(conversion[1]))))
                else:
                    row.update(counter_currency=conversion[4], counter_amount_cents=minor(conversion[3]))
            rows.append(row)
            if closing is None:
                closing = {"date": day, "cents": minor(amounts[-1][0])}
    summary = wise_summary(text)
    periods = re.findall(r"(\d{1,2}) de (\w+) de (\d{4})", text)
    start, end = [datetime(int(y), MONTHS.index(m) + 1, int(d)).date().isoformat() for d, m, y in periods[:2]]
    return {"parser": "wise-pdf-v1", "currency": currency, "rows": rows,
            "period_start": start, "period_end": end, "closing": closing,
            "checks": [{"label": "Todos os registros identificados foram extraídos", "passed": summary["identified_records"] == len(rows)},
                       {"label": "Saldos consecutivos conciliados", "passed": summary["unbalanced_pairs"] == 0}],
            "warnings": ["Saldo anterior ao primeiro registro não atestado. Confirme a abertura na conta.",
                         "IDs repetidos são preservados e precisam de revisão. Câmbio exige a outra moeda e conta."]}


def nubank(pages: list[str]) -> dict:
    text = "\n".join(pages)
    summary = nubank_summary(text)
    rows, groups = [], []
    current_date, group, pending = None, None, None
    starts = re.compile(r"^(?:Transferência\b|Pagamento (?:de|com|recebido|efetuado)\b|Compra\b|Aplicação\b|Resgate\b|Reembolso\b|Estorno\b|Rendimento\b|Crédito\b|Débito\b|Devolução\b|Depósito\b|Ajuste\b|Recarga\b|Saque\b|Pix\b|Cobrança\b)", re.I)
    for page_no, page in enumerate(pages, 1):
        active = group is not None
        lines = page.splitlines()
        for line_no, original in enumerate(lines, 1):
            line = original.strip()
            dated = re.match(r"^(\d{2}) ([A-Z]{3}) (\d{4})\s*(.*)$", line)
            if dated:
                active = True
                current_date = datetime(int(dated[3]), ABBR[dated[2]], int(dated[1])).date().isoformat()
                line = dated[4]
            total = re.match(r"Total de (entradas|saídas)\s*([+-])\s*(\d[\d.]*,\d{2})", line)
            if total and current_date:
                active = True
                if pending:
                    raise ValueError("Lançamento incompleto antes do subtotal: " + pending["locator"])
                group = {"date": current_date, "sign": 1 if total[1] == "entradas" else -1,
                         "expected": int(minor(total[3])), "actual": 0}
                groups.append(group)
                continue
            if re.search(r"^O saldo líquido|^Tem alguma dúvida|^Extrato gerado", line, re.I):
                active = False
            if not active or not current_date or group is None:
                continue
            if pending is None and starts.match(line):
                pending = {"description": [], "locator": f"página {page_no}, linha {line_no}"}
            if pending is not None:
                # Rodapés/cabeçalhos nunca completam uma transação.
                if re.search(r"Extrato gerado|Ouvidoria|VALORES EM|^CPF|Saldo inicial|Saldo final|Total de entradas$|Total de saídas$|Tem alguma dúvida|O saldo líquido", line, re.I):
                    continue
                amount = re.search(r"(?:^|\s)(" + MONEY + r")\s*$", line)
                if amount:
                    description_tail = line[:amount.start()].strip()
                    if description_tail:
                        pending["description"].append(description_tail)
                    value = abs(int(minor(amount[1]))) * group["sign"]
                    group["actual"] += abs(value)
                    rows.append(record(current_date, " ".join(pending["description"]), str(value), "BRL", pending["locator"]))
                    pending = None
                elif line:
                    pending["description"].append(line)
    if pending:
        raise ValueError("Último lançamento incompleto")
    all_groups = bool(groups) and all(g["actual"] == g["expected"] for g in groups)
    # Cabeçalho contém duas datas portuguesas completas.
    periods = re.findall(r"(\d{2}) DE (\w+) DE (\d{4})", text.upper())
    if len(periods) < 2:
        raise ValueError("Período não reconhecido")
    start, end = [datetime(int(y), MONTHS.index(m.casefold()) + 1, int(d)).date().isoformat() for d, m, y in periods[:2]]
    lines = text.splitlines()
    summary_index = next(i for i, line in enumerate(lines) if line.strip() == "Saldo inicial")
    values = [line.strip() for line in lines[summary_index+1:] if re.fullmatch(MONEY, line.strip())][:5]
    return {"parser": "nubank-pdf-v1", "currency": "BRL", "rows": rows,
            "period_start": start, "period_end": end,
            "opening": {"date": (datetime.fromisoformat(start)-timedelta(days=1)).date().isoformat(), "cents": minor(values[0])},
            "closing": {"date": end, "cents": minor(values[4])},
            "checks": [{"label": "Resumo do período conciliado", "passed": summary["summary_balanced"]},
                       {"label": "Subtotais diários conciliados ao resumo", "passed": summary["daily_in_balanced"] and summary["daily_out_balanced"]},
                       {"label": "Itens individuais conciliados em cada grupo diário", "passed": all_groups,
                        "groups_to_review": [g["date"] for g in groups if g["actual"] != g["expected"]]}],
            "warnings": ["Pix não comprova receita ou despesa: confirme titularidade e finalidade.",
                         "Pagamento de fatura exige uma conta de cartão, sem duplicar o consumo."]}


def csv_preview(path: Path, currency: str) -> dict:
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1252")
    dialect = csv.Sniffer().sniff(text[:4096], delimiters=";,\t")
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    columns = reader.fieldnames or []
    if not {"data", "descricao", "valor"}.issubset(columns):
        raise ValueError("CSV precisa de data, descricao e valor")
    rows = []
    for index, row in enumerate(reader, 2):
        day = datetime.strptime(row["data"], "%d/%m/%Y").date().isoformat()
        curr = row.get("moeda", currency) or currency
        if curr != currency:
            raise ValueError("CSV com moeda diferente da conta")
        rows.append(record(day, row["descricao"], minor(row["valor"]), curr, f"linha {index}", row.get("id") or None))
    if len(rows) > 5000:
        raise ValueError("Limite de linhas excedido")
    return {"parser": "csv-br-v1", "currency": currency, "rows": rows,
            "checks": [{"label": "Linhas e tipos do CSV reconhecidos", "passed": bool(rows)}],
            "warnings": ["CSV sem saldos de controle. A conciliação bancária permanece indisponível."]}


def extract(path: Path, currency: str = "BRL") -> dict:
    if path.stat().st_size > 10 * 1024 * 1024:
        raise ValueError("Arquivo muito grande")
    if path.suffix.casefold() == ".csv":
        return csv_preview(path, currency)
    if path.suffix.casefold() == ".xlsx":
        with zipfile.ZipFile(path) as archive:
            if sum(x.file_size for x in archive.infolist()) > 30 * 1024 * 1024:
                raise ValueError("Planilha expandida excede o limite")
        summary = workbook_summary(path)
        from tools.orcamento import planning_reference
        summary['planning'] = planning_reference(path)
        return {"parser": "xlsx-diagnostico-v1", "currency": currency, "rows": [], "reference": summary,
                "checks": [{"label": "Planilha de orçamento não é extrato transacional", "passed": False}],
                "warnings": ["Estrutura disponível para consulta. Importação de orçamento será tratada em etapa própria; totais não geram despesas."]}
    if path.suffix.casefold() != ".pdf":
        raise ValueError("Formato não suportado")
    reader = PdfReader(path)
    if len(reader.pages) > 120:
        raise ValueError("Limite de páginas excedido")
    pages = [page.extract_text() or "" for page in reader.pages]
    if any(not page.strip() for page in pages):
        raise ValueError("PDF sem texto em uma ou mais páginas")
    text = "\n".join(pages)
    if re.search(r"Extrato em (BRL|USD|EUR)", text):
        return wise(pages)
    if "Nu Pagamentos" in text and "Saldo inicial" in text:
        return nubank(pages)
    if "período de visualização" in text:
        return itau(pages)
    raise ValueError("Layout PDF não reconhecido")


if __name__ == "__main__":
    try:
        result = extract(Path(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else "BRL")
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
    except Exception:
        sys.stdout.buffer.write(json.dumps({"error": "Não foi possível extrair com segurança. Verifique o formato ou a instalação do Python; nenhum lançamento foi confirmado."}).encode("utf-8"))
        sys.exit(2)
