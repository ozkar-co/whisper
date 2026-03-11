# Whisper Transcription MVP

Simple private web app to upload or record audio and get transcription text using local Whisper.

## Features

- Upload audio file
- Record audio in browser (MediaRecorder)
- Transcribe with Whisper Python backend
- Max upload limit with clear validation errors

## Requirements

- Python 3.10+
- Local Whisper setup already available on your server
- ffmpeg available in PATH (usually required by Whisper)

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

## Environment Variables

- `MAX_UPLOAD_MB` (default: `25`)
- `ALLOWED_EXTENSIONS` (default: `webm,wav,m4a,mp3,ogg,flac`)
- `WHISPER_MODEL` (default: `base`)
- `WHISPER_LANGUAGE` (optional, e.g. `en`)
- `WHISPER_TIMEOUT_SEC` (default: `120`)

Example:

```bash
export WHISPER_MODEL=base
export MAX_UPLOAD_MB=25
```

## Notes

- For private server/VPN use, no auth is included.
- Supported extension check is based on filename extension.
