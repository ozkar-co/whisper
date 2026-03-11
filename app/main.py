from __future__ import annotations

import re
from time import perf_counter
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
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


@app.get("/")
async def index() -> FileResponse:
    index_path = static_dir / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Missing static/index.html")
    return FileResponse(index_path)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/transcribe")
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

    suffix = f".{extension}" if extension else ".tmp"
    with NamedTemporaryFile(delete=False, suffix=suffix, prefix="upload-") as temp:
        temp_path = Path(temp.name)

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

        started = perf_counter()
        try:
            result = await transcribe_audio(temp_path)
        except TranscriptionError as exc:
            raise HTTPException(
                status_code=500 if exc.code in {"transcription_failed", "timeout", "python_backend_unavailable"} else 400,
                detail={"code": exc.code, "message": exc.message},
            ) from exc
        elapsed_ms = int((perf_counter() - started) * 1000)
        text = result["text"]

        return {
            "success": True,
            "text": text,
            "language": result.get("language"),
            "model": settings.whisper_model,
            "backend": result.get("backend"),
            "report": {
                "file_size_bytes": consumed,
                "file_size_human": _format_bytes(consumed),
                "transcription_ms": elapsed_ms,
                "transcription_seconds": round(elapsed_ms / 1000, 2),
                "text_stats": _text_stats(text),
            },
        }
    finally:
        await audio.close()
        if temp_path.exists():
            temp_path.unlink(missing_ok=True)


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException):
    if isinstance(exc.detail, dict):
        payload = exc.detail
    else:
        payload = {"code": "error", "message": str(exc.detail)}
    return fastapi_json_response(exc.status_code, payload)


def fastapi_json_response(status_code: int, detail: dict[str, str]):
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=status_code,
        content={
            "success": False,
            "error": detail.get("code", "error"),
            "message": detail.get("message", "Unknown error"),
        },
    )
