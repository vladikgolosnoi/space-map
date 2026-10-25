import { assetUrl } from './offline';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { MediaResult, Panorama, Project, StitchJob } from './types';
import './panorama.css';

type FrameCheck = { name: string; warnings: string[] };

async function normalizePhoto(file: File): Promise<File> {
  // iPhone Safari can expose a camera frame with a JPEG-looking name while
  // the payload is HEIC/HEIF. Decode it in the browser and send a real JPEG
  // so the server-side Pillow/OpenCV validators receive the declared format.
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`Не удалось декодировать ${file.name}`));
      element.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Преобразование фотографии недоступно');
    context.drawImage(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error(`Не удалось преобразовать ${file.name}`);
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function inspectFrame(file: File): Promise<FrameCheck> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('Не удалось открыть изображение'));
      element.src = url;
    });
    const scale = Math.min(1, 320 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(3, Math.round(image.naturalWidth * scale));
    const height = Math.max(3, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Проверка изображения недоступна');
    context.drawImage(image, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    const gray = new Uint8Array(width * height);
    let brightness = 0;
    for (let i = 0; i < gray.length; i++) {
      const offset = i * 4;
      const value = Math.round(
        data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722,
      );
      gray[i] = value;
      brightness += value;
    }
    brightness /= gray.length;
    let laplace = 0;
    let laplaceSquared = 0;
    let samples = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const value =
          4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
        laplace += value;
        laplaceSquared += value * value;
        samples++;
      }
    }
    const sharpness = laplaceSquared / samples - (laplace / samples) ** 2;
    const warnings: string[] = [];
    if (sharpness < 35) warnings.push('мало деталей или возможен смаз');
    if (brightness < 35) warnings.push('очень тёмный кадр');
    if (brightness > 220) warnings.push('возможна пересветка');
    return { name: file.name, warnings };
  } catch {
    return { name: file.name, warnings: ['не удалось оценить качество автоматически'] };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function PanoramaStudio({
  project,
  spaceSlug = 'demo',
  onClose,
  onAttach,
}: {
  project: Project;
  spaceSlug?: string;
  onClose: () => void;
  onAttach: (panorama: Panorama) => Promise<void>;
}) {
  const [mode, setMode] = useState<'stitch' | 'import'>('stitch');
  const [files, setFiles] = useState<File[]>([]);
  const [frameChecks, setFrameChecks] = useState<FrameCheck[]>([]);
  const [job, setJob] = useState<StitchJob | null>(null);
  const [result, setResult] = useState<MediaResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [nodeId, setNodeId] = useState(project.nodes[0]?.id ?? '');
  const [haov, setHaov] = useState(360);
  const [vaov, setVaov] = useState(180);
  const [vOffset, setVOffset] = useState(0);
  const modal = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    modal.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key !== 'Tab') return;
      const controls = Array.from(
        modal.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = controls[0],
        last = controls.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === modal.current)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.body.style.overflow = overflow;
      prior?.focus();
    };
  }, []);
  const processing = job?.status === 'queued' || job?.status === 'running';
  const hasCaptureNode = project.nodes.some((node) => node.id === nodeId);
  useEffect(() => {
    if (!hasCaptureNode) setNodeId(project.nodes[0]?.id ?? '');
  }, [hasCaptureNode, nodeId, project.nodes]);
  useEffect(() => {
    let active = true;
    if (mode !== 'stitch' || files.length === 0) {
      setFrameChecks([]);
      return () => {
        active = false;
      };
    }
    void Promise.all(files.map(inspectFrame)).then((checks) => {
      if (active) setFrameChecks(checks);
    });
    return () => {
      active = false;
    };
  }, [files, mode]);
  useEffect(() => {
    const storageKey = `space-stitch-job:${spaceSlug}`;
    const id = sessionStorage.getItem(storageKey);
    if (!id) return;
    let active = true;
    api
      .stitchJob(id, spaceSlug)
      .then((next) => {
        if (active) {
          setJob(next);
          setResult(next.result ?? null);
          if (next.error) setError(next.error);
        }
      })
      .catch(() => {
        sessionStorage.removeItem(storageKey);
      });
    return () => {
      active = false;
    };
  }, [spaceSlug]);
  useEffect(() => {
    if (!processing || !job) return;
    let active = true;
    const timer = setTimeout(() => {
      api
        .stitchJob(job.id, spaceSlug)
        .then((next) => {
          if (!active) return;
          setError('');
          setJob(next);
          if (next.result) setResult(next.result);
          if (next.status === 'failed')
            setError(next.error || 'Сшивка не удалась. Попробуйте другую серию.');
        })
        .catch((err) => {
          if (active) {
            setError(String(err.message));
            setJob((previous) => (previous ? { ...previous } : null));
          }
        });
    }, 1200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [job, processing, error, spaceSlug]);
  const process = async () => {
    setBusy(true);
    setError('');
    setResult(null);
    setJob(null);
    try {
      const uploadFiles = await Promise.all(files.map(normalizePhoto));
      if (mode === 'stitch') {
        const next = await api.startStitch(uploadFiles, spaceSlug);
        sessionStorage.setItem(`space-stitch-job:${spaceSlug}`, next.id);
        setJob(next);
      } else setResult(await api.importPanorama(uploadFiles[0], { haov, vaov, vOffset }, spaceSlug));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить файлы.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pano-backdrop pano-backdrop-studio">
      <section
        ref={modal}
        tabIndex={-1}
        className="pano-studio"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-title"
      >
        <header className="pano-header">
          <h2 id="studio-title">Добавить панораму</h2>
          <button onClick={onClose} aria-label="Закрыть загрузку">
            ×
          </button>
        </header>
        {!project.nodes.length && (
          <div className="pano-node-empty" role="status">
            <strong>Сначала добавьте точку съёмки</strong>
            <p>Панорама привязывается к узлу маршрута. Добавьте точку на плане, затем вернитесь сюда.</p>
            <button className="pano-button" type="button" onClick={onClose}>Вернуться к конструктору</button>
          </div>
        )}
        <div className="pano-studio-content">
          <label>
            Источник
            <select
              disabled={busy || processing}
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as typeof mode);
                setFiles([]);
                setResult(null);
                setJob(null);
              }}
            >
              <option value="stitch">Сшить фотографии</option>
              <option value="import">Готовая эквидистантная панорама</option>
            </select>
          </label>
          {mode === 'stitch' ? (
            <ol className="pano-help">
              <li>Останьтесь в одной точке. Поворачивайте камеру, не перемещаясь по комнате.</li>
              <li>
                Снимайте горизонтальный ряд с перекрытием 30–50%. Держите телефон ровно; избегайте
                движущихся людей и пустых стен.
              </li>
              <li>
                Добавьте 2–16 JPEG/PNG, до 12 МБ каждый и 64 МБ на серию. После сшивки проверьте
                швы.
              </li>
            </ol>
          ) : (
            <p className="pano-help">
              Нужна эквидистантная проекция. Для частичного обзора введите реальные углы из
              программы экспорта. Обычная фотография не является сферической панорамой.
            </p>
          )}
          <label>
            Фотографии
            <span className="pano-file-picker">
              <span className="pano-file-picker-button">Выбрать фотографии</span>
              <span className="pano-file-picker-summary" aria-live="polite">
                {files.length ? `Выбрано: ${files.length}` : 'JPEG или PNG'}
              </span>
              <input
                key={mode}
                aria-label="Фотографии"
                disabled={busy || processing}
                type="file"
                accept="image/jpeg,image/png"
                multiple={mode === 'stitch'}
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              />
            </span>
          </label>
          {mode === 'stitch' && (
            <label>
              Добавить кадр камерой
              <span className="pano-file-picker">
                <span className="pano-file-picker-button">Снять или выбрать кадр</span>
                <span className="pano-file-picker-summary">Камера телефона</span>
                <input
                  aria-label="Добавить кадр камерой"
                  disabled={busy || processing}
                  type="file"
                  accept="image/jpeg,image/png"
                  capture="environment"
                  onChange={(e) => {
                    setFiles((previous) => [...previous, ...Array.from(e.target.files ?? [])]);
                    e.target.value = '';
                  }}
                />
              </span>
            </label>
          )}
          <p>
            {files.length} файлов ·{' '}
            {(files.reduce((total, file) => total + file.size, 0) / 1048576).toFixed(1)} МБ
          </p>
          {mode === 'stitch' && frameChecks.length > 0 && (
            <section className="pano-quality" aria-label="Предварительная проверка кадров">
              <strong>
                {frameChecks.some((frame) => frame.warnings.length)
                  ? 'Проверьте отмеченные кадры'
                  : 'Кадры выглядят пригодными'}
              </strong>
              <p>Локальная ориентировочная оценка резкости и экспозиции. Исходные фото не меняются.</p>
              <ul>
                {frameChecks.map((frame, index) => (
                  <li key={`${frame.name}-${index}`} className={frame.warnings.length ? 'warn' : ''}>
                    <span>{frame.name}</span>
                    <small>{frame.warnings.join(' · ') || 'резкость и яркость в норме'}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {mode === 'import' && (
            <div className="pano-angle-fields">
              {(
                [
                  ['Горизонтальный обзор, °', haov, setHaov],
                  ['Вертикальный обзор, °', vaov, setVaov],
                  ['Смещение по вертикали, °', vOffset, setVOffset],
                ] as const
              ).map(([label, value, setter]) => (
                <label key={label}>
                  {label}
                  <input
                    type="number"
                    step="0.1"
                    value={value}
                    onChange={(e) => setter(Number(e.target.value))}
                  />
                </label>
              ))}
            </div>
          )}
          <button
            className="pano-button pano-primary"
            disabled={
              busy ||
              processing ||
              !hasCaptureNode ||
              !files.length ||
              (mode === 'stitch' && (files.length < 2 || files.length > 16))
            }
            onClick={() => void process()}
          >
            {busy
              ? 'Загрузка…'
              : processing
                ? 'Сшиваем фотографии…'
                : mode === 'stitch'
                  ? 'Сшить фотографии'
                  : 'Загрузить панораму'}
          </button>
          {processing && (
            <p role="status">
              Обработка может занять до двух минут. Вы можете закрыть окно; обработка на сервере
              продолжится.
            </p>
          )}
          {error && (
            <p role="alert" className="pano-error">
              {error}
            </p>
          )}
          {result && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const node = project.nodes.find((item) => item.id === nodeId);
                if (!node) return;
                setBusy(true);
                setError('');
                try {
                  const {
                    warnings: _warnings,
                    sourceCount: _count,
                    usedImageCount: _used,
                    ...media
                  } = result;
                  await onAttach({
                    ...media,
                    id: crypto.randomUUID(),
                    name: name.trim(),
                    floorId: node.floorId,
                    nodeId,
                    x: node.x,
                    y: node.y,
                    yawOffset: 0,
                    hotspots: [],
                  });
                  sessionStorage.removeItem(`space-stitch-job:${spaceSlug}`);
                  onClose();
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Не удалось сохранить.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <img
                className="pano-preview"
                src={assetUrl(result.thumbnailId)}
                alt="Результат обработки"
              />
              <p>
                {result.width} × {result.height} · {result.haov.toFixed(1)}° ×{' '}
                {result.vaov.toFixed(1)}°
              </p>
              {result.warnings.map((warning) => (
                <p className="pano-help" key={warning}>
                  {warning}
                </p>
              ))}
              <label>
                Название панорамы
                <input
                  required
                  maxLength={200}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                Точка съёмки на карте
                <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
                  {project.nodes.map((node) => (
                    <option key={node.id} value={node.id}>
                      {project.floors.find((f) => f.id === node.floorId)?.name} ·{' '}
                      {node.label || node.id}
                    </option>
                  ))}
                </select>
              </label>
              <p className="pano-help">
                После добавления панорама останется в черновике до публикации карты.
              </p>
              <button className="pano-button pano-primary" disabled={busy || !name.trim() || !hasCaptureNode}>
                Добавить на карту
              </button>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
