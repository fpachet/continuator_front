from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .admin_queries import AdminQueries
from .auth import AuthenticationError, AuthenticatedUser, AuthManager
from .storage import PhraseStorage


class CreatePasswordResetRequest(BaseModel):
    admin_password: str = Field(min_length=8, max_length=128)


class PasswordResetRequest(BaseModel):
    token: str = Field(min_length=32, max_length=128)
    password: str = Field(min_length=8, max_length=128)
    confirm_password: str = Field(min_length=8, max_length=128)


def create_admin_router(
    storage: PhraseStorage, auth_manager: AuthManager, require_admin
):
    router = APIRouter()
    queries = AdminQueries(storage)

    @router.get("/api/admin/overview", tags=["admin"])
    def overview(admin: AuthenticatedUser = Depends(require_admin)) -> dict:
        return queries.overview()

    @router.get("/api/admin/users", tags=["admin"])
    def users(
        q: str = Query(default="", max_length=64),
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        admin: AuthenticatedUser = Depends(require_admin),
    ) -> dict:
        return queries.users(q, limit, offset)

    @router.get("/api/admin/activity", tags=["admin"])
    def activity(
        limit: int = Query(default=50, ge=1, le=100),
        admin: AuthenticatedUser = Depends(require_admin),
    ) -> dict:
        return {"items": queries.activity(limit=limit)}

    @router.get("/api/admin/users/{user_id}", tags=["admin"])
    def user_detail(
        user_id: str, admin: AuthenticatedUser = Depends(require_admin)
    ) -> dict:
        detail = queries.user(user_id)
        if detail is None:
            raise HTTPException(status_code=404, detail="Unknown user.")
        return detail

    @router.post("/api/admin/users/{user_id}/password-reset", tags=["admin"])
    def password_reset_link(
        user_id: str,
        payload: CreatePasswordResetRequest,
        admin: AuthenticatedUser = Depends(require_admin),
    ) -> dict:
        with storage.transaction():
            with storage._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
            try:
                verified = auth_manager.verify_password(
                    admin.username, payload.admin_password
                )
            except AuthenticationError as error:
                raise HTTPException(
                    status_code=403,
                    detail="Your administrator password was not accepted.",
                ) from error
            if verified.id != admin.id:
                raise HTTPException(
                    status_code=403, detail="Administrator verification failed."
                )
            target = queries.identity(user_id)
            if target is None:
                raise HTTPException(status_code=404, detail="Unknown user.")
            token, expires_at = auth_manager.create_password_reset(user_id, admin.id)
        return {
            "token": token,
            "expires_at": expires_at,
            "username": target["username"],
        }

    @router.post("/api/auth/reset-password", tags=["auth"])
    def reset_password(payload: PasswordResetRequest) -> dict:
        if payload.password != payload.confirm_password:
            raise HTTPException(status_code=400, detail="The passwords do not match.")
        try:
            auth_manager.reset_password(payload.token, payload.password)
        except AuthenticationError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"ok": True}

    return router
