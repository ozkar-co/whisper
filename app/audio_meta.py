from __future__ import annotations

import subprocess
from pathlib import Path

from .config import settings


MODEL_REALTIME_FACTORS: dict[str, float] = {
    "tiny": 0.5,
    "base": 1.0,
    "small": 1.5,
    "medium": 3.0,
    "large": 5.0,
    "large-v2": 5.0,
    "large-v3": 5.0,
}


def get_audio_duration_sec(audio_path: Path) -> float | None:
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(audio_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None

    if result.returncode != 0:
        return None

    raw = result.stdout.strip()
    if not raw:
        return None

    try:
        duration = float(raw)
    except ValueError:
        return None

    if duration <= 0:
        return None
    return duration


def get_realtime_factor(model: str) -> float:
    if settings.estimated_realtime_factor is not None:
        return settings.estimated_realtime_factor
    return MODEL_REALTIME_FACTORS.get(model, 1.0)


def estimate_transcription_seconds(
    *,
    model: str,
    audio_duration_sec: float | None,
    file_size_bytes: int,
) -> tuple[float, float]:
    factor = get_realtime_factor(model)

    if audio_duration_sec is not None:
        estimated = audio_duration_sec * factor + settings.model_load_buffer_sec
        return round(estimated, 1), factor

    file_size_mb = file_size_bytes / (1024 * 1024)
    estimated = max(60.0, file_size_mb * 20.0)
    return round(estimated, 1), factor
