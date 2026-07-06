from __future__ import annotations

SELECTABLE_MODELS: tuple[str, ...] = ("tiny", "small", "medium", "large")
DEFAULT_MODEL = "small"


def normalize_model(model: str | None) -> str:
    normalized = (model or DEFAULT_MODEL).strip().lower()
    if normalized not in SELECTABLE_MODELS:
        allowed = ", ".join(SELECTABLE_MODELS)
        raise ValueError(f"Unsupported model. Allowed: {allowed}")
    return normalized
