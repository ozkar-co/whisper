from __future__ import annotations

from .jobs import JobStatus, job_store


async def get_queue_wait_seconds() -> tuple[int, float]:
    jobs = await job_store.list_all()
    wait_seconds = 0.0
    queue_count = 0

    for job in jobs:
        if job.status == JobStatus.PROCESSING:
            elapsed = job.elapsed_seconds() or 0.0
            wait_seconds += max(0.0, job.estimated_seconds - elapsed)
        elif job.status == JobStatus.QUEUED:
            queue_count += 1
            wait_seconds += job.estimated_seconds

    return queue_count, round(wait_seconds, 1)
