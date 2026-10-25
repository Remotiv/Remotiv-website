"""
CV parser — extract text from uploaded PDF using Docling (IBM).

Accepts raw PDF bytes, writes to a temp file, converts via Docling's
DocumentConverter, and returns the markdown text. Falls back to
pdfplumber if docling is unavailable.
"""

import os
import tempfile
from loguru import logger


def parse_cv_bytes(pdf_bytes: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(pdf_bytes)
        tmp_path = tmp.name

    try:
        return _pdf_to_markdown(tmp_path)
    finally:
        os.unlink(tmp_path)


def _pdf_to_markdown(pdf_path: str) -> str:
    try:
        from docling.document_converter import DocumentConverter
    except ImportError:
        logger.info("docling not installed — falling back to pdfplumber")
        return _pdf_to_markdown_pdfplumber(pdf_path)

    try:
        converter = DocumentConverter()
        result = converter.convert(pdf_path)
        doc = result.document
    except Exception as exc:
        logger.warning(f"docling conversion failed: {exc} — falling back to pdfplumber")
        return _pdf_to_markdown_pdfplumber(pdf_path)

    prose = doc.export_to_markdown()

    if not prose or not prose.strip():
        logger.warning("docling returned empty output — falling back to pdfplumber")
        return _pdf_to_markdown_pdfplumber(pdf_path)

    logger.info(f"docling: {len(prose)} chars from {os.path.basename(pdf_path)}")
    return prose


def _pdf_to_markdown_pdfplumber(pdf_path: str) -> str:
    try:
        import pdfplumber
    except ImportError:
        logger.error("Neither docling nor pdfplumber installed — cannot parse PDF")
        return ""

    try:
        pages = []
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if text:
                    pages.append(text)
        result = "\n\n".join(pages)
        logger.info(f"pdfplumber: {len(result)} chars from {os.path.basename(pdf_path)}")
        return result
    except Exception as exc:
        logger.error(f"pdfplumber extraction failed: {exc}")
        return ""
