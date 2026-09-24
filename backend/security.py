import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Callable

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import InvalidTokenError
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import get_db
from .models import User


TOKEN_SECRET = os.getenv("TOKEN_SECRET", "development-only-change-this-secret")
TOKEN_ALGORITHM = "HS256"
TOKEN_MINUTES = int(os.getenv("TOKEN_MINUTES", "480"))
bearer = HTTPBearer(auto_error=False)


def hash_password(password: str, iterations: int = 310_000) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2_sha256${iterations}${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt, expected = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt), int(iterations))
        return hmac.compare_digest(base64.b64encode(digest).decode(), expected)
    except (ValueError, TypeError):
        return False


def create_access_token(user: User, portal_state: str | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": user.username, "name": user.display_name, "role": user.role, "iat": now, "exp": now + timedelta(minutes=TOKEN_MINUTES)}
    # Only meaningful for a national (state is None) account: which state's portal URL they
    # signed in through, carried in the token so it survives across requests without another
    # DB column - a state-scoped account's own state always wins regardless of this.
    if portal_state:
        payload["portal_state"] = portal_state
    return jwt.encode(payload, TOKEN_SECRET, algorithm=TOKEN_ALGORITHM)


def get_current_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)) -> User:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required", headers={"WWW-Authenticate": "Bearer"})
    try:
        payload = jwt.decode(credentials.credentials, TOKEN_SECRET, algorithms=[TOKEN_ALGORITHM])
        username = payload.get("sub")
    except InvalidTokenError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session") from exc
    user = db.scalar(select(User).where(User.username == username, User.active.is_(True)))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User is inactive or unavailable")
    # Not a mapped column - never persisted, just carried for this request so effective_state()
    # can see which portal a national account signed in through.
    user.session_state = payload.get("portal_state")
    return user


def effective_state(user: User) -> str | None:
    """The state every scoping check should use: a state-scoped account's own state always
    wins; a national account (state is None) is confined to whichever state's portal they
    signed in through, if any - see create_access_token/get_current_user."""
    return user.state or getattr(user, "session_state", None)


def require_roles(*roles: str) -> Callable:
    def dependency(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Your role does not permit this action")
        return user
    return dependency

