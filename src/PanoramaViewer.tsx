import { assetUrl } from './offline';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Crosshair,
  Info,
  LoaderCircle,
  MapPin,
  Minus,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { Hotspot, Panorama, Project } from './types';
import 'pannellum/build/pannellum.css';
import './panorama.css';

interface Props {
  project: Project;
  panorama: Panorama;
  editable: boolean;
  onClose: () => void;
  onScene: (id: string) => void;
  onViewChange: (yaw: number) => void;
  onSave: (panorama: Panorama) => Promise<void>;
  routeScenes?: string[];
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Не удалось сохранить изменения. Повторите попытку.';

export default function PanoramaViewer({
  project,
  panorama,
  editable,
  onClose,
  onScene,
  onViewChange,
  onSave,
  routeScenes = [],
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const modal = useRef<HTMLDivElement>(null);
  const viewer = useRef<PannellumViewer | null>(null);
  const callbacks = useRef({ onClose, onScene, onViewChange });
  callbacks.current = { onClose, onScene, onViewChange };
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<Hotspot | null>(null);
  const [kind, setKind] = useState<'info' | 'scene'>('info');
  const [targetId, setTargetId] = useState('');
  const [text, setText] = useState('');
  const [yawOffset, setYawOffset] = useState(String(panorama.yawOffset));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [viewYaw, setViewYaw] = useState(0);
  const floor = project.floors.find((item) => item.id === panorama.floorId);
  const routeIndex = routeScenes.indexOf(panorama.id);
  const partial = panorama.haov < 359 || panorama.vaov < 179;
  const initialHfov = Math.min(95, Math.max(10, panorama.haov * 0.8));
  const targets =
    kind === 'info' ? project.places : project.panoramas.filter((item) => item.id !== panorama.id);
  const selectedPlace = selected?.placeId
    ? project.places.find((item) => item.id === selected.placeId)
    : null;

  useEffect(() => {
    const priorFocus = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    modal.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') callbacks.current.onClose();
      if (event.key !== 'Tab') return;
      const elements = Array.from(
        modal.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) return;
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === modal.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = oldOverflow;
      priorFocus?.focus();
    };
  }, []);

  useEffect(() => {
    setSelected(null);
    setTargetId('');
    setText('');
    setYawOffset(String(panorama.yawOffset));
    setSaveError('');
  }, [panorama.id, panorama.yawOffset]);

  useEffect(() => {
    let disposed = false;
    let instance: PannellumViewer | null = null;
    let interval: ReturnType<typeof setInterval> | undefined;
    let loaded = false;
    let resize: ResizeObserver | undefined;
    setStatus('loading');
    setLoadError('');
    const openHotspot = (hotspot: Hotspot) => {
      if (hotspot.kind === 'scene' && hotspot.targetPanoramaId)
        callbacks.current.onScene(hotspot.targetPanoramaId);
      else setSelected(hotspot);
    };
    void import('pannellum')
      .then(() => {
        if (disposed || !container.current) return;
        instance = window.pannellum.viewer(container.current, {
          type: 'equirectangular',
          panorama: assetUrl(encodeURIComponent(panorama.assetId)),
          preview: assetUrl(encodeURIComponent(panorama.thumbnailId)),
          autoLoad: true,
          showControls: false,
          escapeHTML: true,
          ignoreGPanoXMP: true,
          haov: panorama.haov,
          vaov: panorama.vaov,
          vOffset: panorama.vOffset,
          yaw: 0,
          pitch: panorama.vOffset,
          hfov: initialHfov,
          minHfov: Math.min(35, initialHfov),
          maxHfov: Math.min(120, panorama.haov),
          minYaw: -panorama.haov / 2,
          maxYaw: panorama.haov / 2,
          minPitch: Math.max(-90, panorama.vOffset - panorama.vaov / 2),
          maxPitch: Math.min(90, panorama.vOffset + panorama.vaov / 2),
          backgroundColor: [0.08, 0.1, 0.14],
          compass: false,
          northOffset: panorama.yawOffset,
          strings: {
            loadingLabel: 'Загрузка панорамы…',
            bylineLabel: 'Источник',
            noPanoramaError: 'Изображение панорамы не задано.',
            fileAccessError: 'Не удалось загрузить изображение.',
            genericWebGLError: 'Не удалось запустить WebGL.',
            noWebGLError: 'Браузер не поддерживает WebGL.',
            textureSizeError: 'Изображение слишком большое для этого устройства.',
          },
          hotSpots: panorama.hotspots.map((hotspot) => ({
            id: hotspot.id,
            pitch: hotspot.pitch,
            yaw: hotspot.yaw,
            cssClass: 'pano-hotspot-anchor',
            createTooltipFunc: (element: HTMLElement) => {
              const button = document.createElement('button');
              button.className = `pano-sphere-hotspot ${hotspot.kind === 'scene' ? 'is-scene' : ''}`;
              button.type = 'button';
              button.textContent = `${hotspot.kind === 'scene' ? '→' : 'ⓘ'} ${hotspot.text}`;
              button.setAttribute(
                'aria-label',
                `${hotspot.kind === 'scene' ? 'Перейти к сцене' : 'Информация'}: ${hotspot.text}`,
              );
              button.onclick = (event) => {
                event.stopPropagation();
                openHotspot(hotspot);
              };
              element.appendChild(button);
            },
          })),
        });
        viewer.current = instance;
        instance.on('load', () => {
          if (disposed) return;
          loaded = true;
          setStatus('ready');
          callbacks.current.onViewChange(instance!.getYaw());
        });
        instance.on('error', () => {
          if (disposed) return;
          loaded = false;
          setStatus('error');
          setLoadError(
            'Панорамный просмотр недоступен: не удалось загрузить изображение или запустить WebGL. Ниже доступна плоская фотография.',
          );
        });
        let lastYaw = Number.NaN;
        interval = setInterval(() => {
          if (!loaded || !instance || disposed) return;
          const yaw = instance.getYaw();
          if (Math.abs(yaw - lastYaw) > 0.2 || Number.isNaN(lastYaw)) {
            lastYaw = yaw;
            setViewYaw(yaw);
            callbacks.current.onViewChange(yaw);
          }
        }, 150);
        resize = new ResizeObserver(() => instance?.resize());
        resize.observe(container.current);
      })
      .catch(() => {
        if (disposed) return;
        setStatus('error');
        setLoadError(
          'Не удалось запустить панорамный просмотр. Попробуйте ещё раз или обновите страницу.',
        );
      });
    return () => {
      disposed = true;
      if (interval) clearInterval(interval);
      resize?.disconnect();
      instance?.destroy();
      viewer.current = null;
    };
  }, [panorama, retry, initialHfov]);

  const save = async (next: Panorama) => {
    setSaving(true);
    setSaveError('');
    setNotice('');
    try {
      await onSave(next);
      setNotice('Изменения сохранены.');
      return true;
    } catch (error) {
      setSaveError(errorMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const addHotspot = async () => {
    const current = viewer.current;
    const target = targets.find((item) => item.id === targetId);
    if (!current || status !== 'ready' || !target) return;
    const hotspot: Hotspot = {
      id: crypto.randomUUID(),
      kind,
      yaw: current.getYaw(),
      pitch: current.getPitch(),
      text: text.trim() || target.name,
      ...(kind === 'info' ? { placeId: target.id } : { targetPanoramaId: target.id }),
    };
    if (await save({ ...panorama, hotspots: [...panorama.hotspots, hotspot] })) setText('');
  };

  return (
    <div className="pano-backdrop">
      <div
        ref={modal}
        className="pano-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={panorama.name}
        tabIndex={-1}
      >
        <header className="pano-header">
          <div>
            <span className="pano-eyebrow">Панорама · {floor?.name}</span>
            <h2 id="pano-title">{panorama.name}</h2>
          </div>
          <button className="pano-icon-button" onClick={onClose} aria-label="Закрыть панораму">
            <X size={22} />
          </button>
        </header>
        <div className="pano-viewer-body">
          <div className="pano-stage">
            <div
              ref={container}
              className={`pano-canvas ${status === 'error' ? 'pano-canvas-hidden' : ''}`}
              aria-label="Панорамный просмотр: перетаскивайте изображение для осмотра"
            />
            {status === 'loading' && (
              <div className="pano-loading" role="status">
                <LoaderCircle className="spin" size={28} />
                <span>Открываем панораму…</span>
              </div>
            )}
            {status === 'error' && (
              <div className="pano-fallback">
                <img
                  src={assetUrl(encodeURIComponent(panorama.assetId))}
                  alt={`Плоское изображение: ${panorama.name}`}
                />
                <div role="alert">
                  <p>{loadError}</p>
                  <button className="pano-button" onClick={() => setRetry((value) => value + 1)}>
                    Повторить просмотр
                  </button>
                </div>
              </div>
            )}
            <div className="pano-coverage">
              {partial ? 'Частичный обзор · не полная сфера' : 'Сферический обзор'}
              <span>
                {panorama.haov.toFixed(1)}° × {panorama.vaov.toFixed(1)}°
              </span>
            </div>
            {status === 'ready' && (
              <>
                {editable && (
                  <div className="pano-crosshair" aria-hidden="true">
                    <Crosshair size={25} />
                  </div>
                )}
                <div className="pano-controls">
                  <span>Перетаскивайте для осмотра</span>
                  <button
                    aria-label="Приблизить панораму"
                    onClick={() => viewer.current?.setHfov(viewer.current.getHfov() - 10, 200)}
                  >
                    <Plus size={19} />
                  </button>
                  <button
                    aria-label="Отдалить панораму"
                    onClick={() => viewer.current?.setHfov(viewer.current.getHfov() + 10, 200)}
                  >
                    <Minus size={19} />
                  </button>
                  <button
                    aria-label="Вернуть исходный ракурс"
                    onClick={() => viewer.current?.lookAt(panorama.vOffset, 0, initialHfov, 200)}
                  >
                    <RotateCcw size={18} />
                  </button>
                </div>
              </>
            )}
          </div>
          <aside className="pano-sidebar">
            {routeIndex >= 0 && (
              <div className="pano-place-detail">
                <p>
                  Маршрут · сцена {routeIndex + 1} из {routeScenes.length}
                </p>
                {routeIndex < routeScenes.length - 1 ? (
                  <button
                    className="pano-button"
                    onClick={() => onScene(routeScenes[routeIndex + 1])}
                  >
                    Следующая сцена маршрута
                  </button>
                ) : (
                  <p>Вы достигли конца маршрута.</p>
                )}
              </div>
            )}
            <div className="pano-location">
              <MapPin size={17} />
              <span>
                {floor?.name} ·{' '}
                {project.nodes.find((item) => item.id === panorama.nodeId)?.label ||
                  'Точка на карте'}
              </span>
            </div>
            {floor && (
              <svg
                className="pano-minimap"
                viewBox={`0 0 ${floor.width} ${floor.height}`}
                role="img"
                aria-label="Точка съёмки и направление взгляда на плане"
              >
                {project.rooms
                  .filter((room) => room.floorId === floor.id)
                  .map((room) => (
                    <rect
                      key={room.id}
                      x={room.x}
                      y={room.y}
                      width={room.width}
                      height={room.height}
                      fill={room.kind === 'corridor' ? '#e2e9f2' : '#fff'}
                      stroke="#9caec4"
                      strokeWidth="4"
                    />
                  ))}
                <g
                  transform={`translate(${panorama.x} ${panorama.y}) rotate(${viewYaw + panorama.yawOffset})`}
                >
                  <path d="M 0 0 L -45 -90 Q 0 -115 45 -90 Z" fill="#e5271355" />
                  <circle r="14" fill="#e52713" stroke="white" strokeWidth="5" />
                  <path d="M 0 -10 L 0 -65" stroke="#e52713" strokeWidth="8" />
                </g>
              </svg>
            )}
            <p className="pano-help">
              {partial
                ? 'Показана только снятая область. Тёмные края — участки, которых нет на исходных кадрах.'
                : 'Осматривайтесь мышью или пальцем. Метки открывают информацию и соседние сцены.'}
            </p>
            <h3>
              Места и переходы <span>{panorama.hotspots.length}</span>
            </h3>
            {panorama.hotspots.length === 0 && (
              <p className="pano-empty">
                Меток пока нет.
                {editable ? ' Выберите направление в панораме и добавьте первую.' : ''}
              </p>
            )}
            <ul className="pano-hotspot-list">
              {panorama.hotspots.map((hotspot) => (
                <li key={hotspot.id}>
                  <button
                    className={selected?.id === hotspot.id ? 'is-selected' : ''}
                    onClick={() => {
                      if (hotspot.kind === 'scene' && hotspot.targetPanoramaId)
                        onScene(hotspot.targetPanoramaId);
                      else {
                        setSelected(hotspot);
                        viewer.current?.lookAt(hotspot.pitch, hotspot.yaw, undefined, 250);
                      }
                    }}
                  >
                    {hotspot.kind === 'scene' ? <ArrowRight size={17} /> : <Info size={17} />}
                    <span>{hotspot.text}</span>
                  </button>
                  {editable && (
                    <button
                      className="pano-delete"
                      disabled={saving}
                      aria-label={`Удалить метку ${hotspot.text}`}
                      onClick={() =>
                        void save({
                          ...panorama,
                          hotspots: panorama.hotspots.filter((item) => item.id !== hotspot.id),
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {selected && (
              <div className="pano-place-detail" role="status">
                <strong>{selectedPlace?.name || selected.text}</strong>
                <p>
                  {selectedPlace?.description || 'Для этой метки пока нет подробного описания.'}
                </p>
                <button onClick={() => setSelected(null)}>Скрыть описание</button>
              </div>
            )}
            {editable && (
              <div className="pano-editor">
                <h3>
                  <Crosshair size={16} /> Метка в центре взгляда
                </h3>
                <p className="pano-help">
                  Наведите перекрестие на нужное место. Сохраняются реальные углы текущего ракурса.
                </p>
                <label>
                  Тип метки
                  <select
                    value={kind}
                    onChange={(event) => {
                      setKind(event.target.value as 'info' | 'scene');
                      setTargetId('');
                    }}
                  >
                    <option value="info">Информация о месте</option>
                    <option value="scene">Переход к панораме</option>
                  </select>
                </label>
                <label>
                  {kind === 'info' ? 'Место' : 'Панорама назначения'}
                  <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                    <option value="">Выберите {kind === 'info' ? 'место' : 'панораму'}</option>
                    {targets.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                {targets.length === 0 && (
                  <p className="pano-help">Для перехода сначала добавьте вторую панораму.</p>
                )}
                <label>
                  Подпись (необязательно)
                  <input
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    maxLength={120}
                    placeholder="Название выбранного места"
                  />
                </label>
                <button
                  className="pano-button pano-primary"
                  disabled={saving || !targetId || status !== 'ready'}
                  onClick={() => void addHotspot()}
                >
                  <Plus size={16} /> Добавить метку
                </button>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const value = Number(yawOffset);
                    if (Number.isFinite(value) && value >= -180 && value <= 180)
                      void save({ ...panorama, yawOffset: value });
                  }}
                >
                  <label>
                    Направление центра на карте, °
                    <input
                      type="number"
                      min="-180"
                      max="180"
                      step="0.1"
                      required
                      value={yawOffset}
                      onChange={(event) => setYawOffset(event.target.value)}
                    />
                  </label>
                  <p className="pano-help">
                    0° — вверх по плану, 90° — вправо. Укажите направление центрального кадра.
                  </p>
                  <button className="pano-button" disabled={saving} type="submit">
                    <Save size={15} /> Сохранить направление
                  </button>
                </form>
                {saving && <p role="status">Сохранение…</p>}
                {notice && (
                  <p className="pano-success" role="status">
                    {notice}
                  </p>
                )}
                {saveError && (
                  <p className="pano-error" role="alert">
                    {saveError}
                  </p>
                )}
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
