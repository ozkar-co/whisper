from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any
from uuid import uuid4


class JobStatus(str, Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Job:
    id: str
    status: JobStatus
    created_at: datetime
    filename: str
    file_size_bytes: int
    audio_duration_sec: float | None
    estimated_seconds: float
    factor_used: float
    temp_path: Path
    started_at: datetime | None = None
    finished_at: datetime | None = None
    result: dict[str, Any] | None = None
    error_code: str | None = None
    error_message: str | None = None
    report: dict[str, Any] | None = None

    def elapsed_seconds(self, now: datetime | None = None) -> float | None:
        if self.started_at is None:
            return None
        end = self.finished_at or now or _utc_now()
        return max(0.0, (end - self.started_at).total_seconds())

    def progress_percent(self, now: datetime | None = None) -> int:
        if self.status == JobStatus.COMPLETED:
            return 100
        if self.status in {JobStatus.FAILED, JobStatus.TIMEOUT}:
            return 0
        elapsed = self.elapsed_seconds(now)
        if elapsed is None or self.estimated_seconds <= 0:
            return 0
        return min(99, round((elapsed / self.estimated_seconds) * 100))

    def timing_log_status(self) -> str:
        if self.status == JobStatus.COMPLETED:
            return "completed"
        if self.status == JobStatus.TIMEOUT:
            return "timeout"
        return "failed"


@dataclass
class JobStore:
    _jobs: dict[str, Job] = field(default_factory=dict)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def create(
        self,
        *,
        filename: str,
        file_size_bytes: int,
        audio_duration_sec: float | None,
        estimated_seconds: float,
        factor_used: float,
        temp_path: Path,
    ) -> Job:
        job = Job(
            id=str(uuid4()),
            status=JobStatus.QUEUED,
            created_at=_utc_now(),
            filename=filename,
            file_size_bytes=file_size_bytes,
            audio_duration_sec=audio_duration_sec,
            estimated_seconds=estimated_seconds,
            factor_used=factor_used,
            temp_path=temp_path,
        )
        async with self._lock:
            self._jobs[job.id] = job
        return job

    async def get(self, job_id: str) -> Job | None:
        async with self._lock:
            return self._jobs.get(job_id)

    async def mark_processing(self, job_id: str) -> Job | None:
        async with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            job.status = JobStatus.PROCESSING
            job.started_at = _utc_now()
            return job

    async def mark_completed(
        self,
        job_id: str,
        *,
        result: dict[str, Any],
        report: dict[str, Any],
    ) -> Job | None:
        async with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            job.status = JobStatus.COMPLETED
            job.finished_at = _utc_now()
            job.result = result
            job.report = report
            return job

    async def mark_failed(
        self,
        job_id: str,
        *,
        code: str,
        message: str,
        status: JobStatus = JobStatus.FAILED,
    ) -> Job | None:
        async with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            job.status = status
            job.finished_at = _utc_now()
            job.error_code = code
            job.error_message = message
            return job

    async def cleanup_expired(self, ttl_hours: int) -> list[Path]:
        if ttl_hours <= 0:
            return []
        cutoff = _utc_now().timestamp() - (ttl_hours * 3600)
        removed_paths: list[Path] = []
        async with self._lock:
            expired_ids = [
                job_id
                for job_id, job in self._jobs.items()
                if job.created_at.timestamp() < cutoff
            ]
            for job_id in expired_ids:
                job = self._jobs.pop(job_id)
                if job.temp_path.exists():
                    removed_paths.append(job.temp_path)
        for path in removed_paths:
            path.unlink(missing_ok=True)
        return removed_paths


job_store = JobStore()
