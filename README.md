# Whisper Transcription MVP

Simple private web app to upload or record audio and get transcription text using local Whisper.

## Features

- Upload audio file
- Record audio in browser (MediaRecorder)
- Transcribe with Whisper Python backend (async background jobs)
- Recover in-progress transcriptions via `/?job=<id>`
- Estimated progress bar and elapsed-time timer
- Max upload limit with clear validation errors
- Timing log (estimated vs actual) for heuristic calibration

## Requirements

- Python 3.10+
- Local Whisper setup already available on your server
- ffmpeg and ffprobe available in PATH (required by Whisper and duration detection)

## Setup

1. Create and activate a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Run the app:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8001
```

4. Open in browser:

```text
http://SERVER_IP:8001
```

## Healthcheck

- `GET /health`
- Expected response:

```json
{"status":"ok"}
```

Quick check:

```bash
curl http://SERVER_IP:8001/health
```

## API

### Start transcription

- `POST /api/transcribe` (multipart field: `audio`)
- Returns **202 Accepted**:

```json
{
  "success": true,
  "job_id": "uuid",
  "status": "queued",
  "estimated_seconds": 145,
  "status_url": "/api/jobs/uuid"
}
```

### Poll job status

- `GET /api/jobs/{job_id}`

While processing:

```json
{
  "success": true,
  "job_id": "uuid",
  "status": "processing",
  "elapsed_seconds": 42.3,
  "estimated_seconds": 145,
  "progress_percent": 29,
  "message": "Transcribiendo..."
}
```

When completed, includes `text`, `language`, `model`, and `report` (same shape as before).

### Recover a job in the browser

Open or bookmark:

```text
http://SERVER_IP:8001/?job=<job_id>
```

The UI resumes polling until the job finishes.

## Environment Variables

- `MAX_UPLOAD_MB` (default: `25`)
- `ALLOWED_EXTENSIONS` (default: `webm,wav,m4a,mp3,ogg,flac`)
- `WHISPER_MODEL` (default: `base`)
- `WHISPER_LANGUAGE` (optional, e.g. `en`)
- `WHISPER_TIMEOUT_SEC` (default: `1800`; `0` = unlimited)
- `ESTIMATED_REALTIME_FACTOR` (optional override for time estimates)
- `MODEL_LOAD_BUFFER_SEC` (default: `10`)
- `JOB_TTL_HOURS` (default: `24`)
- `TIMING_LOG_PATH` (default: `data/timing_log.jsonl`)

Example:

```bash
export WHISPER_MODEL=base
export MAX_UPLOAD_MB=25
export WHISPER_TIMEOUT_SEC=1800
```

## Timing log (estimated vs actual)

Each finished job appends one JSON line to `data/timing_log.jsonl`:

```json
{
  "ts": "2026-07-06T18:30:00Z",
  "job_id": "...",
  "status": "completed",
  "model": "base",
  "audio_duration_sec": 120.5,
  "file_size_bytes": 1048576,
  "estimated_seconds": 130.5,
  "actual_seconds": 98.2,
  "ratio": 0.75,
  "factor_used": 1.0
}
```

With enough samples, compute the median `ratio` (or `actual_seconds / audio_duration_sec`) per model and adjust `ESTIMATED_REALTIME_FACTOR` or the built-in factors in `app/audio_meta.py`.

Progress shown in the UI is **estimated** from elapsed time vs predicted duration — Whisper does not expose real segment progress.

## Notes

- For private server/VPN use, no auth is included.
- Supported extension check is based on filename extension.
- Jobs are stored in memory; a server restart clears in-flight jobs (the timing log on disk is kept).
