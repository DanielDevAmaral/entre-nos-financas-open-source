"""Validação privada em memória, sem confirmar importação ou exibir valores."""
from pathlib import Path
import hashlib
import json
import sys
from tools.importar import extract


def verify(folder: Path) -> dict:
    seen = set()
    results = []
    for index, path in enumerate(sorted(folder.iterdir()), 1):
        if path.suffix.casefold() not in {".pdf", ".xlsx"} or not path.is_file():
            continue
        before = hashlib.sha256(path.read_bytes()).hexdigest()
        if before in seen:
            results.append({"source": f"F{index:02}", "byte_duplicate": True})
            continue
        seen.add(before)
        try:
            data = extract(path)
            results.append({"source": f"F{index:02}", "parser": data["parser"],
                            "rows": len(data["rows"]), "checks": data["checks"],
                            "original_unchanged": before == hashlib.sha256(path.read_bytes()).hexdigest()})
        except Exception as error:
            # Somente classe do erro; mensagens podem conter informações do extrato.
            results.append({"source": f"F{index:02}", "error_type": type(error).__name__})
    return {"mode": "read_only_in_memory", "sources": results}


if __name__ == "__main__":
    print(json.dumps(verify(Path(sys.argv[1])), ensure_ascii=True, indent=2))
