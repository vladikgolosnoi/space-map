"""Rotation-camera panorama stitching; all angular dimensions come from the warper.

The caller normalizes EXIF and runs this module in a time-limited child process.
This is an estimated partial equirectangular panorama, not a calibrated survey.
"""

from __future__ import annotations

import math
from pathlib import Path

import cv2 as cv
import numpy as np

MAX_OUTPUT_PIXELS = 20_000_000
MAX_OUTPUT_WIDTH = 8192
MATCH_CONFIDENCE = 0.8


class StitchError(Exception):
    """A recoverable error whose message can be displayed to the organizer."""


def _read_image(path: Path, index: int) -> np.ndarray:
    try:
        image = cv.imdecode(np.fromfile(path, dtype=np.uint8), cv.IMREAD_COLOR)
    except (OSError, ValueError, cv.error) as exc:
        raise StitchError(f"Не удалось прочитать кадр {index}. Загрузите его заново как JPEG или PNG.") from exc
    if image is None or min(image.shape[:2]) < 96:
        raise StitchError(f"Кадр {index} повреждён или слишком мал. Нужна сторона не меньше 96 пикселей.")
    if max(image.shape[:2]) > 1600:
        factor = 1600 / max(image.shape[:2])
        image = cv.resize(image, None, fx=factor, fy=factor, interpolation=cv.INTER_AREA)
    return image


def _require_connected(features: list, matches: list) -> None:
    """Do not imitate leaveBiggestComponent: a submitted frame may not disappear."""
    edges = {index: set() for index in range(len(features))}
    for match in matches:
        if match.src_img_idx < 0 or match.dst_img_idx < 0:
            continue
        if match.confidence > MATCH_CONFIDENCE and match.num_inliers >= 12:
            edges[match.src_img_idx].add(match.dst_img_idx)
            edges[match.dst_img_idx].add(match.src_img_idx)
    seen = {0}
    pending = [0]
    while pending:
        for neighbor in edges[pending.pop()] - seen:
            seen.add(neighbor)
            pending.append(neighbor)
    if len(seen) != len(features):
        missing = ", ".join(str(index + 1) for index in range(len(features)) if index not in seen)
        raise StitchError(
            f"Не найдено надёжного перекрытия для кадров: {missing}. "
            "Снимите одну сцену, поворачивая камеру на месте; оставляйте 30–50% общего изображения. "
            "Добавьте детали в кадр и уберите смазанные снимки."
        )


def _largest_valid_rectangle(mask: np.ndarray) -> tuple[int, int, int, int]:
    """A conservative inner crop. Min-pooling ensures even tiny holes are excluded."""
    height, width = mask.shape
    block = max(1, math.ceil(max(width, height) / 700))
    small_h, small_w = height // block, width // block
    if small_h == 0 or small_w == 0:
        raise StitchError("Панорама слишком узкая. Переснимите кадры с большим общим участком.")
    valid = mask[:small_h * block, :small_w * block].reshape(small_h, block, small_w, block).min(axis=(1, 3)) > 0
    heights = np.zeros(small_w, dtype=np.int32)
    best_area, best = 0, (0, 0, 0, 0)
    for row in range(small_h):
        heights = np.where(valid[row], heights + 1, 0)
        stack: list[tuple[int, int]] = []
        for column in range(small_w + 1):
            current = int(heights[column]) if column < small_w else 0
            start = column
            while stack and stack[-1][1] > current:
                left, bar_height = stack.pop()
                area = (column - left) * bar_height
                if area > best_area:
                    best_area = area
                    best = (left * block, (row - bar_height + 1) * block, (column - left) * block, bar_height * block)
                start = left
            if current and (not stack or stack[-1][1] < current):
                stack.append((start, current))
    if best_area == 0:
        raise StitchError("Не осталось непрерывной области панорамы. Переснимите сцену без перемещения камеры.")
    return best


def _angular_metadata(width: int, height: int, top: float, scale: float) -> dict:
    # OpenCV SphericalProjector: u=s*longitude, v=s*(pi/2-latitude).
    # Pixel centers are integer coordinates; the crop's top edge is top-0.5.
    degrees_per_pixel = 180 / (math.pi * scale)
    return {
        "width": width,
        "height": height,
        "haov": width * degrees_per_pixel,
        "vaov": height * degrees_per_pixel,
        "vOffset": 90 - (top - 0.5 + height / 2) * degrees_per_pixel,
        "projection": "equirectangular",
    }


def _stitch(images: list[np.ndarray], output_path: Path) -> dict:
    cv.setNumThreads(2)
    cv.setRNGSeed(1729)
    cv.ocl.setUseOpenCL(False)
    detector = cv.SIFT_create(nfeatures=5000)
    work_scale = min(1.0, math.sqrt(650_000 / max(image.shape[0] * image.shape[1] for image in images)))
    features = []
    for index, image in enumerate(images):
        small = cv.resize(image, None, fx=work_scale, fy=work_scale, interpolation=cv.INTER_AREA)
        feature = cv.detail.computeImageFeatures2(detector, small)
        feature.img_idx = index
        if len(feature.keypoints) < 20:
            raise StitchError(f"В кадре {index + 1} мало различимых деталей. Добавьте двери, мебель или другие ориентиры и повторите съёмку.")
        features.append(feature)
    matcher = cv.detail_BestOf2NearestMatcher(False, 0.65)
    matches = matcher.apply2(features)
    matcher.collectGarbage()
    _require_connected(features, matches)
    success, cameras = cv.detail_HomographyBasedEstimator().apply(features, matches, None)
    if not success:
        raise StitchError("Не удалось определить поворот камеры. Снимите сцену с перекрытием 30–50%, вращаясь на месте.")
    for camera in cameras:
        camera.R = camera.R.astype(np.float32)
    adjuster = cv.detail_BundleAdjusterRay()
    adjuster.setConfThresh(MATCH_CONFIDENCE)
    adjuster.setRefinementMask(np.ones((3, 3), dtype=np.uint8))
    adjuster.setTermCriteria((cv.TERM_CRITERIA_EPS + cv.TERM_CRITERIA_COUNT, 100, 1e-6))
    success, cameras = adjuster.apply(features, matches, cameras)
    if not success:
        raise StitchError("Кадры совпадают, но геометрия нестабильна. Повторите съёмку без шагов в сторону и близких движущихся объектов.")
    for camera, image in zip(cameras, images):
        if not np.isfinite(camera.R).all() or not math.isfinite(camera.focal) or not 0.15 * max(image.shape[:2]) * work_scale < camera.focal < 12 * max(image.shape[:2]) * work_scale:
            raise StitchError("Не удалось надёжно оценить угол обзора. Нужны кадры одной камеры с заметным поворотом и общими деталями.")
    rotations = cv.detail.waveCorrect([camera.R for camera in cameras], cv.detail.WAVE_CORRECT_HORIZ)
    # Center the shortest circular arc containing optical axes, leaving the seam
    # behind the uncovered area. This prevents two sides of +/-pi being repeated.
    headings = sorted(math.atan2(float(rotation[0, 2]), float(rotation[2, 2])) % (2 * math.pi) for rotation in rotations)
    gaps = [(headings[(i + 1) % len(headings)] - headings[i]) % (2 * math.pi) for i in range(len(headings))]
    gap_index = int(np.argmax(gaps))
    arc_start = headings[(gap_index + 1) % len(headings)]
    center = arc_start + (2 * math.pi - gaps[gap_index]) / 2
    yaw = -center
    recenter = np.array([[math.cos(yaw), 0, math.sin(yaw)], [0, 1, 0], [-math.sin(yaw), 0, math.cos(yaw)]], dtype=np.float32)
    for camera, rotation in zip(cameras, rotations):
        camera.R = recenter @ rotation

    scale = float(np.median([camera.focal for camera in cameras])) / work_scale
    warper = cv.PyRotationWarper("spherical", scale)
    intrinsics, rois = [], []
    for image, camera in zip(images, cameras):
        intrinsic = camera.K().astype(np.float32)
        intrinsic[0, :] /= work_scale
        intrinsic[1, :] /= work_scale
        intrinsics.append(intrinsic)
        roi = warper.warpRoi((image.shape[1], image.shape[0]), intrinsic, camera.R)
        if roi[2] / scale > math.pi:
            raise StitchError("Серия пересекает шов полного оборота. Разделите её на две частичные панорамы с общими кадрами.")
        rois.append(roi)
    left = min(roi[0] for roi in rois)
    top = min(roi[1] for roi in rois)
    right = max(roi[0] + roi[2] for roi in rois)
    bottom = max(roi[1] + roi[3] for roi in rois)
    width, height = right - left, bottom - top
    if width <= 0 or height <= 0 or width > MAX_OUTPUT_WIDTH or width * height > MAX_OUTPUT_PIXELS or width / scale > 2 * math.pi:
        raise StitchError("Результат слишком велик или геометрия нестабильна. Разделите серию на более короткие панорамы.")
    corners, warped_images, warped_masks = [], [], []
    for image, camera, intrinsic in zip(images, cameras, intrinsics):
        corner, warped = warper.warp(image, intrinsic, camera.R, cv.INTER_LINEAR, cv.BORDER_REFLECT)
        _, mask = warper.warp(np.full(image.shape[:2], 255, dtype=np.uint8), intrinsic, camera.R, cv.INTER_NEAREST, cv.BORDER_CONSTANT)
        # Prevent interpolation across the source boundary from entering the crop.
        mask = cv.erode(mask, np.ones((3, 3), dtype=np.uint8))
        corners.append(corner)
        warped_images.append(warped)
        warped_masks.append(mask)
    compensator = cv.detail.ExposureCompensator_createDefault(cv.detail.ExposureCompensator_GAIN_BLOCKS)
    compensator.feed(corners, warped_images, warped_masks)
    seam_masks = cv.detail_DpSeamFinder("COLOR_GRAD").find([image.astype(np.float32) for image in warped_images], corners, [cv.UMat(mask) for mask in warped_masks])
    blender = cv.detail_MultiBandBlender()
    blender.setNumBands(4)
    blender.prepare((left, top, width, height))
    coverage = np.zeros((height, width), dtype=np.uint8)
    for index, (image, mask, seam, corner) in enumerate(zip(warped_images, warped_masks, seam_masks, corners)):
        compensator.apply(index, corner, image, mask)
        seam_array = seam.get() if isinstance(seam, cv.UMat) else seam
        blend_mask = cv.bitwise_and(mask, cv.dilate(seam_array, None))
        blender.feed(image.astype(np.int16), blend_mask, corner)
        x, y = corner[0] - left, corner[1] - top
        coverage[y:y + mask.shape[0], x:x + mask.shape[1]] |= mask
    result, result_mask = blender.blend(None, None)
    coverage = cv.bitwise_and(coverage, result_mask)
    crop_x, crop_y, crop_w, crop_h = _largest_valid_rectangle(coverage)
    if crop_w < 160 or crop_h < 96 or crop_w * crop_h < width * height * 0.3:
        raise StitchError("После удаления пустых краёв осталось слишком мало изображения. Держите камеру ровно и увеличьте перекрытие кадров.")
    cropped = np.clip(result[crop_y:crop_y + crop_h, crop_x:crop_x + crop_w], 0, 255).astype(np.uint8)
    metadata = _angular_metadata(crop_w, crop_h, top + crop_y, scale)
    if not 5 < metadata["haov"] <= 360 or abs(metadata["vOffset"]) + metadata["vaov"] / 2 > 90.01:
        raise StitchError("Получился недостоверный угол обзора. Повторите съёмку, поворачивая камеру на одном месте.")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    success, encoded = cv.imencode(".jpg", cropped, [cv.IMWRITE_JPEG_QUALITY, 91])
    if not success:
        raise StitchError("Не удалось сохранить панораму. Повторите обработку.")
    encoded.tofile(output_path)
    return {
        **metadata,
        "sourceCount": len(images),
        "usedImageCount": len(images),
        "warnings": [
            "Частичная панорама: обзор рассчитан по найденной геометрии камеры, а не измерен на объекте.",
            "Пустые края обрезаны. Проверьте швы и движущиеся объекты перед показом посетителям.",
        ],
    }


def stitch_images(input_paths: list[Path], output_path: Path) -> dict:
    """Stitch all 2–16 normalized frames, or fail without dropping any frame."""
    if not 2 <= len(input_paths) <= 16:
        raise StitchError("Для сшивки нужны от 2 до 16 фотографий одной сцены.")
    try:
        return _stitch([_read_image(Path(path), index + 1) for index, path in enumerate(input_paths)], Path(output_path))
    except StitchError:
        raise
    except cv.error as exc:
        raise StitchError("Не удалось сшить эту серию. Переснимите сцену с общими деталями, без смаза и перемещения камеры.") from exc
    except (OSError, ValueError, OverflowError) as exc:
        raise StitchError("Не удалось обработать или сохранить фотографии. Проверьте файлы и повторите загрузку.") from exc
