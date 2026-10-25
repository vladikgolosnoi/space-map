"""FastAPI application. Run from repository root: uvicorn backend.app.main:app."""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import time
from collections import defaultdict, deque
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from .delivery import BuildFiles, TextCompression

from .models import (Project, RouteRequest, RouteResult, SessionRequest, PublishRequest,
                     AccountRegisterRequest, AccountLoginRequest, SpaceCreateRequest, ViewRequest, Floor,
                     OrganizationInviteRequest, InviteAcceptRequest, MemberRoleRequest)
from .media import register_media_routes
from .offline import export_html
from .routing import NoRouteError, UnknownNodeError, shortest_route
from .storage import InvalidAsset, RevisionConflict, Storage

COOKIE_NAME = "space_session"
ACCOUNT_COOKIE = "space_account"
SESSION_SECONDS = 12 * 60 * 60
ROOT = Path(__file__).resolve().parents[2]


def create_app(db_path: str | Path | None = None, admin_password: str | None = None) -> FastAPI:
    storage = Storage(db_path or os.getenv("SPACE_DB_PATH") or ROOT / "backend" / "data" / "space.db")
    secret = storage.secret()
    password = admin_password if admin_password is not None else os.getenv("SPACE_ADMIN_PASSWORD")
    if not password:
        password_path = storage.path.parent / "admin-password.txt"
        try:
            with password_path.open("x", encoding="utf-8") as handle:
                handle.write(secrets.token_urlsafe(24))
            try:
                password_path.chmod(0o600)
            except OSError:
                pass  # Windows permissions inherit the user's private workspace ACL.
        except FileExistsError:
            pass
        password = password_path.read_text(encoding="utf-8").strip()
        if not password:
            raise RuntimeError("The administrator password file is empty")
    password_hash = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), secret, 200_000)
    signing_key = hmac.new(secret, password_hash, hashlib.sha256).digest()
    allowed_origins = {origin.rstrip("/") for origin in os.getenv("SPACE_ALLOWED_ORIGINS", "").split(",") if origin}
    failed_logins: dict[str, deque[float]] = defaultdict(deque)
    app = FastAPI(title="Карта пространства", version="0.1.0", description="Первый вертикальный сценарий; вымышленный демоцентр.")
    app.state.storage = storage
    app.add_middleware(TextCompression)

    @app.middleware("http")
    async def frame_policy(request: Request, call_next):
        response = await call_next(request)
        if request.url.path == "/embed/demo":
            response.headers["Content-Security-Policy"] = "frame-ancestors *"
        else:
            response.headers["Content-Security-Policy"] = "frame-ancestors 'self'"
            response.headers["X-Frame-Options"] = "SAMEORIGIN"
        return response

    def same_origin(request: Request) -> None:
        if request.headers.get("sec-fetch-site") == "cross-site":
            raise HTTPException(403, "Запрос с другого сайта запрещён")
        origin = request.headers.get("origin")
        if not origin:
            return  # CLI clients do not carry ambient browser cookies.
        try:
            parsed = urlsplit(origin)
        except ValueError as error:
            raise HTTPException(403, "Некорректный источник запроса") from error
        expected = f"{request.url.scheme}://{request.headers.get('host', '')}"
        valid = parsed.scheme in {"http", "https"} and parsed.netloc and not parsed.path and not parsed.query and not parsed.fragment
        if not valid or (origin != expected and origin not in allowed_origins):
            raise HTTPException(403, "Источник запроса не соответствует серверу")

    def token_hash_from_cookie(request: Request) -> str | None:
        cookie = request.cookies.get(COOKIE_NAME, "")
        try:
            token, signature = cookie.split(".", 1)
        except ValueError:
            return None
        if len(token) != 43 or len(signature) != 64:
            return None
        expected = hmac.new(signing_key, token.encode("utf-8"), hashlib.sha256).hexdigest()
        if not secrets.compare_digest(signature.encode("utf-8"), expected.encode("utf-8")):
            return None
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def authenticated(request: Request) -> bool:
        token_hash = token_hash_from_cookie(request)
        return token_hash is not None and storage.has_session(token_hash)

    def account_user(request: Request) -> dict | None:
        token = request.cookies.get(ACCOUNT_COOKIE, "")
        if len(token) != 43:
            return None
        user_id = storage.account_user_id(hashlib.sha256(token.encode("utf-8")).hexdigest())
        return storage.get_user(user_id) if user_id else None

    def set_account_cookie(request: Request, response: Response, user_id: str) -> None:
        previous = request.cookies.get(ACCOUNT_COOKIE, "")
        if len(previous) == 43:
            storage.delete_account_session(hashlib.sha256(previous.encode("utf-8")).hexdigest())
        token = secrets.token_urlsafe(32)
        storage.add_account_session(hashlib.sha256(token.encode("utf-8")).hexdigest(), user_id, time.time() + SESSION_SECONDS)
        response.set_cookie(ACCOUNT_COOKIE, token, max_age=SESSION_SECONDS, httponly=True,
                            secure=request.url.scheme == "https", samesite="strict", path="/")

    def password_digest(password: str, salt: bytes) -> str:
        return salt.hex() + "$" + hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000).hex()

    def valid_slug(slug: str) -> bool:
        return bool(re.fullmatch(r"[a-z0-9][a-z0-9-]{2,79}", slug))

    @app.get("/api/health")
    def health():
        return {"status": "ok", "version": "0.1.0"}

    @app.get("/api/session")
    def session(request: Request, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return {"authenticated": authenticated(request)}

    @app.get("/api/auth/session")
    def account_session(request: Request, response: Response):
        response.headers["Cache-Control"] = "no-store"
        user = account_user(request)
        return {"authenticated": bool(user), "user": user}

    @app.post("/api/auth/register", status_code=201)
    def register_account(body: AccountRegisterRequest, request: Request, response: Response):
        same_origin(request)
        email = body.email.strip().casefold()
        if not body.name.strip():
            raise HTTPException(422, "Введите имя")
        if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise HTTPException(422, "Введите корректный адрес электронной почты")
        peer = request.client.host if request.client else "unknown"
        attempts = failed_logins[f"register:{peer}"]
        now = time.monotonic()
        while attempts and attempts[0] < now - 60:
            attempts.popleft()
        if len(attempts) >= 5:
            raise HTTPException(429, "Слишком много регистраций. Повторите через минуту.", headers={"Retry-After": "60"})
        user_id, salt = secrets.token_hex(16), secrets.token_bytes(16)
        if not storage.create_user(user_id, email, body.name.strip(), password_digest(body.password, salt), body.organization.strip()):
            attempts.append(now)
            raise HTTPException(409, "Аккаунт с такой почтой уже существует. Войдите или восстановите пароль.")
        set_account_cookie(request, response, user_id)
        response.headers["Cache-Control"] = "no-store"
        return {"authenticated": True, "user": storage.get_user(user_id)}

    @app.post("/api/auth/login")
    def account_login(body: AccountLoginRequest, request: Request, response: Response):
        same_origin(request)
        peer = request.client.host if request.client else "unknown"
        attempts = failed_logins[f"account:{peer}"]
        now = time.monotonic()
        while attempts and attempts[0] < now - 60:
            attempts.popleft()
        if len(attempts) >= 10:
            raise HTTPException(429, "Слишком много попыток. Повторите через минуту.", headers={"Retry-After": "60"})
        user = storage.get_user_by_email(body.email.strip().casefold())
        try:
            salt_hex, _ = user["password_hash"].split("$", 1) if user else (secrets.token_hex(16), "")
            computed = password_digest(body.password, bytes.fromhex(salt_hex))
        except (ValueError, TypeError):
            computed = password_digest(body.password, bytes(16))
        if not user or not secrets.compare_digest(computed, user["password_hash"]):
            attempts.append(now)
            raise HTTPException(401, "Не удалось войти. Проверьте почту и пароль.")
        attempts.clear()
        set_account_cookie(request, response, user["id"])
        response.headers["Cache-Control"] = "no-store"
        return {"authenticated": True, "user": storage.get_user(user["id"])}

    @app.delete("/api/auth/session")
    def account_logout(request: Request, response: Response):
        same_origin(request)
        token = request.cookies.get(ACCOUNT_COOKIE, "")
        if len(token) == 43:
            storage.delete_account_session(hashlib.sha256(token.encode("utf-8")).hexdigest())
        response.delete_cookie(ACCOUNT_COOKIE, path="/", httponly=True, samesite="strict")
        response.headers["Cache-Control"] = "no-store"
        return {"authenticated": False, "user": None}

    @app.get("/api/account")
    def account_dashboard(request: Request, response: Response):
        user = account_user(request)
        if not user:
            raise HTTPException(401, "Войдите в аккаунт")
        response.headers["Cache-Control"] = "no-store"
        return {"user": user, "spaces": storage.list_spaces(user["id"]), "organizations": storage.organizations_for_user(user["id"])}

    @app.get("/api/organizations/{organization_id}/members")
    def organization_members(organization_id: str, request: Request):
        user = account_user(request)
        if not user:
            raise HTTPException(401, "Войдите в аккаунт")
        try:
            return {"members": storage.list_members(organization_id, user["id"])}
        except PermissionError as error:
            raise HTTPException(404, "Команда не найдена") from error

    @app.post("/api/organizations/invites", status_code=201)
    def create_organization_invite(body: OrganizationInviteRequest, request: Request):
        same_origin(request)
        user = account_user(request)
        if not user:
            raise HTTPException(401, "Войдите в аккаунт")
        email = body.email.strip().casefold()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise HTTPException(422, "Введите корректный адрес электронной почты")
        token = secrets.token_urlsafe(32)
        try:
            storage.create_invite(body.organizationId, user["id"], email, body.role,
                                  hashlib.sha256(token.encode()).hexdigest(), time.time() + 7 * 86400)
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        return {"token": token, "email": email, "role": body.role, "expiresAt": time.time() + 7 * 86400}

    @app.post("/api/organizations/invites/accept")
    def accept_organization_invite(body: InviteAcceptRequest, request: Request):
        same_origin(request)
        user = account_user(request)
        if not user:
            raise HTTPException(401, "Войдите в аккаунт, которому адресовано приглашение")
        try:
            organization = storage.accept_invite(user["id"], user["email"], hashlib.sha256(body.token.encode()).hexdigest())
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        except KeyError as error:
            raise HTTPException(404, str(error)) from error
        return {"organization": organization}

    @app.patch("/api/organizations/{organization_id}/members/{target_id}")
    def change_member_role(organization_id: str, target_id: str, body: MemberRoleRequest, request: Request):
        same_origin(request)
        user = account_user(request)
        if not user:
            raise HTTPException(401, "Войдите в аккаунт")
        try:
            storage.update_member_role(organization_id, user["id"], target_id, body.role)
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        return {"members": storage.list_members(organization_id, user["id"])}

    @app.delete("/api/organizations/{organization_id}/members/{target_id}", status_code=204)
    def remove_member(organization_id: str, target_id: str, request: Request):
        same_origin(request)
        user = account_user(request)
        if not user:
            raise HTTPException(401, "Войдите в аккаунт")
        try:
            storage.remove_member(organization_id, user["id"], target_id)
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        return Response(status_code=204)

    @app.post("/api/spaces", status_code=201)
    def create_space(body: SpaceCreateRequest, request: Request):
        same_origin(request)
        user = account_user(request)
        if not user:
            raise HTTPException(401, "Войдите, чтобы создать пространство")
        if not body.title.strip():
            raise HTTPException(422, "Введите название пространства")
        slug = "space-" + secrets.token_hex(8)
        project = Project(id=slug, slug=slug, title=body.title.strip(), revision=1,
                          floors=[Floor(id="floor-1", name="1 этаж", level=1,
                                        width=1000, height=700, metersPerUnit=0.08)])
        try:
            storage.create_space(user["id"], project, body.organizationId)
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        return project

    @app.get("/api/spaces/{slug}", response_model=Project)
    def get_space(slug: str, request: Request, response: Response, view: str = "published"):
        if not valid_slug(slug):
            raise HTTPException(404, "Карта не найдена")
        record = storage.get_space(slug)
        user = account_user(request)
        member = bool(record and user and storage.can_access_space(user["id"], slug))
        if not record or (not member and not record["is_public"]):
            raise HTTPException(404, "Карта не найдена или ещё не опубликована")
        response.headers["Cache-Control"] = "no-store"
        if view == "draft" and not member:
            raise HTTPException(401, "Войдите, чтобы открыть черновик")
        if view == "draft" and member:
            return Project.model_validate_json(record["document"])
        if not record["published_document"]:
            raise HTTPException(404, "Карта ещё не опубликована")
        return Project.model_validate_json(record["published_document"])

    @app.put("/api/spaces/{slug}", response_model=Project)
    def put_space(slug: str, project: Project, request: Request):
        same_origin(request)
        user = account_user(request)
        if not user:
            raise HTTPException(401, "Войдите, чтобы редактировать карту")
        if project.slug != slug or project.id != slug:
            raise HTTPException(422, "Идентификатор карты не совпадает с адресом")
        try:
            return storage.save_space(user["id"], project)
        except KeyError as error:
            raise HTTPException(404, "Карта не найдена") from error
        except RevisionConflict as error:
            raise HTTPException(409, str(error)) from error
        except InvalidAsset as error:
            raise HTTPException(422, str(error)) from error

    @app.post("/api/spaces/{slug}/publish", response_model=Project)
    def publish_space(slug: str, body: PublishRequest, request: Request):
        same_origin(request)
        user = account_user(request)
        if not user:
            raise HTTPException(401, "Войдите, чтобы опубликовать карту")
        try:
            return storage.publish_space(user["id"], slug, body.revision)
        except KeyError as error:
            raise HTTPException(404, "Карта не найдена") from error
        except RevisionConflict as error:
            raise HTTPException(409, str(error)) from error

    @app.post("/api/spaces/{slug}/view", status_code=204)
    def count_space_view(slug: str, body: ViewRequest, request: Request):
        same_origin(request)
        record = storage.get_space(slug) if valid_slug(slug) else None
        if not record or not record["is_public"] or not record["published_document"]:
            raise HTTPException(404, "Карта не найдена")
        view_user = account_user(request)
        if view_user and storage.can_access_space(view_user["id"], slug):
            return Response(status_code=204)
        storage.record_space_view(slug, body.visitorId)
        return Response(status_code=204)

    @app.post("/api/spaces/{slug}/route", response_model=RouteResult)
    def route_space(slug: str, body: RouteRequest, request: Request, view: str = "published"):
        record = storage.get_space(slug) if valid_slug(slug) else None
        user = account_user(request)
        member = bool(record and user and storage.can_access_space(user["id"], slug))
        if not record or (not member and not record["is_public"]):
            raise HTTPException(404, "Карта не найдена")
        if view == "draft" and not member:
            raise HTTPException(401, "Войдите, чтобы рассчитать маршрут по черновику")
        document = record["document"] if view == "draft" and member else record["published_document"]
        if not document:
            raise HTTPException(404, "Карта не опубликована")
        try:
            return shortest_route(Project.model_validate_json(document), body)
        except UnknownNodeError as error:
            raise HTTPException(422, str(error)) from error
        except NoRouteError as error:
            raise HTTPException(404, str(error)) from error

    @app.post("/api/session")
    def login(body: SessionRequest, request: Request, response: Response):
        same_origin(request)
        peer = request.client.host if request.client else "unknown"
        attempts = failed_logins[peer]
        now = time.monotonic()
        while attempts and attempts[0] < now - 60:
            attempts.popleft()
        if len(attempts) >= 10:
            raise HTTPException(429, "Слишком много попыток. Повторите через минуту.", headers={"Retry-After": "60"})
        supplied = hashlib.pbkdf2_hmac("sha256", body.password.encode("utf-8"), secret, 200_000)
        if not secrets.compare_digest(supplied, password_hash):
            attempts.append(now)
            raise HTTPException(401, "Неверный пароль организатора")
        attempts.clear()
        previous_hash = token_hash_from_cookie(request)
        if previous_hash:
            storage.delete_session(previous_hash)
        token = secrets.token_urlsafe(32)
        signature = hmac.new(signing_key, token.encode("utf-8"), hashlib.sha256).hexdigest()
        storage.add_session(hashlib.sha256(token.encode("utf-8")).hexdigest(), time.time() + SESSION_SECONDS)
        response.set_cookie(COOKIE_NAME, f"{token}.{signature}", max_age=SESSION_SECONDS,
                            httponly=True, secure=request.url.scheme == "https", samesite="strict", path="/")
        response.headers["Cache-Control"] = "no-store"
        return {"authenticated": True}

    @app.delete("/api/session")
    def logout(request: Request, response: Response):
        same_origin(request)
        token_hash = token_hash_from_cookie(request)
        if token_hash:
            storage.delete_session(token_hash)
        response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="strict")
        response.headers["Cache-Control"] = "no-store"
        return {"authenticated": False}

    @app.get("/api/projects/demo", response_model=Project)
    def get_project(response: Response, request: Request, view: str = "auto"):
        response.headers["Cache-Control"] = "no-store"
        if view == "draft" and not authenticated(request):
            raise HTTPException(401, "Войдите для просмотра черновика")
        return storage.get_project() if view != "published" and authenticated(request) else storage.get_published()

    @app.post("/api/projects/demo/publish", response_model=Project)
    def publish(body: PublishRequest, request: Request, response: Response):
        same_origin(request)
        if not authenticated(request):
            raise HTTPException(401, "Войдите для публикации")
        response.headers["Cache-Control"] = "no-store"
        try:
            return storage.publish(body.revision)
        except RevisionConflict as error:
            raise HTTPException(409, str(error)) from error
        except InvalidAsset as error:
            raise HTTPException(422, str(error)) from error

    @app.put("/api/projects/demo", response_model=Project)
    def put_project(project: Project, request: Request):
        same_origin(request)
        if not authenticated(request):
            raise HTTPException(401, "Войдите как организатор, чтобы сохранить проект")
        if project.id != "demo" or project.slug != "demo":
            raise HTTPException(422, "Демо-проект должен сохранять системный адрес demo")
        try:
            return storage.save_project(project)
        except RevisionConflict as error:
            raise HTTPException(409, str(error)) from error
        except InvalidAsset as error:
            raise HTTPException(422, str(error)) from error

    @app.post("/api/projects/demo/route", response_model=RouteResult)
    def route(body: RouteRequest, request: Request, view: str = "auto"):
        if view == "draft" and not authenticated(request):
            raise HTTPException(401, "Войдите для просмотра черновика")
        try:
            project = storage.get_project() if view != "published" and authenticated(request) else storage.get_published()
            return shortest_route(project, body)
        except UnknownNodeError as error:
            raise HTTPException(422, str(error)) from error
        except NoRouteError as error:
            raise HTTPException(404, str(error)) from error

    @app.get("/api/projects/demo/offline")
    def offline_export():
        return export_html(storage, ROOT / "dist" / "offline")

    register_media_routes(app, storage, authenticated, same_origin, account_user)

    dist = ROOT / "dist"

    @app.get("/", include_in_schema=False)
    @app.get("/account", include_in_schema=False)
    @app.get("/register", include_in_schema=False)
    @app.get("/login", include_in_schema=False)
    @app.get("/map/demo", include_in_schema=False)
    @app.get("/editor/demo", include_in_schema=False)
    @app.get("/embed/demo", include_in_schema=False)
    @app.get("/map/{slug}", include_in_schema=False)
    @app.get("/editor/{slug}", include_in_schema=False)
    @app.get("/embed/{slug}", include_in_schema=False)
    def frontend():
        if (dist / "index.html").is_file():
            return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})
        return {"service": "Карта пространства", "api": "/docs", "frontend": "Run the frontend dev server or build dist"}

    if dist.is_dir():
        app.mount("/", BuildFiles(directory=dist), name="frontend-assets")
    return app


app = create_app()
