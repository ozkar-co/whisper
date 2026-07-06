from __future__ import annotations

import asyncio
import re
from time import perf_counter

from .config import settings
from .jobs import JobStatus, job_store
from .timing_log import append_timing_log
from .transcriber import TranscriptionError, transcribe_audio


def _format_bytes(size_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    value = float(size_bytes)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.2f} {unit}"
        value /= 1024
    return f"{size_bytes} B"


def _text_stats(text: str) -> dict[str, int]:
    words = len(re.findall(r"\S+", text))
    characters = len(text)
    characters_no_spaces = len(re.sub(r"\s+", "", text))
    lines = len(text.splitlines()) if text else 0
    return {
        "words": words,
        "characters": characters,
        "characters_no_spaces": characters_no_spaces,
        "lines": lines,
    }


async def process_job(job_id: str) -> None:
    job = await job_store.get(job_id)
    if job is None:
        return

    if not job.temp_path.exists():
        await job_store.mark_failed(
            job_id,
            code="missing_audio",
            message="Audio file is missing.",
        )
        return

    await job_store.mark_processing(job_id)
    job = await job_store.get(job_id)
    if job is None:
        return

    temp_path = job.temp_path
    started = perf_counter()
    try:
        result = await transcribe_audio(temp_path)
        elapsed_ms = int((perf_counter() - started) * 1000)
        text = result["text"]
        report = {
            "file_size_bytes": job.file_size_bytes,
            "file_size_human": _format_bytes(job.file_size_bytes),
            "transcription_ms": elapsed_ms,
            "transcription_seconds": round(elapsed_ms / 1000, 2),
            "text_stats": _text_stats(text),
        }
        await job_store.mark_completed(job_id, result=result, report=report)
    except TranscriptionError as exc:
        status = JobStatus.TIMEOUT if exc.code == "timeout" else JobStatus.FAILED
        await job_store.mark_failed(job_id, code=exc.code, message=exc.message, status=status)
    except Exception as exc:
        await job_store.mark_failed(
            job_id,
            code="transcription_failed",
            message=str(exc) or "Transcription failed.",
        )
    finally:
        finished_job = await job_store.get(job_id)
        if finished_job is not None and finished_job.started_at is not None:
            append_timing_log(finished_job, model=settings.whisper_model)
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


class TranscriptionWorker:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def enqueue(self, job_id: str) -> None:
        await self._queue.put(job_id)

    async def _loop(self) -> None:
        while True:
            job_id = await self._queue.get()
            try:
                await process_job(job_id)
            finally:
                self._queue.task_done()


transcription_worker = TranscriptionWorker()
