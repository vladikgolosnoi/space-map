import { assetUrl, offline } from './offline';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  ExternalLink,
  Footprints,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  MapPin,
  Navigation,
  Pencil,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { api } from './api';
import MapCanvas from './MapCanvas';
import PlacePreview from './PlacePreview';
import { roomAppearance } from './mapAppearance';
import ttkLogo from './assets/ttk-logo-official.png';
import type { Panorama, Place, Project, Route } from './types';
import './panorama.css';
import { panoramaRoute } from './panoramaRoute';
import PwaInstall from './PwaInstall';
import { saveDownload } from './download';
const PanoramaViewer = lazy(() => import('./PanoramaViewer'));
const PanoramaStudio = lazy(() => import('./PanoramaStudio'));
const PlanEditor = lazy(() => import('./PlanEditor'));
const embedded = location.pathname.startsWith('/embed/');
const projectSlug = location.pathname.match(/^\/(?:map|editor|embed)\/([^/]+)/)?.[1] ?? 'demo';
const isWorkspace = projectSlug !== 'demo';
const workspaceVisitor = isWorkspace && !location.pathname.startsWith('/editor/');



export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [floorId, setFloorId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('Все места');
  const [tab, setTab] = useState<'places' | 'route' | 'panoramas'>('places');
  const [panoramaId, setPanoramaId] = useState<string | null>(null);
  const [studioOpen, setStudioOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [accessible, setAccessible] = useState(false);
  const [route, setRoute] = useState<Route | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [canEditWorkspace, setCanEditWorkspace] = useState(false);
  const [canPublishWorkspace, setCanPublishWorkspace] = useState(!isWorkspace);
  const [editor, setEditor] = useState(location.pathname.startsWith('/editor'));
  const [loginOpen, setLoginOpen] = useState(location.pathname.startsWith('/editor'));
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [draft, setDraft] = useState({ name: '', category: '', description: '' });
  const [aboutOpen, setAboutOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishedRevision, setPublishedRevision] = useState<number | null>(null);
  const [publicationLoading, setPublicationLoading] = useState(false);
  const [publicationError, setPublicationError] = useState('');
  const [copiedPublication, setCopiedPublication] = useState<'link' | 'embed' | null>(null);
  const [downloading, setDownloading] = useState(false);
  const downloadOffline = async () => {
    setDownloading(true);
    setError('');
    try {
      const response = await fetch('/api/projects/demo/offline');
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.detail || 'Не удалось подготовить копию. Повторите скачивание.');
      }
      const blob = await response.blob();
      const filename =
        response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ??
        'space-map.html';
      saveDownload(blob, filename);
      setNotice(
        `Офлайн-копия подготовлена (${(blob.size / 1024 / 1024).toFixed(1)} МБ). Откройте скачанный HTML-файл в браузере.`,
      );
    } catch (err) {
      setError(
        err instanceof TypeError
          ? 'Нет связи с сервером. Восстановите соединение и повторите скачивание.'
          : message(err),
      );
    } finally {
      setDownloading(false);
    }
  };
  const routeRequest = useRef(0);
  const selected = project?.places.find((place) => place.id === selectedId) ?? null;
  const panorama = project?.panoramas.find((item) => item.id === panoramaId);
  const preview = panoramaRoute(route, project?.panoramas ?? []);
  const savePanorama = async (next: Panorama) => {
    if (!project) return;
    const exists = project.panoramas.some((item) => item.id === next.id);
    setProject(
      await api.save({
        ...project,
        panoramas: exists
          ? project.panoramas.map((item) => (item.id === next.id ? next : item))
          : [...project.panoramas, next],
      }, projectSlug),
    );
  };
  const floor = project?.floors.find((item) => item.id === floorId) ?? project?.floors[0];
  const message = (err: unknown) =>
    err instanceof Error ? err.message : 'Не удалось выполнить действие.';
  const loadPublicationState = async () => {
    setPublicationLoading(true);
    setPublicationError('');
    setPublishedRevision(null);
    try {
      if (isWorkspace) {
        const account = await api.account();
        const access = account.spaces.find((space) => space.slug === projectSlug);
        if (!access) throw new Error('Нет доступа к этому пространству. Обновите страницу и проверьте права команды.');
        setPublishedRevision(access.publishedRevision ?? 0);
      } else {
        const published = await api.project(false, projectSlug);
        setPublishedRevision(published.revision);
      }
    } catch (err) {
      setPublicationError(message(err));
    } finally {
      setPublicationLoading(false);
    }
  };
  const copyPublicationValue = async (value: string, target: 'link' | 'embed') => {
    setPublicationError('');
    try {
      await navigator.clipboard.writeText(value);
      setCopiedPublication(target);
    } catch {
      setPublicationError('Не удалось скопировать автоматически. Выделите текст и скопируйте его вручную.');
    }
  };
  useEffect(() => {
    if (!publishOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPublishOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [publishOpen]);

  useEffect(() => {
    let active = true;
    api
      .session(projectSlug)
      .then(async (data) => {
        if (active) {
          let permitted = data.authenticated;
          let editAllowed = permitted;
          let publishAllowed = !isWorkspace && permitted;
          if (isWorkspace && permitted) {
            try {
              const account = await api.account();
              const access = account.spaces.find((space) => space.slug === projectSlug);
              permitted = Boolean(access);
              editAllowed = Boolean(access && access.role !== 'viewer');
              publishAllowed = Boolean(access && ['owner', 'admin'].includes(access.role));
            } catch {
              permitted = false;
              editAllowed = false;
              publishAllowed = false;
            }
          }
          if (!active) return;
          setAuthenticated(permitted);
          setCanEditWorkspace(editAllowed);
          setCanPublishWorkspace(publishAllowed);
          if (permitted) setLoginOpen(false);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!isWorkspace || !location.pathname.startsWith('/map/')) return;
    const key = `space-view:${projectSlug}`;
    const visitorId = sessionStorage.getItem(key) ?? crypto.randomUUID().replaceAll('-', '');
    sessionStorage.setItem(key, visitorId);
    void api.countView(projectSlug, visitorId).catch(() => {});
  }, []);
  useEffect(() => {
    let active = true;
    api
      .project(editor && authenticated && !embedded, projectSlug)
      .then((data) => {
        if (active) {
          setProject(data);
          setSelectedId(null);
          setRoute(null);
          if (!editor) setPublishedRevision(data.revision);
          setFloorId(data.floors[0].id);
          setStart(data.places[0]?.nodeId ?? '');
          setEnd(
            data.places.find((p) => p.id === 'meridian')?.nodeId ??
              data.places.at(-1)?.nodeId ??
              '',
          );
        }
      })
      .catch((err) => {
        if (active) setError(message(err));
      });
    return () => {
      active = false;
    };
  }, [editor, authenticated]);
  useEffect(() => {
    if (selected)
      setDraft({
        name: selected.name,
        category: selected.category,
        description: selected.description,
      });
  }, [selected]);
  useEffect(() => {
    routeRequest.current++;
    setBusy(false);
    setRoute(null);
    setError('');
  }, [start, end, accessible]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setLoginOpen(false);
        setAboutOpen(false);
        setPublishOpen(false);
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

  const selectPlace = (place: Place) => {
    setSelectedId(place.id);
    setFloorId(place.floorId);
    setNotice('');
  };
  const buildRoute = async (destination = end) => {
    const id = ++routeRequest.current;
    setError('');
    setBusy(true);
    setRoute(null);
    try {
      const result = await api.route(
        start,
        destination,
        accessible,
        editor && authenticated && !embedded,
        projectSlug,
      );
      if (id !== routeRequest.current) return;
      setRoute(result);
      setFloorId(result.nodes[0].floorId);
    } catch (err) {
      if (id === routeRequest.current) setError(message(err));
    } finally {
      if (id === routeRequest.current) setBusy(false);
    }
  };
  const save = async () => {
    if (!project || !selected) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await api.save({
        ...project,
        places: project.places.map((place) =>
          place.id === selected.id ? { ...place, ...draft } : place,
        ),
      }, projectSlug);
      setProject(saved);
      setNotice(`Сохранено · версия ${saved.revision}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(password, projectSlug, email);
      if (isWorkspace) {
        const account = await api.account();
        const access = account.spaces.find((space) => space.slug === projectSlug);
        if (!access) {
          setAuthenticated(false);
          throw new Error('Это пространство принадлежит другому аккаунту.');
        }
        setCanEditWorkspace(access.role !== 'viewer');
        setCanPublishWorkspace(['owner', 'admin'].includes(access.role));
      } else {
        setCanEditWorkspace(true);
        setCanPublishWorkspace(true);
      }
      setPassword('');
      setAuthenticated(true);
      setEditor(true);
      setLoginOpen(false);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const openEditor = () => {
    if (authenticated) setEditor((value) => !value);
    else setLoginOpen(true);
  };
  const logout = async () => {
    try {
      await api.logout(projectSlug);
      setAuthenticated(false);
      setPublishOpen(false);
      setEditor(false);
      setNotice('Вы вышли из режима организатора.');
    } catch (err) {
      setError(message(err));
    }
  };

  return (
    <div className={`app-shell ${embedded ? 'is-embedded' : ''} ${workspaceVisitor ? 'is-workspace-visitor' : ''}`}>
      <header className="main-header">
        <a
          className="brand"
          href={offline ? '#' : workspaceVisitor ? '/' : isWorkspace ? '/account' : '/map/demo'}
          aria-label="Карта пространства — главная"
        >
          {isWorkspace ? <span className="workspace-logo"><Layers3 size={20} /></span> : <img className="ttk-logo" src={ttkLogo} alt="ТТК · ТрансТелеКом" />}
          <span className="brand-context">
            <strong>Карта пространства</strong>
            <span className="brand-second">ИНТЕРАКТИВНАЯ НАВИГАЦИЯ</span>
          </span>
        </a>
        <div className="header-divider" />
        <span className="project-label">{workspaceVisitor ? 'ПУБЛИЧНАЯ КАРТА' : isWorkspace ? 'ВАШЕ ПРОСТРАНСТВО' : 'ДЕМО · ТТК'}</span>
        <nav className="header-nav">
          <button
            className="nav-current"
            onClick={() => {
              setTab('places');
              setSelectedId(null);
            }}
          >
            Обзор пространства
          </button>
          {!isWorkspace && <button onClick={() => setAboutOpen(true)}>
            О проекте <ExternalLink size={13} />
          </button>}
        </nav>
        {!offline && !isWorkspace && (
          <button className={`organizer-button ${editor ? 'is-active' : ''}`} onClick={openEditor}>
            <Pencil size={15} />
            <span>{editor ? 'Режим посетителя' : 'Организатору'}</span>
          </button>
        )}
        {!offline && isWorkspace && editor && !authenticated && (
          <button className="organizer-button" onClick={() => setLoginOpen(true)}>
            <LockKeyhole size={15} /><span>Войти в аккаунт</span>
          </button>
        )}
        {!offline && isWorkspace && editor && authenticated && (
          <a className="organizer-button" href={editor ? `/map/${projectSlug}` : `/editor/${projectSlug}`}>
            <Pencil size={15} /><span>{editor ? 'Режим посетителя' : 'Редактировать'}</span>
          </a>
        )}
      </header>

      <main>
        {offline ? (
          <div className="offline-banner" role="status">
            <strong>Офлайн-копия · версия {offline.project.revision}</strong>
            <span>
              Сохранена {new Date(offline.createdAt).toLocaleString('ru-RU')}. Поиск, маршруты и
              панорамы работают без сети. Изменения сервера сюда не поступают.
            </span>
          </div>
        ) : (
          !embedded && !isWorkspace && (
            <div className="offline-download">
              <button disabled={downloading} onClick={() => void downloadOffline()}>
                {downloading ? 'Подготовка копии…' : 'Скачать офлайн-карту'}
              </button>
              <span>
                Карта и панорамы останутся с вами без интернета. Для браузера компьютера.
              </span>
              {!embedded && <PwaInstall />}
            </div>
          )
        )}

        <div className="page-heading">
          <div>
            <div className="breadcrumb">
              Пространства <ChevronRight size={12} /> {project?.title ?? 'Загрузка'}
            </div>
            <h1>{project?.title ?? 'Карта пространства'}</h1>
            <p>Ваш путь внутри здания. Выберите место — мы покажем, как добраться.</p>
          </div>
          <div className="building-meta">
            <span className="building-meta-icon">
              <Layers3 size={23} />
            </span>
            <div>
              <strong>{project?.places.length ?? 0} мест · {project?.floors.length ?? 0} этажа</strong>
              <span>
                {isWorkspace ? (workspaceVisitor ? 'Для посетителей' : 'Ваше пространство') : 'Демонстрационный объект'}
              </span>
            </div>
          </div>
        </div>

        {!project || !floor ? (
          <div className="loading-panel">
            {error ? (
              <>
                <h2>Карта пока недоступна</h2>
                <p role="alert">{error}</p>
                <p>Проверьте подключение и попробуйте снова.</p>
                <button className="primary-button" onClick={() => location.reload()}>
                  Попробовать снова
                </button>
              </>
            ) : (
              <>
                <LoaderCircle className="spin" />
                <p>Открываем пространство…</p>
              </>
            )}
          </div>
        ) : (
          <>
            {editor && authenticated && (
              <div className="editor-banner">
                <span>
                  <ShieldCheck size={17} /> Режим организатора{' '}
                  <small>План, места, проходы и панорамы</small>
                </span>
                <div className="editor-banner-actions">
                  {canEditWorkspace && <button onClick={() => setPlanOpen(true)}>Редактор плана</button>}
                  {canPublishWorkspace && <button
                    onClick={() => {
                      setPublishOpen(true);
                      setNotice('');
                      setCopiedPublication(null);
                      void loadPublicationState();
                    }}
                  >
                    Публикация
                  </button>}
                  {!canEditWorkspace && <small>Только просмотр команды</small>}
                  <button onClick={logout}>Выйти</button>
                </div>
              </div>
            )}
            <div className="workspace">
              <aside className="sidebar">
                <div className="sidebar-tabs">
                  <button
                    className={tab === 'places' ? 'active' : ''}
                    onClick={() => setTab('places')}
                  >
                    <MapPin size={16} /> Места
                  </button>
                  <button
                    className={tab === 'route' ? 'active' : ''}
                    onClick={() => setTab('route')}
                  >
                    <Navigation size={16} /> Маршрут
                  </button>
                  <button
                    className={tab === 'panoramas' ? 'active' : ''}
                    onClick={() => setTab('panoramas')}
                  >
                    Панорамы
                  </button>
                </div>
                <div className="sidebar-content">
                  {tab === 'panoramas' && (
                    <div className="pano-gallery">
                      <h2>Осмотр пространства</h2>
                      {authenticated && editor && canEditWorkspace && (
                        <button
                          className="pano-button pano-primary"
                          onClick={() => setStudioOpen(true)}
                        >
                          Добавить панораму
                        </button>
                      )}
                      {!project.panoramas.length && (
                        <p className="muted">
                          Панорам пока нет. Организатор может сшить фотографии или загрузить готовую
                          панораму и привязать её к карте.
                        </p>
                      )}
                      {route && (
                        <div className="pano-help">
                          <p>
                            {preview.complete
                              ? 'Маршрут покрыт связанными сценами.'
                              : `Частичное покрытие: ${preview.scenes.length} из ${route.nodes.length} узлов. Для непрерывного просмотра нужны сцены и переходы на всём пути.`}
                          </p>
                          {preview.complete && (
                            <button
                              className="pano-button"
                              onClick={() => setPanoramaId(preview.scenes[0].id)}
                            >
                              Предпросмотр маршрута
                            </button>
                          )}
                          {!preview.complete &&
                            preview.scenes.map((scene) => (
                              <button
                                className="pano-button"
                                key={scene.id}
                                onClick={() => setPanoramaId(scene.id)}
                              >
                                {scene.name}
                              </button>
                            ))}
                        </div>
                      )}
                      {project.panoramas.map((item) => (
                        <div key={item.id}>
                          <button
                            className="pano-card"
                            onClick={() => {
                              setPanoramaId(item.id);
                              setFloorId(item.floorId);
                            }}
                          >
                            <img src={assetUrl(item.thumbnailId)} alt="" />
                            <strong>{item.name}</strong>
                            <span>
                              {project.floors.find((f) => f.id === item.floorId)?.name} ·{' '}
                              {item.haov.toFixed(0)}°
                            </span>
                          </button>
                          {authenticated && editor && canEditWorkspace && (
                            <button
                              className="pano-button"
                              onClick={async () => {
                                try {
                                  setProject(
                                    await api.save({
                                      ...project,
                                      panoramas: project.panoramas
                                        .filter((p) => p.id !== item.id)
                                        .map((p) => ({
                                          ...p,
                                          hotspots: p.hotspots.filter(
                                            (h) => h.targetPanoramaId !== item.id,
                                          ),
                                        })),
                                    }, projectSlug),
                                  );
                                } catch (err) {
                                  setError(message(err));
                                }
                              }}
                            >
                              Удалить панораму «{item.name}»
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {tab === 'places' && !selected && (
                    <>
                      <h2>Куда отправимся?</h2>
                      <p className="muted intro">Найдите место на карте или в списке</p>
                      <label className="search-box">
                        <Search size={17} />
                        <input
                          value={query}
                          onChange={(event) => setQuery(event.target.value)}
                          placeholder="Поиск по названию"
                          aria-label="Поиск места"
                        />
                        <kbd>⌕</kbd>
                      </label>
                      <div className="filter-chips">
                        {['Все места', 'Залы', 'Сервисы'].map((item) => (
                          <button
                            key={item}
                            className={filter === item ? 'active' : ''}
                            onClick={() => setFilter(item)}
                          >
                            {item}
                          </button>
                        ))}
                      </div>
                      <div className="list-label">
                        <span>В ЭТОМ ПРОСТРАНСТВЕ</span>
                        <span>{project.places.length}</span>
                      </div>
                      <div className="places-list">
                        {project.places
                          .filter(
                            (place) =>
                              `${place.name} ${place.category} ${place.description}`
                                .toLocaleLowerCase('ru')
                                .includes(query.toLocaleLowerCase('ru')) &&
                              (filter === 'Все места' ||
                                (filter === 'Залы'
                                  ? /зал|перег|коворк/i.test(place.category)
                                  : !/зал|перег|коворк/i.test(place.category))),
                          )
                          .map((place) => {
                            const { Icon, fill, ink } = roomAppearance(place.name, place.category);
                            return (
                              <button
                                className="place-card"
                                key={place.id}
                                onClick={() => selectPlace(place)}
                              >
                                <span
                                  className="place-icon" style={{ backgroundColor: fill, color: ink, borderColor: fill }}
                                >
                                  <Icon size={18} />
                                </span>
                                <span className="place-card-text">
                                  <strong>{place.name}</strong>
                                  <small>
                                    {place.category} <i />{' '}
                                    {project.floors.find((f) => f.id === place.floorId)?.level} этаж
                                  </small>
                                </span>
                                <ChevronRight size={15} />
                              </button>
                            );
                          })}
                      </div>
                      {project.places.filter(
                        (place) =>
                          `${place.name} ${place.category} ${place.description}`
                            .toLocaleLowerCase('ru')
                            .includes(query.toLocaleLowerCase('ru')) &&
                          (filter === 'Все места' ||
                            (filter === 'Залы'
                              ? /зал|перег|коворк/i.test(place.category)
                              : !/зал|перег|коворк/i.test(place.category))),
                      ).length === 0 && (
                        <p className="empty-state">Место не найдено. Попробуйте другой запрос.</p>
                      )}
                    </>
                  )}
                  {tab === 'places' && selected && (
                    <>
                      <button className="back-button" onClick={() => setSelectedId(null)}>
                        <ArrowLeft size={16} /> Все места
                      </button>
                      <PlacePreview project={project} place={selected} />
                      <div className="detail-tag">{selected.category}</div>
                      <h2 className="place-title">{selected.name}</h2>
                      {editor && authenticated && canEditWorkspace ? (
                        <form
                          className="edit-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void save();
                          }}
                        >
                          <label>
                            Название
                            <input
                              aria-label="Название места"
                              required
                              maxLength={120}
                              value={draft.name}
                              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                            />
                          </label>
                          <label>
                            Категория
                            <input
                              aria-label="Категория места"
                              required
                              maxLength={80}
                              value={draft.category}
                              onChange={(event) =>
                                setDraft({ ...draft, category: event.target.value })
                              }
                            />
                          </label>
                          <label>
                            Описание
                            <textarea
                              aria-label="Описание места"
                              rows={5}
                              maxLength={2000}
                              value={draft.description}
                              onChange={(event) =>
                                setDraft({ ...draft, description: event.target.value })
                              }
                            />
                          </label>
                          <button className="primary-button" disabled={busy}>
                            {busy ? (
                              <LoaderCircle className="spin" size={16} />
                            ) : (
                              <Check size={16} />
                            )}{' '}
                            Сохранить изменения
                          </button>
                        </form>
                      ) : (
                        <>
                          <p className="place-description">{selected.description}</p>
                          <div className="detail-location">
                            <Layers3 size={16} />
                            <span>
                              {project.floors.find((f) => f.id === selected.floorId)?.name}
                            </span>
                          </div>
                          <button
                            className="primary-button"
                            onClick={() => {
                              setEnd(selected.nodeId);
                              setTab('route');
                              setRoute(null);
                            }}
                          >
                            <Navigation size={17} /> Проложить маршрут <ArrowRight size={16} />
                          </button>
                          <button
                            className="secondary-button"
                            onClick={() => {
                              setStart(selected.nodeId);
                              setTab('route');
                            }}
                          >
                            Начать отсюда
                          </button>
                        </>
                      )}
                    </>
                  )}
                  {tab === 'route' && (
                    <>
                      <h2>Ваш маршрут</h2>
                      <p className="muted intro">От входа до нужной двери</p>
                      <div className="route-inputs">
                        <label>
                          <span className="point-letter start-letter">А</span>
                          <span>
                            Откуда
                            <select
                              aria-label="Откуда"
                              value={start}
                              onChange={(event) => setStart(event.target.value)}
                            >
                              {project.places.map((place) => (
                                <option key={place.id} value={place.nodeId}>
                                  {place.name} ·{' '}
                                  {project.floors.find((f) => f.id === place.floorId)?.level} эт.
                                </option>
                              ))}
                            </select>
                          </span>
                        </label>
                        <button
                          className="swap-button"
                          aria-label="Поменять начало и конец"
                          onClick={() => {
                            setStart(end);
                            setEnd(start);
                          }}
                        >
                          <ArrowDownUp size={16} />
                        </button>
                        <label>
                          <span className="point-letter end-letter">Б</span>
                          <span>
                            Куда
                            <select
                              aria-label="Куда"
                              value={end}
                              onChange={(event) => setEnd(event.target.value)}
                            >
                              {project.places.map((place) => (
                                <option key={place.id} value={place.nodeId}>
                                  {place.name} ·{' '}
                                  {project.floors.find((f) => f.id === place.floorId)?.level} эт.
                                </option>
                              ))}
                            </select>
                          </span>
                        </label>
                      </div>
                      <label className="accessibility-option">
                        <input
                          type="checkbox"
                          checked={accessible}
                          onChange={(event) => setAccessible(event.target.checked)}
                        />
                        <span>
                          <strong>Без лестниц</strong>
                          <small>Через доступные проходы и лифт</small>
                        </span>
                      </label>
                      <button
                        className="primary-button"
                        onClick={() => void buildRoute()}
                        disabled={busy || !start || !end}
                      >
                        {busy ? (
                          <LoaderCircle className="spin" size={17} />
                        ) : (
                          <Navigation size={17} />
                        )}{' '}
                        Построить маршрут
                      </button>
                      {route && (
                        <div className="route-result" data-testid="route-result">
                          <button className="pano-button" onClick={() => setTab('panoramas')}>
                            Панорамы вдоль маршрута
                          </button>
                          <div className="route-summary">
                            <div>
                              <strong>
                                {Math.round(route.distanceMeters)} <small>м</small>
                              </strong>
                              <span>длина пути</span>
                            </div>
                            <div>
                              <strong>
                                {Math.ceil(route.durationSeconds / 60)} <small>мин</small>
                              </strong>
                              <span>примерно пешком</span>
                            </div>
                          </div>
                          <div className="route-profile">
                            <Check size={14} />{' '}
                            {accessible ? 'Маршрут без лестниц' : 'Кратчайший путь'}
                          </div>
                          <div className="route-floor-links">
                            {project.floors
                              .filter((f) => route.nodes.some((n) => n.floorId === f.id))
                              .map((f) => (
                                <button
                                  key={f.id}
                                  className={f.id === floor.id ? 'active' : ''}
                                  onClick={() => setFloorId(f.id)}
                                >
                                  {f.level} этаж <ArrowRight size={12} />
                                </button>
                              ))}
                          </div>
                          <ol className="route-steps">
                            {route.steps.map((step, i) => (
                              <li key={i}>
                                <span>{i + 1}</span>
                                <p>{step}</p>
                              </li>
                            ))}
                          </ol>
                          <p className="route-disclaimer">
                            Расстояния рассчитаны по условному масштабу. Местоположение выбирается
                            вручную.
                          </p>
                        </div>
                      )}
                      {!route && (
                        <div className="route-placeholder">
                          <Footprints size={29} />
                          <p>
                            Выберите начало и конец —<br />
                            покажем путь на плане
                          </p>
                        </div>
                      )}
                    </>
                  )}
                  {error && (
                    <div className="alert error" role="alert">
                      {error}
                    </div>
                  )}
                  {notice && (
                    <div className="alert success" role="status">
                      <Check size={15} />
                      {notice}
                    </div>
                  )}
                </div>
                <div className="sidebar-footer">
                  <span className="status-dot" />
                  <span>
                    Карта загружена <small>v{project.revision}</small>
                  </span>
                  <ShieldCheck size={14} />
                </div>
              </aside>
              <MapCanvas
                project={project}
                floor={floor}
                selected={selected}
                route={route}
                onSelect={(place) => {
                  selectPlace(place);
                  setTab('places');
                }}
                onFloor={setFloorId}
                onPanorama={setPanoramaId}
              />
            </div>
            <div className="below-map">
                        <span>
                <span className="tiny-brand">{isWorkspace ? 'КАРТА.' : 'ТТК.'}</span> Пространство становится понятным
              </span>
              <span>
                <LockKeyhole size={13} /> {isWorkspace ? 'Карта пользователя' : 'Публичная демоверсия'} {!isWorkspace && <><i /> Данные вымышлены</>}
              </span>
            </div>
          </>
        )}
      </main>
      <Suspense
        fallback={
          <div className="pano-backdrop" role="status">
            Загрузка просмотра…
          </div>
        }
      >
        {project && planOpen && authenticated && canEditWorkspace && (
          <PlanEditor
            project={project}
            mediaEnabled
            onClose={() => setPlanOpen(false)}
            onSave={async (next) => {
              const saved = await api.save(next, projectSlug);
              setProject(saved);
              setRoute(null);
              setSelectedId(null);
              setFloorId(saved.floors[0].id);
              setStart(saved.places[0]?.nodeId ?? '');
              setEnd(saved.places.at(-1)?.nodeId ?? '');
              return saved;
            }}
          />
        )}
        {project && studioOpen && authenticated && canEditWorkspace && (
          <PanoramaStudio
            project={project}
            spaceSlug={projectSlug}
            onClose={() => setStudioOpen(false)}
            onAttach={savePanorama}
          />
        )}
        {project && panorama && (
          <PanoramaViewer
            project={project}
            panorama={panorama}
            editable={authenticated && editor && canEditWorkspace}
            onClose={() => setPanoramaId(null)}
            onScene={setPanoramaId}
            onViewChange={() => {}}
            onSave={savePanorama}
            routeScenes={preview.complete ? preview.scenes.map((scene) => scene.id) : []}
          />
        )}
      </Suspense>
      {loginOpen && (
        <div className="modal-backdrop" onClick={() => setLoginOpen(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="login-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              aria-label="Закрыть вход"
              onClick={() => setLoginOpen(false)}
            >
              <X size={20} />
            </button>
            <span className="modal-icon">
              <LockKeyhole size={25} />
            </span>
            <h2 id="login-title">{isWorkspace ? 'Войдите в аккаунт' : 'Вход организатора'}</h2>
            <p>{isWorkspace ? 'Войдите под аккаунтом владельца, чтобы редактировать это пространство.' : 'Изменения сохраняются в черновике. Посетители увидят их после публикации.'}</p>
            <form onSubmit={login}>
              {isWorkspace && <label>
                Электронная почта
                <input
                  autoFocus
                  type="email"
                  required
                  autoComplete="email"
                  aria-label="Электронная почта"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>}
              <label>
                {isWorkspace ? 'Пароль аккаунта' : 'Пароль проекта'}
                <input
                  autoFocus={!isWorkspace}
                  type="password"
                  required
                  autoComplete="current-password"
                  aria-label={isWorkspace ? 'Пароль аккаунта' : 'Пароль проекта'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button className="primary-button" disabled={busy}>
                {isWorkspace ? 'Войти и редактировать' : 'Войти в редактор'} <ArrowRight size={16} />
              </button>
            </form>
            {!isWorkspace && <p className="modal-help">Пароль предоставляет организатор пространства.</p>}
            {isWorkspace && <p className="modal-help">Нет аккаунта? <a href="/register">Создайте свой — карты останутся независимыми.</a></p>}
            {error && (
              <div className="alert error" role="alert">
                {error}
              </div>
            )}
          </section>
        </div>
      )}
      {publishOpen && project && authenticated && canPublishWorkspace && (
        <div className="modal-backdrop" onClick={() => setPublishOpen(false)}>
          <section
            className="modal publish-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="publish-title"
            aria-busy={busy || publicationLoading}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              autoFocus
              className="modal-close"
              aria-label="Закрыть публикацию"
              onClick={() => setPublishOpen(false)}
            >
              ×
            </button>
            <span className="publish-eyebrow">ПУБЛИКАЦИЯ ПРОСТРАНСТВА</span>
            <h2 id="publish-title">Карта готова к показу?</h2>
            <p className="publish-intro">
              Ссылка на карту постоянная. Посетители увидят последнюю опубликованную версию.
            </p>
            <p className={`publish-version ${publishedRevision === project.revision ? 'is-current' : ''}`} aria-live="polite">
              {publicationLoading
                ? 'Проверяем статус публикации…'
                : publicationError
                  ? 'Не удалось проверить, какая версия опубликована.'
                  : publishedRevision === project.revision
                    ? `Версия ${project.revision} уже опубликована. Новых сохранённых изменений нет.`
                    : `Черновик v${project.revision} · опубликовано v${publishedRevision ?? '—'}. Будет опубликована сохранённая версия.`}
            </p>
            <button
              className="primary-button publish-action"
              disabled={busy || publicationLoading || Boolean(publicationError) || publishedRevision === project.revision}
              onClick={async () => {
                setBusy(true);
                setNotice('');
                setPublicationError('');
                try {
                  const published = await api.publish(project.revision, projectSlug);
                  setPublishedRevision(published.revision);
                  setNotice(`Опубликована версия ${published.revision}`);
                } catch (err) {
                  setPublicationError(message(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy
                ? 'Публикуем…'
                : publicationLoading
                  ? 'Проверяем версию…'
                  : publishedRevision === project.revision
                    ? 'Версия уже опубликована'
                    : 'Опубликовать сохранённую версию'}
            </button>
            {publicationError && (
              <div className="alert error publish-error" role="alert">
                <span>{publicationError}</span>
                <button type="button" className="secondary-button" onClick={() => void loadPublicationState()} disabled={publicationLoading}>
                  {publicationLoading ? 'Проверяем…' : 'Проверить ещё раз'}
                </button>
              </div>
            )}
            {notice && <p className="publish-success" role="status">{notice}</p>}
            <div className="publish-share-field">
              <label htmlFor="visitor-link">Ссылка посетителя</label>
              <div className="publish-copy-row">
                <input
                id="visitor-link"
                readOnly
                value={`${location.origin}/map/${projectSlug}`}
                onFocus={(e) => e.target.select()}
              />
                <button type="button" className="publish-copy" onClick={() => void copyPublicationValue(`${location.origin}/map/${projectSlug}`, 'link')}>
                  {copiedPublication === 'link' ? <><Check size={15} /> Скопировано</> : 'Скопировать'}
                </button>
              </div>
            </div>
            <details className="publish-embed">
              <summary>Встроить карту на сайт</summary>
              <textarea
                aria-label="Код для встраивания"
                readOnly
                rows={3}
                value={`<iframe src="${location.origin}/embed/${projectSlug}" title="Карта пространства" width="100%" height="720" loading="lazy"></iframe>`}
                onFocus={(e) => e.target.select()}
              />
              <button type="button" className="secondary-button publish-copy-embed" onClick={() => void copyPublicationValue(`<iframe src="${location.origin}/embed/${projectSlug}" title="Карта пространства" width="100%" height="720" loading="lazy"></iframe>`, 'embed')}>
                {copiedPublication === 'embed' ? 'Код скопирован' : 'Скопировать код'}
              </button>
              <a href={`/embed/${projectSlug}`} target="_blank" rel="noreferrer">
                Предпросмотр встраивания ↗
              </a>
            </details>
            <p className="modal-help">
              Несохранённые изменения конструктора в публикацию не входят.
            </p>
          </section>
        </div>
      )}
      {aboutOpen && (
        <div className="modal-backdrop" onClick={() => setAboutOpen(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              aria-label="Закрыть информацию"
              onClick={() => setAboutOpen(false)}
            >
              <X size={20} />
            </button>
            <span className="modal-icon">
              <Sparkles size={25} />
            </span>
            <h2 id="about-title">
              Знакомство с пространством
              <br />
              начинается здесь.
            </h2>
            <p>
              Создавайте планы и места, сшивайте фотографии в панорамы и связывайте их с маршрутами.
              Публикуйте карту по постоянной ссылке или скачивайте её для просмотра без интернета.
            </p>
            <p>
              «Атлас» — демонстрационный вымышленный объект. Размеры и доступность проходов не
              измерены в реальном здании. Маршрут рассчитывается по отмеченным проходам; панорамный
              предпросмотр доступен там, где добавлены связанные сцены.
            </p>
            <button className="primary-button" onClick={() => setAboutOpen(false)}>
              Исследовать карту <ArrowRight size={16} />
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
