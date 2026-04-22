from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import load_settings
from .schemas import (
    ContinueRequest,
    ContinueResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    PublicConfigResponse,
    ResetSessionResponse,
    SessionHistoryResponse,
    SessionMemoryResponse,
    UpdateSessionSettingsRequest,
    UpdateSessionSettingsResponse,
)
from .session_manager import NoContinuationAvailable, SessionManager, UnknownSessionError
from .storage import PhraseStorage


settings = load_settings()
storage = PhraseStorage(settings.db_path)
session_manager = SessionManager(
    storage=storage,
    seed_midi_file=settings.seed_midi_file,
    seed_midi_folder=settings.seed_midi_folder,
)


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description=(
        "A lightweight web wrapper around François Pachet's Continuator, with "
        "browser-side MIDI capture, session-isolated engines, and SQLite logging."
    ),
)

app.mount("/assets", StaticFiles(directory=settings.frontend_dir), name="assets")


@app.get("/", include_in_schema=False)
def read_index() -> FileResponse:
    return FileResponse(settings.frontend_dir / "index.html")


@app.get("/health", tags=["system"])
def healthcheck() -> dict[str, object]:
    return {
        "ok": True,
        "app_name": settings.app_name,
        "seeded": session_manager.seeded,
    }


@app.get("/api/config", response_model=PublicConfigResponse, tags=["system"])
def public_config() -> PublicConfigResponse:
    return PublicConfigResponse(
        app_name=settings.app_name,
        seeded=session_manager.seeded,
    )


@app.post("/api/session", response_model=CreateSessionResponse, tags=["session"])
def create_session(payload: CreateSessionRequest) -> CreateSessionResponse:
    return session_manager.create_session(payload)


@app.patch(
    "/api/sessions/{session_id}/settings",
    response_model=UpdateSessionSettingsResponse,
    tags=["session"],
)
def update_session_settings(
    session_id: str,
    payload: UpdateSessionSettingsRequest,
) -> UpdateSessionSettingsResponse:
    try:
        return session_manager.update_session_settings(session_id, payload)
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error


@app.post("/api/continue", response_model=ContinueResponse, tags=["continuator"])
def continue_phrase(payload: ContinueRequest) -> ContinueResponse:
    try:
        return session_manager.continue_phrase(payload)
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error
    except NoContinuationAvailable as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get(
    "/api/sessions/{session_id}/history",
    response_model=SessionHistoryResponse,
    tags=["session"],
)
def session_history(
    session_id: str,
    limit: int = Query(default=12, ge=1, le=100),
) -> SessionHistoryResponse:
    try:
        return session_manager.get_history(session_id, limit=limit)
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error


@app.get(
    "/api/sessions/{session_id}/memory",
    response_model=SessionMemoryResponse,
    tags=["session"],
)
def session_memory(session_id: str) -> SessionMemoryResponse:
    try:
        return session_manager.get_memory(session_id)
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error


@app.post(
    "/api/sessions/{session_id}/reset",
    response_model=ResetSessionResponse,
    tags=["session"],
)
def reset_session(session_id: str) -> ResetSessionResponse:
    try:
        return session_manager.reset_session(session_id)
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error
