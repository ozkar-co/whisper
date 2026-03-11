#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"

if [[ ! -d "${VENV_DIR}" ]]; then
  echo "Error: no existe ${VENV_DIR}. Crea el entorno con: python3 -m venv .venv"
  exit 1
fi

# shellcheck source=/dev/null
source "${VENV_DIR}/bin/activate"

exec uvicorn app.main:app --host 0.0.0.0 --port 8001
