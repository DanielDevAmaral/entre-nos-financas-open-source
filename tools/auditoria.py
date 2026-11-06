"""Auditoria estrutural e aritmética. Não é um importador de produção."""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import date, datetime
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re

MONEY = r"[-+]?\d[\d.]*,\d{2}"
MONTHS = "janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro".split()


def money(value: str) -> Decimal:
    """Aceita somente o formato brasileiro observado, sem arredondamento implícito."""
    if not re.fullmatch(r"[-+]?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{2}", value):
        raise ValueError("Valor monetário em formato inválido")
    return Decimal(value.replace(".", "").replace(",", "."))


def file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def nubank_summary(text: str) -> dict:
    lines = text.splitlines()
    index = next(i for i, line in enumerate(lines) if line.strip() == "Saldo inicial")
    values = []
    for line in lines[index + 1:]:
        if re.fullmatch(MONEY, line.strip()):
            values.append(money(line.strip()))
        if len(values) == 5:
            break
    if len(values) != 5:
        raise ValueError("Resumo incompleto")
    opening, earnings, incoming, outgoing, closing = values
    daily_in = [money(v) for v in re.findall(r"Total de entradas\s*\+\s*(\d[\d.]*,\d{2})", text)]
    daily_out = [money(v) for v in re.findall(r"Total de saídas\s*-\s*(\d[\d.]*,\d{2})", text)]
    return {
        "summary_balanced": opening + earnings + incoming + outgoing == closing,
        "daily_in_balanced": sum(daily_in, Decimal(0)) == incoming,
        "daily_out_balanced": sum(daily_out, Decimal(0)) == -outgoing,
        "daily_groups": len(daily_in) + len(daily_out),
        "scope": "Resumo e subtotais diários; itens individuais ainda não homologados",
    }


def wise_summary(text: str) -> dict:
    rows = []
    ids = []
    lines = text.splitlines()
    date_years = Counter()
    for i, line in enumerate(lines):
        match = re.search(r"Transação:\s*([\w-]+)", line)
        if not match:
            continue
        ids.append(match[1])
        year = re.search(r"\d{1,2} de \w+ de (\d{4})", line)
        if year:
            date_years[year[1]] += 1
        nums = re.findall(MONEY, lines[i - 1] if i else "")
        if len(nums) >= 2:
            rows.append(tuple(money(n) for n in nums[-2:]))
    checks = [balance == previous_balance + amount
              for (amount, balance), (_, previous_balance) in zip(rows, rows[1:])]
    return {
        "identified_records": len(ids), "parsed_records": len(rows),
        "all_identified_records_parsed": bool(ids) and len(ids) == len(rows),
        "unique_bank_ids": len(set(ids)),
        "repeated_id_groups": sum(n > 1 for n in Counter(ids).values()),
        "adjacent_pairs": len(checks), "balanced_pairs": sum(checks),
        "unbalanced_pairs": len(checks) - sum(checks),
        "transaction_years": dict(date_years),
        "scope": "Saldos consecutivos; saldo inicial anterior ao primeiro item não atestado",
    }


def itau_summary(text: str) -> dict:
    header = next(line for line in text.splitlines() if "período de visualização" in line)
    dates = re.findall(r"\d{2}/\d{2}/\d{4}", header)
    start, end = [datetime.strptime(d, "%d/%m/%Y").date() for d in dates[:2]]
    rows = []
    dated_lines = 0
    for line in text.splitlines():
        dated_lines += bool(re.match(r"^\d{2}/\d{2}/\d{4} ", line))
        match = re.match(r"^(\d{2}/\d{2}/\d{4}) (.+?)\s+(" + MONEY + r")\s*$", line)
        if match:
            rows.append((datetime.strptime(match[1], "%d/%m/%Y").date(),
                         match[2] == "SALDO DO DIA", money(match[3])))
    opening = max((r for r in rows if r[1] and r[0] < start), key=lambda r: r[0])
    closing = max((r for r in rows if r[1] and start <= r[0] <= end), key=lambda r: r[0])
    movements = [r for r in rows if not r[1] and start <= r[0] <= end]
    return {
        "period_start": str(start), "period_end": str(end),
        "dated_lines": dated_lines, "parsed_rows": len(rows),
        "all_dated_lines_parsed": dated_lines == len(rows),
        "movement_rows": len(movements), "opening_date": str(opening[0]),
        "closing_date": str(closing[0]),
        "outside_balance_dates": [str(r[0]) for r in rows if r[1] and not start <= r[0] <= end],
        "outside_movement_rows": sum(not r[1] and not start <= r[0] <= end for r in rows),
        "period_balanced": opening[2] + sum((r[2] for r in movements), Decimal(0)) == closing[2],
        "scope": "Conciliação agregada; saldos não são transações",
    }


def workbook_summary(path: Path) -> dict:
    import openpyxl
    book = openpyxl.load_workbook(path, data_only=False)
    cached = openpyxl.load_workbook(path, data_only=True)
    sheets = []
    try:
        for i, sheet in enumerate(book):
            formulas = [c for row in sheet for c in row if c.data_type == "f"]
            snapshot = cached[sheet.title]
            dates = [c.coordinate for row in sheet for c in row if isinstance(c.value, (date, datetime))]
            sheets.append({
                "sheet": sheet.title if sheet.title.casefold() in MONTHS + ["total"] else f"aba_{i+1}",
                "state": sheet.sheet_state, "range": sheet.calculate_dimension(),
                "formula_count": len(formulas),
                "broken_reference_formulas": [c.coordinate for c in formulas if "#REF!" in c.value],
                "cached_error_cells": [c.coordinate for row in snapshot for c in row if c.data_type == "e"],
                "missing_formula_cache": sum(snapshot[c.coordinate].value is None for c in formulas),
                "date_cells_to_review": dates,
                "table_count": len(sheet.tables),
                "validation_count": len(sheet.data_validations.dataValidation),
            })
    finally:
        book.close()
        cached.close()
    return {"sheets": sheets, "scope": "Fórmulas e cache lidos sem recalcular ou alterar o original"}


def audit(folder: Path) -> dict:
    from pypdf import PdfReader
    files = []
    seen = {}
    for i, path in enumerate(sorted(folder.iterdir()), 1):
        if not path.is_file() or path.suffix.lower() not in {".pdf", ".xlsx"}:
            continue
        alias = f"F{i:02}"
        digest = file_digest(path)
        record = {"source": alias, "format": path.suffix.lower(), "sha256": digest,
                  "bytes": path.stat().st_size, "commit_allowed": False}
        if digest in seen:
            record["duplicate_of"] = seen[digest]
        else:
            seen[digest] = alias
            try:
                if path.suffix.lower() == ".xlsx":
                    record["analysis"] = workbook_summary(path)
                else:
                    with path.open("rb") as source:
                        pdf = PdfReader(source)
                        pages = [p.extract_text() or "" for p in pdf.pages]
                    text = "\n\f\n".join(pages)
                    record.update(pages=len(pages), pages_with_text=sum(bool(p.strip()) for p in pages))
                    if re.search(r"Extrato em (BRL|USD|EUR)", text):
                        record["provider"] = "Wise"
                        record["currency"] = re.search(r"Extrato em (BRL|USD|EUR)", text)[1]
                        record["analysis"] = wise_summary(text)
                    elif "Nu Pagamentos" in text and "Saldo inicial" in text:
                        record["provider"] = "Nubank"
                        record["analysis"] = nubank_summary(text)
                    elif "período de visualização" in text and "lançamentos valor (R$) saldo (R$)" in text:
                        record["provider"] = "Itaú"
                        record["analysis"] = itau_summary(text)
                    else:
                        record["error"] = "Layout não reconhecido; revisão necessária"
            except Exception:
                # Erros de bibliotecas podem conter dados pessoais. Não os registrar.
                record["error"] = "Não foi possível auditar o layout; revisão local necessária"
        record["original_unchanged"] = file_digest(path) == digest
        files.append(record)
    return {"schema_version": 1, "mode": "read_only_diagnostic", "files": files,
            "file_count": len(files), "unique_file_count": len(seen),
            "disclaimer": "Nenhuma transação importada. Sucesso aritmético não comprova classificação econômica."}


def main() -> None:
    parser = argparse.ArgumentParser(description="Auditoria financeira local sem expor valores")
    parser.add_argument("source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    target = args.output.resolve()
    if not source.is_dir() or target.is_relative_to(source):
        parser.error("A saída deve ficar fora da pasta dos originais")
    if target.exists():
        parser.error("A saída já existe; escolha outro nome para preservar o relatório anterior")
    result = audit(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8") as report:
        json.dump(result, report, ensure_ascii=False, indent=2)
    print(f"Auditoria concluída: {result['file_count']} arquivos; {result['unique_file_count']} únicos.")
    if any("error" in f or not f["original_unchanged"] for f in result["files"]):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
