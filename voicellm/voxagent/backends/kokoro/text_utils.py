"""
Text sanitization and sentence-splitting for TTS streaming.

These are TTS-engine-agnostic — any backend producing spoken audio
from text chunks can reuse them. They live under kokoro/ for now
but could move to a shared utils/ if a second TTS engine needs them.
"""

import re


# ── Sanitization patterns ──
_CODE_FENCE_RE = re.compile(r"```(?:\w*\n?)?(.*?)```", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`([^`\n]*)`")
_TTS_STRIP_RE = re.compile(r"[^A-Za-z0-9\s.,;:!?'\"()\-/%$&@\n]")
_MARKDOWN_RE = re.compile(r"[*#_\[\]{}|>~=+]")
_CURRENCY_MAG_RE = re.compile(
    r'\$\s*([\d,.]+)\s*(million|billion|trillion|thousand)', re.IGNORECASE)
_CURRENCY_PLAIN_RE = re.compile(r'\$\s*([\d,.]+)')

# ── Splitting patterns ──
_SENTENCE_END_RE = re.compile(r'([.!?])\s+')
_NEWLINE_SPLIT_RE = re.compile(r'\n\s*')
_CLAUSE_RE = re.compile(r'([,;:])(\s+)')


def sanitize_for_tts(text: str) -> str:
    """Strip markdown, code fences, and normalise currency for spoken output."""
    text = _CODE_FENCE_RE.sub(r"\1", text)
    text = _INLINE_CODE_RE.sub(r"\1", text)
    text = _MARKDOWN_RE.sub(" ", text)
    text = _CURRENCY_MAG_RE.sub(r'\1 \2 dollars', text)
    text = _CURRENCY_PLAIN_RE.sub(r'\1 dollars', text)
    text = _TTS_STRIP_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r'[,;:]+$', '', text).strip()
    text = re.sub(r'^[\s,;:]+', '', text).strip()
    return text


def split_for_tts(buffer: str, is_first_chunk: bool = True,
                  first_chunk_chars: int = 20, first_chunk_max: int = 40,
                  min_chunk_chars: int = 60, max_buffer_chars: int = 200):
    """
    Split accumulated text into TTS-ready chunks.

    Returns (chunks_list, remaining_buffer).
    First chunk uses smaller thresholds for lower latency.

    Chunking params are passed in so they can come from config
    rather than module-level constants.
    """
    chunks = []

    if is_first_chunk and len(buffer) >= first_chunk_chars:
        m = _SENTENCE_END_RE.search(buffer)
        if m and m.end() <= first_chunk_max:
            end = m.end()
            chunk = buffer[:end].strip()
            if chunk:
                chunks.append(chunk)
                return chunks, buffer[end:]

        clause_matches = list(_CLAUSE_RE.finditer(buffer, 0, first_chunk_max))
        if clause_matches:
            end = clause_matches[-1].end()
            chunk = buffer[:end].strip()
            if chunk:
                chunks.append(chunk)
                return chunks, buffer[end:]

        if len(buffer) >= first_chunk_max:
            last_space = buffer.rfind(' ', first_chunk_chars, first_chunk_max)
            if last_space > 0:
                chunk = buffer[:last_space].strip()
                if chunk:
                    chunks.append(chunk)
                    return chunks, buffer[last_space:]

        return chunks, buffer

    # ── Subsequent chunks: split on sentence boundaries ──
    pos = 0
    for m in _SENTENCE_END_RE.finditer(buffer):
        end = m.end()
        chunk = buffer[pos:end].strip()
        if not chunk:
            pos = end
            continue
        if len(chunk) >= min_chunk_chars:
            chunks.append(chunk)
            pos = end
        elif chunks:
            chunks[-1] = chunks[-1] + " " + chunk
            pos = end

    remainder = buffer[pos:]

    if len(remainder) > min_chunk_chars:
        newline_parts = _NEWLINE_SPLIT_RE.split(remainder)
        rebuilt = ""
        for part in newline_parts:
            part = part.strip()
            if not part:
                continue
            candidate = (rebuilt + " " + part).strip() if rebuilt else part
            if len(candidate) >= min_chunk_chars:
                chunks.append(candidate)
                rebuilt = ""
            else:
                rebuilt = candidate
        remainder = rebuilt

    if len(remainder) > max_buffer_chars:
        clause_matches = list(_CLAUSE_RE.finditer(remainder))
        if clause_matches:
            split_at = clause_matches[-1].end()
            chunk = remainder[:split_at].strip()
            if chunk and len(chunk) >= min_chunk_chars:
                chunks.append(chunk)
                remainder = remainder[split_at:]

    return chunks, remainder
