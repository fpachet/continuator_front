from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import os


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BACKEND_DIR.parent
FRONTEND_DIR = PROJECT_DIR / "frontend"
DATA_DIR = BACKEND_DIR / "data"


@dataclass(frozen=True)
class Settings:
    app_name: str
    frontend_dir: Path
    db_path: Path
    seed_midi_file: Path | None
    seed_midi_folder: Path | None


def _env_path(name: str) -> Path | None:
    raw = os.getenv(name)
    if not raw:
        return None
    return Path(raw).expanduser()


def load_settings() -> Settings:
    return Settings(
        app_name=os.getenv("CONTINUATOR_APP_NAME", "Web Continuator"),
        frontend_dir=FRONTEND_DIR,
        db_path=_env_path("CONTINUATOR_DB_PATH") or (DATA_DIR / "continuator.sqlite3"),
        seed_midi_file=_env_path("CONTINUATOR_SEED_MIDI_FILE"),
        seed_midi_folder=_env_path("CONTINUATOR_SEED_MIDI_FOLDER"),
    )
