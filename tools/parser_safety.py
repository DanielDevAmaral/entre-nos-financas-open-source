"""Bound archive expansion before handing XLSX to a document parser."""
from io import BytesIO
from zipfile import ZipFile, BadZipFile


def validate_xlsx(content: bytes) -> None:
    try:
        with ZipFile(BytesIO(content)) as archive:
            entries = archive.infolist()
            if not 0 < len(entries) <= 1000:
                raise ValueError("Archive entry limit")
            if sum(item.file_size for item in entries) > 40 * 1024 * 1024:
                raise ValueError("Archive expansion limit")
            for item in entries:
                if item.flag_bits & 1 or item.file_size > 20 * 1024 * 1024:
                    raise ValueError("Unsupported archive entry")
                if item.file_size > 1024 * 1024 and item.file_size > max(1, item.compress_size) * 300:
                    raise ValueError("Archive compression limit")
    except BadZipFile as exc:
        raise ValueError("Invalid XLSX archive") from exc
