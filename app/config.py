import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv_file() -> None:
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


_load_dotenv_file()


def _get_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _get_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value


@dataclass(frozen=True)
class Settings:
    max_upload_mb: int = _get_int("MAX_UPLOAD_MB", 25)
    allowed_extensions: tuple[str, ...] = tuple(
        part.strip().lower()
        for part in os.getenv("ALLOWED_EXTENSIONS", "webm,wav,m4a,mp3,ogg,flac").split(",")
        if part.strip()
    )
    whisper_model: str = os.getenv("WHISPER_MODEL", "base")
    whisper_language: str | None = os.getenv("WHISPER_LANGUAGE") or None
    whisper_timeout_sec: int = _get_int("WHISPER_TIMEOUT_SEC", 120)
    debug: bool = _get_bool("DEBUG", False)


settings = Settings()
