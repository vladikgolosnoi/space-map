"""Bounded local image ingestion. No submitted filenames or URLs become paths."""
from __future__ import annotations

import asyncio
import io
import math
import re
import uuid
import warnings
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.datastructures import UploadFile

from .storage import Storage

MAX_BODY = 64 * 1024 * 1024
MAX_FILE = 12 * 1024 * 1024
ASSET_ID = re.compile(r"^[a-f0-9]{32}$")


class MediaError(ValueError):
    pass


def read_image(content: bytes, *, stitching: bool = False) -> Image.Image:
    """Inspect headers before decoding; remove EXIF/GPS and normalize orientation."""
    if len(content) > MAX_FILE:
        raise MediaError("Один файл превышает 12 МБ. Уменьшите его размер и повторите.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as original:
                if original.format not in {"JPEG", "PNG"}:
                    raise MediaError("Поддерживаются только фотографии JPEG и PNG.")
                width, height = original.size
                pixel_limit = 24_000_000 if stitching else 32_000_000
                if width * height > pixel_limit:
                    raise MediaError(f"Изображение превышает {pixel_limit // 1_000_000} Мп. Уменьшите разрешение.")
                if width < 64 or height < 32:
                    raise MediaError("Изображение слишком маленькое. Используйте исходную фотографию.")
                original.load()
                image = ImageOps.exif_transpose(original).convert("RGB")
        if stitching:
            image.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        elif image.width > 8192 or image.height > 4096:
            raise MediaError("Панорама должна быть не больше 8192 × 4096 пикселей.")
        return image
    except MediaError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise MediaError("Не удалось прочитать изображение. Проверьте JPEG/PNG и загрузите файл снова.") from error


def validate_projection(width: int, height: int, haov: float, vaov: float, offset: float) -> None:
    if not all(math.isfinite(value) for value in (haov, vaov, offset)):
        raise MediaError("Углы обзора должны быть конечными числами.")
    if not (0 < haov <= 360 and 0 < vaov <= 180 and abs(offset) + vaov / 2 <= 90.01):
        raise MediaError("Проверьте углы: горизонталь 0–360°, вертикаль 0–180°; кадр не должен выходить за полюса.")
    if not math.isclose(width / height, haov / vaov, rel_tol=0.04, abs_tol=0.01):
        raise MediaError("Пропорции файла не соответствуют углам сферической проекции. Для полной сферы нужен формат 2:1; для частичной укажите реальный обзор.")


def save_image_assets(storage: Storage, image: Image.Image, metadata: dict, space_slug: str | None = None) -> dict:
    """Store stripped, reencoded JPEGs and commit the pair atomically in SQLite."""
    validate_projection(image.width, image.height, metadata["haov"], metadata["vaov"], metadata["vOffset"])
    if image.width > 8192 or image.height > 4096 or image.width * image.height > 32_000_000:
        raise MediaError("Результат слишком большой. Используйте серию меньшего разрешения.")
    directory = storage.path.parent / "media"
    directory.mkdir(parents=True, exist_ok=True)
    asset_id, thumbnail_id = uuid.uuid4().hex, uuid.uuid4().hex
    result = {"assetId": asset_id, "thumbnailId": thumbnail_id,
              "width": image.width, "height": image.height,
              "haov": metadata["haov"], "vaov": metadata["vaov"], "vOffset": metadata["vOffset"],
              "projection": "equirectangular", "source": metadata["source"],
              "warnings": metadata.get("warnings", [])}
    for key in ("sourceCount", "usedImageCount"):
        if key in metadata:
            result[key] = metadata[key]
    panorama_file, thumbnail_file = directory / f"{asset_id}.jpg", directory / f"{thumbnail_id}.jpg"
    try:
        image.save(panorama_file, "JPEG", quality=90)
        thumbnail = image.copy()
        thumbnail.thumbnail((640, 320), Image.Resampling.LANCZOS)
        thumbnail.save(thumbnail_file, "JPEG", quality=80)
        storage.add_assets([
            (asset_id, panorama_file.name, {**result, "role": "panorama"}),
            (thumbnail_id, thumbnail_file.name, {"role": "thumbnail", "parentId": asset_id}),
        ], space_slug)
    except Exception:
        panorama_file.unlink(missing_ok=True)
        thumbnail_file.unlink(missing_ok=True)
        raise
    return result


class UploadGuard:
    """Check authorization before multipart parsing; bound bytes including chunked bodies."""
    def __init__(self, app, authenticated, same_origin, can_upload):
        self.app, self.authenticated, self.same_origin, self.can_upload = app, authenticated, same_origin, can_upload

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] not in {"/api/panorama-import", "/api/stitch-jobs", "/api/plan-import"}:
            return await self.app(scope, receive, send)
        request = Request(scope)
        try:
            self.same_origin(request)
            if not self.can_upload(request):
                raise HTTPException(401, "Войдите в аккаунт владельца пространства, чтобы загрузить файлы")
            length = request.headers.get("content-length")
            if length is not None and (not length.isdecimal() or int(length) > MAX_BODY):
                raise HTTPException(413, "Загрузка превышает 64 МБ. Уменьшите число или размер фотографий.")
        except HTTPException as error:
            return await JSONResponse({"detail": error.detail}, status_code=error.status_code)(scope, receive, send)

        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_BODY:
                    raise HTTPException(413, "Загрузка превышает 64 МБ. Уменьшите число или размер фотографий.")
            return message

        await self.app(scope, limited_receive, send)


def register_media_routes(app, storage: Storage, authenticated, same_origin, account_user) -> None:
    from .jobs import JobManager

    manager = JobManager(storage)
    app.state.jobs = manager
    def space_scope(request: Request) -> str | None:
        slug = request.query_params.get("space")
        if not slug:
            return None
        user = account_user(request)
        record = storage.get_space(slug)
        if not user or not record or not storage.can_access_space(user["id"], slug, "write"):
            raise HTTPException(404, "Пространство не найдено")
        return slug

    def can_upload(request: Request) -> bool:
        try:
            if space_scope(request):
                return True
        except HTTPException:
            return False
        return authenticated(request)

    app.add_middleware(UploadGuard, authenticated=authenticated, same_origin=same_origin, can_upload=can_upload)

    @asynccontextmanager
    async def lifespan(_app):
        manager.recover()
        yield
        await asyncio.to_thread(manager.shutdown)

    app.router.lifespan_context = lifespan

    @app.get("/api/assets/{asset_id}")
    def get_asset(asset_id: str, request: Request):
        if not ASSET_ID.fullmatch(asset_id):
            raise HTTPException(404, "Изображение не найдено")
        record = storage.get_asset(asset_id)
        asset_space = storage.asset_space_slug(asset_id) if record else None
        owner = account_user(request)
        owns_space_asset = bool(asset_space and owner and storage.can_access_space(owner["id"], asset_space))
        public_asset = bool(record and storage.asset_is_public(asset_id))
        authorized = owns_space_asset if asset_space else authenticated(request)
        if not record or (not authorized and not public_asset):
            raise HTTPException(404, "Изображение не найдено")
        path = storage.path.parent / "media" / record[0]
        if not path.is_file():
            raise HTTPException(404, "Файл изображения отсутствует. Организатор может загрузить его заново.")
        return FileResponse(path, media_type="image/jpeg", headers={
            "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})

    @app.post("/api/plan-import", status_code=201)
    async def import_plan(request: Request):
        try:
            owner_slug = space_scope(request)
        except HTTPException as error:
            raise error
        if not owner_slug and not authenticated(request):
            raise HTTPException(401, "Войдите как организатор, чтобы загрузить план")
        try:
            async with request.form(max_files=1, max_fields=0) as form:
                upload = form.get("file")
                if not isinstance(upload, UploadFile):
                    raise MediaError("Выберите план в JPEG или PNG.")
                image = await asyncio.to_thread(read_image, await upload.read(MAX_FILE + 1))
                asset_id = uuid.uuid4().hex
                directory = storage.path.parent / "media"
                directory.mkdir(parents=True, exist_ok=True)
                path = directory / f"{asset_id}.jpg"
                try:
                    await asyncio.to_thread(image.save, path, "JPEG", quality=92)
                    storage.add_assets([(asset_id, path.name, {"role": "plan", "width": image.width, "height": image.height})], owner_slug)
                except Exception:
                    path.unlink(missing_ok=True)
                    raise
                return {"assetId": asset_id, "width": image.width, "height": image.height}
        except MediaError as error:
            raise HTTPException(422, str(error)) from error

    @app.post("/api/panorama-import", status_code=201)
    async def import_panorama(request: Request):
        try:
            owner_slug = space_scope(request)
        except HTTPException as error:
            raise error
        if not owner_slug and not authenticated(request):
            raise HTTPException(401, "Войдите как организатор, чтобы загрузить панораму")
        try:
            async with request.form(max_files=1, max_fields=3) as form:
                upload = form.get("file")
                if not isinstance(upload, UploadFile):
                    raise MediaError("Выберите файл JPEG или PNG.")
                try:
                    haov, vaov, offset = (float(form[key]) for key in ("haov", "vaov", "vOffset"))
                except (KeyError, TypeError, ValueError):
                    raise MediaError("Укажите горизонтальный и вертикальный обзор и смещение панорамы.")
                content = await upload.read(MAX_FILE + 1)
                image = await asyncio.to_thread(read_image, content)
                metadata = {"haov": haov, "vaov": vaov, "vOffset": offset, "source": "imported", "warnings": []}
                return await asyncio.to_thread(save_image_assets, storage, image, metadata, owner_slug)
        except MediaError as error:
            raise HTTPException(422, str(error)) from error

    @app.post("/api/stitch-jobs", status_code=202)
    async def create_stitch_job(request: Request):
        try:
            owner_slug = space_scope(request)
        except HTTPException as error:
            raise error
        if not owner_slug and not authenticated(request):
            raise HTTPException(401, "Войдите как организатор, чтобы сшить фотографии")
        if not manager.reserve():
            raise HTTPException(429, "Уже выполняется сшивка. Дождитесь результата и повторите.", headers={"Retry-After": "5"})
        directory = None
        submitted = False
        try:
            directory = manager.new_input_directory()
            async with request.form(max_files=16, max_fields=0) as form:
                uploads = form.getlist("files")
                if not 2 <= len(uploads) <= 16 or any(not isinstance(item, UploadFile) for item in uploads):
                    raise MediaError("Для сшивки выберите от 2 до 16 фотографий одной точки съёмки.")
                paths = []
                for index, upload in enumerate(uploads):
                    content = await upload.read(MAX_FILE + 1)
                    image = await asyncio.to_thread(read_image, content, stitching=True)
                    path = directory / f"{index:02d}.jpg"
                    await asyncio.to_thread(image.save, path, "JPEG", quality=92)
                    paths.append(path)
            job = manager.submit(directory, paths, owner_slug)
            submitted = True
            return job
        except MediaError as error:
            raise HTTPException(422, str(error)) from error
        finally:
            if not submitted:
                if directory is not None:
                    manager.discard(directory)
                manager.release()

    @app.get("/api/stitch-jobs/{job_id}")
    def get_job(job_id: str, request: Request, space: str | None = None):
        job = storage.get_job(job_id) if ASSET_ID.fullmatch(job_id) else None
        if job is None:
            raise HTTPException(404, "Задание не найдено. Загрузите серию повторно.")
        if job.get("spaceSlug"):
            user = account_user(request)
            record = storage.get_space(job["spaceSlug"])
            if not user or not record or not storage.can_access_space(user["id"], job["spaceSlug"]) or space != job["spaceSlug"]:
                raise HTTPException(404, "Задание не найдено")
        elif not authenticated(request):
            raise HTTPException(401, "Войдите как организатор, чтобы посмотреть результат сшивки")
        return JSONResponse(job, headers={"Cache-Control": "no-store"})
