from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from .config import settings


class TranscriptionError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


_model_cache: dict[str, Any] = {}


def _transcribe_with_python_sync(audio_path: Path) -> dict[str, str | None]:
    try:
        import whisper  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise TranscriptionError("python_backend_unavailable", "Python Whisper backend is unavailable.") from exc

    model = _model_cache.get(settings.whisper_model)
    if model is None:
        model = whisper.load_model(settings.whisper_model)
        _model_cache[settings.whisper_model] = model

    kwargs: dict[str, Any] = {}
    if settings.whisper_language:
        kwargs["language"] = settings.whisper_language

    # Avoid noisy warning on CPU-only servers.
    try:
        import torch  # type: ignore

        kwargs["fp16"] = bool(torch.cuda.is_available())
    except Exception:
        kwargs["fp16"] = False

    result = model.transcribe(str(audio_path), **kwargs)
    text = (result.get("text") or "").strip()
    language = result.get("language")
    if not text:
        raise TranscriptionError("empty_transcription", "No speech was detected in the provided audio.")
    return {"text": text, "language": language}


async def transcribe_with_python(audio_path: Path) -> dict[str, str | None]:
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_transcribe_with_python_sync, audio_path),
            timeout=settings.whisper_timeout_sec,
        )
    except asyncio.TimeoutError as exc:
        raise TranscriptionError("timeout", "Transcription timed out.") from exc

async def transcribe_audio(audio_path: Path) -> dict[str, str | None]:
    result = await transcribe_with_python(audio_path)
    return {**result, "backend": "python"}
