"""Private same-project extraction function. No financial content is logged."""
from http.server import BaseHTTPRequestHandler
import base64
import hmac
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from tools.importar import extract
from tools.parser_safety import validate_xlsx

class handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        token = os.environ.get("PARSER_TOKEN", "")
        actual = self.headers.get("Authorization", "")
        if len(token) < 32 or not hmac.compare_digest(actual.encode(), ("Bearer " + token).encode()):
            return self.reply(403, {"error": "Acesso recusado."})
        try:
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise ValueError("media type")
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 4 * 1024 * 1024 + 2048:
                raise ValueError("size")
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict) or set(body) != {"extension", "currency", "data"}:
                raise ValueError("fields")
            ext, currency = body["extension"], body["currency"]
            if ext not in (".pdf", ".csv", ".xlsx") or currency not in ("BRL", "USD", "EUR"):
                raise ValueError("format")
            content = base64.b64decode(body["data"], validate=True)
            if not 0 < len(content) <= 3 * 1024 * 1024:
                raise ValueError("size")
            if ext == ".xlsx":
                validate_xlsx(content)
            with TemporaryDirectory(prefix="entre-nos-") as folder:
                path = Path(folder) / ("document" + ext)
                path.write_bytes(content)
                result = extract(path, currency)
            return self.reply(200, result)
        except Exception:
            return self.reply(400, {"error": "Extração recusada. Nenhum lançamento confirmado."})

    def reply(self, status, body):
        content = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)
