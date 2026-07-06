from __future__ import annotations

import asyncio
import re
from time import perf_counter
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .audio_meta import estimate_transcription_seconds, get_audio_duration_sec
from .config import settings
from .jobs import Job, JobStatus, job_store
from .timing_log import append_timing_log
from .transcriber import TranscriptionError, transcribe_audio


app = FastAPI(title="Whisper Transcription MVP")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

base_dir = Path(__file__).resolve().parents[1]
static_dir = base_dir / "static"

if static_dir.exists():
    app.mount("/static", StaticFiles(directory=static_dir), name="static")


def _validate_content_length(request: Request) -> None:
    content_length = request.headers.get("content-length")
    if not content_length:
        return
    max_bytes = settings.max_upload_mb * 1024 * 1024
    try:
        declared_size = int(content_length)
    except ValueError:
        return
    if declared_size > max_bytes + 1024 * 4:
        raise HTTPException(
            status_code=413,
            detail={
                "code": "file_too_large",
                "message": f"Audio exceeds the {settings.max_upload_mb} MB limit.",
            },
        )


def _extract_extension(filename: str | None) -> str:
    if not filename or "." not in filename:
        return ""
    return filename.rsplit(".", 1)[-1].lower().strip()


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


def _status_message(job: Job) -> str:
    if job.status == JobStatus.QUEUED:
        return "En cola..."
    if job.status == JobStatus.PROCESSING:
        return "Transcribiendo..."
    if job.status == JobStatus.COMPLETED:
        return "Transcripcion completada"
    if job.status == JobStatus.TIMEOUT:
        return "La transcripcion excedio el tiempo limite."
    return job.error_message or "La transcripcion fallo."


def _job_payload(job: Job) -> dict[str, object]:
    elapsed = job.elapsed_seconds()
    payload: dict[str, object] = {
        "success": True,
        "job_id": job.id,
        "status": job.status.value,
        "estimated_seconds": job.estimated_seconds,
        "elapsed_seconds": round(elapsed, 1) if elapsed is not None else None,
        "progress_percent": job.progress_percent(),
        "message": _status_message(job),
        "filename": job.filename,
        "file_size_bytes": job.file_size_bytes,
        "audio_duration_sec": job.audio_duration_sec,
    }

    if job.status == JobStatus.COMPLETED and job.result is not None:
        payload["text"] = job.result.get("text")
        payload["language"] = job.result.get("language")
        payload["model"] = settings.whisper_model
        payload["backend"] = job.result.get("backend")
        payload["report"] = job.report

    if job.status in {JobStatus.FAILED, JobStatus.TIMEOUT}:
        payload["success"] = False
        payload["error"] = job.error_code or "error"
        payload["message"] = job.error_message or _status_message(job)

    return payload


async def _run_job(job_id: str) -> None:
    job = await job_store.get(job_id)
    if job is None:
        return

    await job_store.mark_processing(job_id)
    job = await job_store.get(job_id)
    if job is None:
        return

    started = perf_counter()
    try:
        result = await transcribe_audio(job.temp_path)
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
    except Exception:
        await job_store.mark_failed(
            job_id,
            code="transcription_failed",
            message="Transcription failed.",
        )
    finally:
        finished_job = await job_store.get(job_id)
        if finished_job is not None and finished_job.started_at is not None:
            append_timing_log(finished_job, model=settings.whisper_model)
        if job.temp_path.exists():
            job.temp_path.unlink(missing_ok=True)


@app.on_event("startup")
async def startup_cleanup() -> None:
    await job_store.cleanup_expired(settings.job_ttl_hours)


@app.get("/")
async def index() -> FileResponse:
    index_path = static_dir / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Missing static/index.html")
    return FileResponse(index_path)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict[str, object]:
    job = await job_store.get(job_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "job_not_found",
                "message": "Job not found.",
            },
        )
    return _job_payload(job)


@app.post("/api/transcribe", status_code=202)
async def transcribe(request: Request, audio: UploadFile = File(...)) -> dict[str, object]:
    _validate_content_length(request)

    extension = _extract_extension(audio.filename)
    if extension not in settings.allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "unsupported_format",
                "message": f"Supported formats: {', '.join(settings.allowed_extensions)}",
            },
        )

    max_bytes = settings.max_upload_mb * 1024 * 1024
    consumed = 0
    filename = audio.filename or f"upload.{extension or 'tmp'}"

    suffix = f".{extension}" if extension else ".tmp"
    with NamedTemporaryFile(delete=False, suffix=suffix, prefix="upload-") as temp:
        temp_path = Path(temp.name)

    job_created = False
    try:
        with temp_path.open("wb") as out:
            while True:
                chunk = await audio.read(1024 * 1024)
                if not chunk:
                    break
                consumed += len(chunk)
                if consumed > max_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail={
                            "code": "file_too_large",
                            "message": f"Audio exceeds the {settings.max_upload_mb} MB limit.",
                        },
                    )
                out.write(chunk)

        if consumed == 0:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "empty_file",
                    "message": "Uploaded file is empty.",
                },
            )

        audio_duration_sec = get_audio_duration_sec(temp_path)
        estimated_seconds, factor_used = estimate_transcription_seconds(
            model=settings.whisper_model,
            audio_duration_sec=audio_duration_sec,
            file_size_bytes=consumed,
        )

        job = await job_store.create(
            filename=filename,
            file_size_bytes=consumed,
            audio_duration_sec=audio_duration_sec,
            estimated_seconds=estimated_seconds,
            factor_used=factor_used,
            temp_path=temp_path,
        )
        job_created = True

        asyncio.create_task(_run_job(job.id))

        return {
            "success": True,
            "job_id": job.id,
            "status": job.status.value,
            "estimated_seconds": estimated_seconds,
            "status_url": f"/api/jobs/{job.id}",
        }
    finally:
        await audio.close()
        if not job_created and temp_path.exists():
            temp_path.unlink(missing_ok=True)


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException):
    if isinstance(exc.detail, dict):
        payload = exc.detail
    else:
        payload = {"code": "error", "message": str(exc.detail)}
    return fastapi_json_response(exc.status_code, payload)


def fastapi_json_response(status_code: int, detail: dict[str, str]):
    return JSONResponse(
        status_code=status_code,
        content={
            "success": False,
            "error": detail.get("code", "error"),
            "message": detail.get("message", "Unknown error"),
        },
    )
