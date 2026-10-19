"""Keep embedded sign-in separate from ordinary first-party cookies.

Embedded cookies require a non-simple request header before they authenticate
an API call. Cross-origin forms cannot supply that header, and the app does
not enable cross-origin API requests.
"""

from fastapi import Request, Response

from .auth import AUTH_COOKIE_NAME, AUTH_TOKEN_MAX_AGE_SECONDS

EMBEDDED_AUTH_COOKIE_NAME = "continuator_auth_embedded"
EMBEDDED_AUTH_HEADER = "X-Continuator-Embedded"


def embedded_auth(request: Request) -> bool:
    return request.headers.get(EMBEDDED_AUTH_HEADER) == "1"


def auth_cookie_name(request: Request) -> str:
    return EMBEDDED_AUTH_COOKIE_NAME if embedded_auth(request) else AUTH_COOKIE_NAME


def auth_token_from_request(request: Request) -> str | None:
    return request.cookies.get(auth_cookie_name(request))


def _partition_cookie(response: Response) -> None:
    # Python 3.12's SimpleCookie rejects Partitioned; Starlette's corresponding
    # argument requires Python 3.14. Append this fixed flag after Starlette has
    # safely serialized the cookie value and all the standard attributes.
    name, value = response.raw_headers[-1]
    assert name == b"set-cookie"
    response.raw_headers[-1] = (name, value + b"; Partitioned")


def set_auth_cookie(response: Response, request: Request, raw_token: str) -> None:
    embedded = embedded_auth(request)
    response.set_cookie(
        key=auth_cookie_name(request),
        value=raw_token,
        httponly=True,
        samesite="none" if embedded else "lax",
        secure=embedded or request.url.scheme == "https",
        max_age=AUTH_TOKEN_MAX_AGE_SECONDS,
        path="/",
    )
    if embedded:
        _partition_cookie(response)


def clear_auth_cookie(response: Response, request: Request) -> None:
    embedded = embedded_auth(request)
    response.delete_cookie(
        key=auth_cookie_name(request),
        path="/",
        secure=embedded or request.url.scheme == "https",
        httponly=True,
        samesite="none" if embedded else "lax",
    )
    if embedded:
        _partition_cookie(response)
