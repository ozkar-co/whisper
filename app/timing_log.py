from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import settings
from .jobs import Job


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def append_timing_log(job: Job, *, model: str) -> None:
    if job.started_at is None or job.finished_at is None:
        return

    actual_seconds = round((job.finished_at - job.started_at).total_seconds(), 2)
    estimated_seconds = job.estimated_seconds
    ratio = round(actual_seconds / estimated_seconds, 3) if estimated_seconds > 0 else None

    entry: dict[str, Any] = {
        "ts": _utc_iso(),
        "job_id": job.id,
        "status": job.timing_log_status(),
        "model": model,
        "audio_duration_sec": job.audio_duration_sec,
        "file_size_bytes": job.file_size_bytes,
        "estimated_seconds": estimated_seconds,
        "actual_seconds": actual_seconds,
        "ratio": ratio,
        "factor_used": job.factor_used,
    }

    log_path = Path(settings.timing_log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
