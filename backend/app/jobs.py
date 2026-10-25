"""One isolated, time-bounded CV worker; durable terminal states and restart recovery."""
from __future__ import annotations

import json
import multiprocessing
import shutil
import threading
import time
import uuid
from pathlib import Path

from PIL import Image

from .media import MediaError, save_image_assets
from .storage import Storage

STITCH_TIMEOUT_SECONDS = 120


def _stitch_worker(paths: list[str], output: str, report: str) -> None:
    """Spawn target intentionally lives outside main: no default-app side effects."""
    try:
        from .stitching import StitchError, stitch_images
        try:
            metadata = stitch_images([Path(path) for path in paths], Path(output))
            result = {"ok": True, "metadata": metadata}
        except StitchError as error:
            result = {"ok": False, "error": str(error)}
    except Exception:
        result = {"ok": False, "error": "Не удалось обработать серию. Проверьте перекрытие кадров и повторите съёмку из одной точки."}
    Path(report).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")


class JobManager:
    def __init__(self, storage: Storage):
        self.storage = storage
        self.directory = storage.path.parent / "media" / "jobs"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.thread: threading.Thread | None = None

    def recover(self) -> None:
        self.storage.recover_jobs()
        for directory in self.directory.iterdir():
            if directory.is_dir() and len(directory.name) == 32 and all(char in "0123456789abcdef" for char in directory.name):
                self.discard(directory)

    def reserve(self) -> bool:
        return not self.stopping.is_set() and self.lock.acquire(blocking=False)

    def release(self) -> None:
        self.lock.release()

    def new_input_directory(self) -> Path:
        directory = self.directory / uuid.uuid4().hex
        directory.mkdir()
        return directory

    def discard(self, directory: Path) -> None:
        if directory.resolve().parent != self.directory.resolve():
            raise ValueError("Job cleanup path is outside the job directory")
        shutil.rmtree(directory, ignore_errors=True)

    def submit(self, directory: Path, paths: list[Path], space_slug: str | None = None) -> dict:
        job = {"id": directory.name, "status": "queued", "progress": 0, "spaceSlug": space_slug}
        self.storage.save_job(job)
        self.thread = threading.Thread(target=self._run, args=(dict(job), directory, paths), daemon=True,
                                       name=f"stitch-{job['id']}")
        self.thread.start()
        return job

    def _run(self, job: dict, directory: Path, paths: list[Path]) -> None:
        process = None
        try:
            job.update(status="running", progress=0)
            self.storage.save_job(job)
            output, report = directory / "panorama.jpg", directory / "report.json"
            process = multiprocessing.get_context("spawn").Process(target=_stitch_worker,
                args=([str(path) for path in paths], str(output), str(report)), daemon=True)
            process.start()
            deadline = time.monotonic() + STITCH_TIMEOUT_SECONDS
            while process.is_alive():
                process.join(timeout=0.1)
                if self.stopping.is_set():
                    raise MediaError("Сшивка прервана остановкой сервера. Загрузите серию повторно.")
                if time.monotonic() > deadline:
                    raise MediaError("Сшивка превысила 2 минуты. Уменьшите число кадров или снимите серию с более выраженными деталями.")
            if process.exitcode != 0 or not report.is_file() or report.stat().st_size > 65536:
                raise MediaError("Обработка серии завершилась с ошибкой. Уменьшите размер серии и повторите.")
            result = json.loads(report.read_text(encoding="utf-8"))
            if not result["ok"]:
                raise MediaError(result["error"])
            if not output.is_file() or output.stat().st_size > 32 * 1024 * 1024:
                raise MediaError("Результат сшивки отсутствует или превышает допустимый размер. Уменьшите серию.")
            with Image.open(output) as original:
                if original.width > 8192 or original.height > 4096 or original.width * original.height > 32_000_000:
                    raise MediaError("Результат сшивки превышает допустимое разрешение. Уменьшите серию.")
                original.load()
                image = original.convert("RGB")
            asset = save_image_assets(self.storage, image, {**result["metadata"], "source": "stitched"}, job.get("spaceSlug"))
            job.update(status="succeeded", progress=100, result=asset)
        except MediaError as error:
            job.update(status="failed", progress=0, error=str(error))
        except Exception:
            job.update(status="failed", progress=0,
                       error="Не удалось сохранить результат сшивки. Проверьте свободное место и повторите загрузку.")
        finally:
            if process is not None:
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=5)
                process.close()
            try:
                self.storage.save_job(job)
            finally:
                self.discard(directory)
                self.release()

    def shutdown(self) -> None:
        self.stopping.set()
        if self.thread is not None:
            self.thread.join(timeout=10)
