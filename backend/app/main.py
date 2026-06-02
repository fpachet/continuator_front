from __future__ import annotations

from fastapi import Cookie, Depends, FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .auth import (
    AUTH_COOKIE_NAME,
    AUTH_TOKEN_MAX_AGE_SECONDS,
    AuthenticationError,
    AuthManager,
    AuthenticatedUser,
    UsernameTakenError,
)
from .config import load_settings
from .continuator_runtime import continuator_runtime_info
from .schemas import (
    AuthStatusResponse,
    AuthUser,
    ContinueRequest,
    ContinueResponse,
    CreateSessionRequest,
    CreateSessionResponse,
    DownloadSessionMidiResponse,
    GeneratePhraseRequest,
    GeneratePhraseResponse,
    ImportMidiResponse,
    LoginRequest,
    LogoutResponse,
    OpenSessionResponse,
    PublicConfigResponse,
    RegisterRequest,
    ResetSessionResponse,
    SaveSessionMidiResponse,
    SessionHistoryResponse,
    SessionMemoryResponse,
    UpdateSessionNameRequest,
    UpdateSessionNameResponse,
    UpdateSessionPreferencesRequest,
    UpdateSessionPreferencesResponse,
    UpdateSessionSettingsRequest,
    UpdateSessionSettingsResponse,
    UserSessionsResponse,
)
from .session_manager import MidiImportError, NoContinuationAvailable, SessionManager, UnknownSessionError
from .storage import PhraseStorage


settings = load_settings()
storage = PhraseStorage(settings.db_path)
auth_manager = AuthManager(storage)
session_manager = SessionManager(
    storage=storage,
    seed_midi_file=settings.seed_midi_file,
    seed_midi_folder=settings.seed_midi_folder,
    session_export_dir=settings.session_export_dir,
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


def auth_user_to_schema(user: AuthenticatedUser) -> AuthUser:
    return AuthUser(id=user.id, username=user.username, created_at=user.created_at)


def set_auth_cookie(response: Response, request: Request, raw_token: str) -> None:
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=raw_token,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        max_age=AUTH_TOKEN_MAX_AGE_SECONDS,
        path="/",
    )


def clear_auth_cookie(response: Response) -> None:
    response.delete_cookie(key=AUTH_COOKIE_NAME, path="/")


def get_optional_current_user(
    auth_token: str | None = Cookie(default=None, alias=AUTH_COOKIE_NAME),
) -> AuthenticatedUser | None:
    return auth_manager.get_user_from_token(auth_token)


def require_current_user(
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> AuthenticatedUser:
    if current_user is None:
        raise HTTPException(status_code=401, detail="Sign in to access saved sessions.")
    return current_user


@app.get("/", include_in_schema=False)
def read_index() -> FileResponse:
    return FileResponse(settings.frontend_dir / "index.html")


@app.get("/health", tags=["system"])
def healthcheck() -> dict[str, object]:
    continuator = continuator_runtime_info()
    return {
        "ok": True,
        "app_name": settings.app_name,
        "seeded": session_manager.seeded,
        "continuator": continuator.model_dump(),
    }


@app.get("/api/config", response_model=PublicConfigResponse, tags=["system"])
def public_config() -> PublicConfigResponse:
    continuator = continuator_runtime_info()
    return PublicConfigResponse(
        app_name=settings.app_name,
        seeded=session_manager.seeded,
        continuator_version=continuator.version,
        continuator_package_version=continuator.package_version,
        continuator_commit=continuator.commit,
        continuator_source_url=continuator.source_url,
    )


@app.get("/api/auth/me", response_model=AuthStatusResponse, tags=["auth"])
def auth_me(
    response: Response,
    auth_token: str | None = Cookie(default=None, alias=AUTH_COOKIE_NAME),
) -> AuthStatusResponse:
    user = auth_manager.get_user_from_token(auth_token)
    if auth_token and user is None:
        clear_auth_cookie(response)
    return AuthStatusResponse(user=None if user is None else auth_user_to_schema(user))


@app.post("/api/auth/register", response_model=AuthStatusResponse, tags=["auth"])
def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
) -> AuthStatusResponse:
    try:
        user, raw_token = auth_manager.register(payload.username, payload.password)
    except UsernameTakenError as error:
        raise HTTPException(
            status_code=409,
            detail=f"Username is already taken: {error.args[0]}",
        ) from error
    set_auth_cookie(response, request, raw_token)
    return AuthStatusResponse(user=auth_user_to_schema(user))


@app.post("/api/auth/login", response_model=AuthStatusResponse, tags=["auth"])
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
) -> AuthStatusResponse:
    try:
        user, raw_token = auth_manager.login(payload.username, payload.password)
    except AuthenticationError as error:
        raise HTTPException(status_code=401, detail=str(error)) from error
    set_auth_cookie(response, request, raw_token)
    return AuthStatusResponse(user=auth_user_to_schema(user))


@app.post("/api/auth/logout", response_model=LogoutResponse, tags=["auth"])
def logout(
    response: Response,
    auth_token: str | None = Cookie(default=None, alias=AUTH_COOKIE_NAME),
) -> LogoutResponse:
    auth_manager.logout(auth_token)
    clear_auth_cookie(response)
    return LogoutResponse()


@app.post("/api/session", response_model=CreateSessionResponse, tags=["session"])
def create_session(
    payload: CreateSessionRequest,
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> CreateSessionResponse:
    return session_manager.create_session(
        payload,
        owner_user_id=None if current_user is None else current_user.id,
    )


@app.get("/api/my/sessions", response_model=UserSessionsResponse, tags=["session"])
def my_sessions(
    limit: int = Query(default=24, ge=1, le=100),
    current_user: AuthenticatedUser = Depends(require_current_user),
) -> UserSessionsResponse:
    return session_manager.list_user_sessions(current_user.id, limit=limit)


@app.post(
    "/api/my/sessions/{session_id}/open",
    response_model=OpenSessionResponse,
    tags=["session"],
)
def open_session(
    session_id: str,
    current_user: AuthenticatedUser = Depends(require_current_user),
) -> OpenSessionResponse:
    try:
        return session_manager.open_session(session_id, current_user.id)
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error


@app.patch(
    "/api/my/sessions/{session_id}/name",
    response_model=UpdateSessionNameResponse,
    tags=["session"],
)
def update_session_name(
    session_id: str,
    payload: UpdateSessionNameRequest,
    current_user: AuthenticatedUser = Depends(require_current_user),
) -> UpdateSessionNameResponse:
    try:
        return session_manager.update_session_name(session_id, current_user.id, payload)
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error


@app.patch(
    "/api/sessions/{session_id}/preferences",
    response_model=UpdateSessionPreferencesResponse,
    tags=["session"],
)
def update_session_preferences(
    session_id: str,
    payload: UpdateSessionPreferencesRequest,
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> UpdateSessionPreferencesResponse:
    try:
        return session_manager.update_session_preferences(
            session_id,
            None if current_user is None else current_user.id,
            payload,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error


@app.patch(
    "/api/sessions/{session_id}/settings",
    response_model=UpdateSessionSettingsResponse,
    tags=["session"],
)
def update_session_settings(
    session_id: str,
    payload: UpdateSessionSettingsRequest,
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> UpdateSessionSettingsResponse:
    try:
        return session_manager.update_session_settings(
            session_id,
            None if current_user is None else current_user.id,
            payload,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error


@app.post("/api/continue", response_model=ContinueResponse, tags=["continuator"])
def continue_phrase(
    payload: ContinueRequest,
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> ContinueResponse:
    try:
        return session_manager.continue_phrase(
            payload,
            None if current_user is None else current_user.id,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error
    except NoContinuationAvailable as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post(
    "/api/sessions/{session_id}/generate",
    response_model=GeneratePhraseResponse,
    tags=["continuator"],
)
def generate_phrase(
    session_id: str,
    payload: GeneratePhraseRequest,
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> GeneratePhraseResponse:
    try:
        return session_manager.generate_phrase(
            session_id,
            None if current_user is None else current_user.id,
            note_count=payload.note_count,
            enforce_start_constraint=payload.enforce_start_constraint,
            enforce_end_constraint=payload.enforce_end_constraint,
        )
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
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> SessionHistoryResponse:
    try:
        return session_manager.get_history(
            session_id,
            None if current_user is None else current_user.id,
            limit=limit,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error


@app.post(
    "/api/sessions/{session_id}/save-midi",
    response_model=SaveSessionMidiResponse,
    tags=["session"],
)
def save_session_midi(
    session_id: str,
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> SaveSessionMidiResponse:
    try:
        return session_manager.save_session_midi(
            session_id,
            None if current_user is None else current_user.id,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get(
    "/api/sessions/{session_id}/midi-download",
    response_model=DownloadSessionMidiResponse,
    tags=["session"],
)
def download_session_midi(
    session_id: str,
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> DownloadSessionMidiResponse:
    try:
        return session_manager.download_session_midi(
            session_id,
            None if current_user is None else current_user.id,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get(
    "/api/sessions/{session_id}/midi.zip",
    tags=["session"],
)
def session_midi_zip(
    session_id: str,
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> Response:
    try:
        file_name, content, payload = session_manager.session_midi_zip(
            session_id,
            None if current_user is None else current_user.id,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return Response(
        content=content,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{file_name}"',
            "X-Midi-File-Count": str(payload.file_count),
            "X-Midi-Input-File-Count": str(payload.input_file_count),
            "X-Midi-Generated-File-Count": str(payload.generated_file_count),
        },
    )


@app.get(
    "/api/sessions/{session_id}/memory",
    response_model=SessionMemoryResponse,
    tags=["session"],
)
def session_memory(
    session_id: str,
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> SessionMemoryResponse:
    try:
        return session_manager.get_memory(
            session_id,
            None if current_user is None else current_user.id,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error


@app.get(
    "/api/sessions/{session_id}/graphs/memory.svg",
    tags=["continuator"],
)
def session_memory_graph_svg(
    session_id: str,
    max_nodes: int = Query(default=96, ge=8, le=240),
    max_edges: int = Query(default=220, ge=1, le=600),
    mode: str = Query(default="slice", pattern="^(slice|all|most_used|neighborhood)$"),
    order: int | None = Query(default=None, ge=1, le=16),
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> Response:
    try:
        svg = session_manager.render_memory_graph_svg(
            session_id,
            None if current_user is None else current_user.id,
            max_nodes=max_nodes,
            max_edges=max_edges,
            graph_mode=mode,
            order_filter=order,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error
    return Response(content=svg, media_type="image/svg+xml")


@app.get(
    "/api/sessions/{session_id}/graphs/constraints.svg",
    tags=["continuator"],
)
def session_constraint_graph_svg(
    session_id: str,
    max_steps: int = Query(default=96, ge=1, le=240),
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> Response:
    try:
        svg = session_manager.render_constraint_graph_svg(
            session_id,
            None if current_user is None else current_user.id,
            max_steps=max_steps,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error
    return Response(content=svg, media_type="image/svg+xml")


@app.get(
    "/api/sessions/{session_id}/graph.svg",
    tags=["continuator"],
)
def session_graph_svg_legacy(
    session_id: str,
    max_nodes: int = Query(default=96, ge=8, le=240),
    max_edges: int = Query(default=220, ge=1, le=600),
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> Response:
    return session_memory_graph_svg(
        session_id,
        max_nodes=max_nodes,
        max_edges=max_edges,
        current_user=current_user,
    )


@app.delete(
    "/api/sessions/{session_id}/memory/{slot}",
    response_model=SessionMemoryResponse,
    tags=["session"],
)
def delete_session_memory_phrase(
    session_id: str,
    slot: int,
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> SessionMemoryResponse:
    try:
        return session_manager.delete_memory_phrase(
            session_id,
            None if current_user is None else current_user.id,
            slot,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post(
    "/api/sessions/{session_id}/import-midi",
    response_model=ImportMidiResponse,
    tags=["session"],
)
async def import_session_midi(
    session_id: str,
    files: list[UploadFile] = File(...),
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> ImportMidiResponse:
    uploaded_files: list[tuple[str, bytes]] = []
    try:
        for index, upload in enumerate(files):
            file_name = upload.filename or f"imported_{index + 1}.mid"
            uploaded_files.append((file_name, await upload.read()))
        return session_manager.import_midi_files(
            session_id,
            None if current_user is None else current_user.id,
            uploaded_files,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error
    except MidiImportError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    finally:
        for upload in files:
            await upload.close()


@app.post(
    "/api/sessions/{session_id}/reset",
    response_model=ResetSessionResponse,
    tags=["session"],
)
def reset_session(
    session_id: str,
    current_user: AuthenticatedUser | None = Depends(get_optional_current_user),
) -> ResetSessionResponse:
    try:
        return session_manager.reset_session(
            session_id,
            None if current_user is None else current_user.id,
        )
    except UnknownSessionError as error:
        raise HTTPException(status_code=404, detail=f"Unknown session: {error.args[0]}") from error
