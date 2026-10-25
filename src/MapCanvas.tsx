import { assetUrl } from './offline';
import { saveDownload } from './download';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Box,
  Compass,
  LocateFixed,
  Minus,
  Plus,
  Layers3,
  Armchair,
  Maximize2,
  Minimize2,
  ScanLine,
} from 'lucide-react';
import type { Floor, Place, Project, Route } from './types';
import IsometricMap from './IsometricMap';
import { PlanDecorations, PlanFurniture, PlaceGlyph, placeInRoom, roomAppearance } from './mapAppearance';

interface Props {
  project: Project;
  floor: Floor;
  selected: Place | null;
  route: Route | null;
  onSelect: (place: Place) => void;
  onFloor: (id: string) => void;
  onPanorama: (id: string) => void;
}

export default function MapCanvas({
  project,
  floor,
  selected,
  route,
  onSelect,
  onFloor,
  onPanorama,
}: Props) {
  const [mode, setMode] = useState<'plan' | 'volume'>('plan');
  const [details, setDetails] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setExpanded(false); expandButton.current?.focus(); }
      if (event.key === 'Tab') {
        const controls = Array.from(stage.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? []);
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus(); }
        else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[0]?.focus(); }
      }
    };
    window.addEventListener('keydown', escape);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', escape); };
  }, [expanded]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const touchPointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const gestureMoved = useRef(false);
  const svg = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState({ width: 800, height: 600 });
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [floor.id]);
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, [mode, expanded]);
  const selectPlace = (place: Place) => { setExpanded(false); onSelect(place); };
  const width = floor.width / zoom;
  const height = floor.height / zoom;
  const pixelsPerMeter =
    Math.min(viewport.width / width, viewport.height / height) / floor.metersPerUnit;
  const scaleMeters = [10, 5, 2, 1].find((value) => value * pixelsPerMeter <= 120) ?? 1;
  const viewX = (floor.width - width) / 2 + pan.x;
  const viewY = (floor.height - height) / 2 + pan.y;
  const routeSegments: string[] = [];
  let segment: string[] = [];
  for (const node of route?.nodes ?? []) {
    if (node.floorId === floor.id) segment.push(`${node.x},${node.y}`);
    else if (segment.length) {
      routeSegments.push(segment.join(' '));
      segment = [];
    }
  }
  if (segment.length) routeSegments.push(segment.join(' '));
  const routeFloors = new Set(route?.nodes.map((node) => node.floorId));
  const places = project.places.filter((place) => place.floorId === floor.id);
  const rooms = project.rooms.filter((room) => room.floorId === floor.id);
  const bounds = rooms.length
    ? {
        left: Math.min(...rooms.map((room) => room.x)) - 18,
        top: Math.min(...rooms.map((room) => room.y)) - 18,
        right: Math.max(...rooms.map((room) => room.x + room.width)) + 18,
        bottom: Math.max(...rooms.map((room) => room.y + room.height)) + 18,
      }
    : null;
  const exportMap = () => {
    saveDownload(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }), 'atlas-project.json');
  };
  return (
    <section
      ref={stage}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded || undefined}
      className={`map-stage ${mode === 'volume' ? 'is-volume-view' : ''} ${expanded ? 'map-expanded' : ''}`}
      aria-label={project.slug === 'demo' ? 'Демонстрационная карта условного здания' : 'Интерактивная карта здания'}
    >
      <div className="map-topbar">
        <div className="floor-switch" aria-label="Выбор этажа">
          <Layers3 size={16} />
          {project.floors.map((item) => (
            <button
              key={item.id}
              className={floor.id === item.id ? 'active' : ''}
              onClick={() => onFloor(item.id)}
              aria-pressed={floor.id === item.id}
            >
              {item.level} этаж{routeFloors.has(item.id) && <i />}
            </button>
          ))}
        </div>
        <div className="map-topbar-tools">
          {project.slug === 'demo' && <button className="map-details-button" aria-label="Показать обстановку" aria-pressed={details} onClick={() => setDetails(!details)} title="Условная обстановка демонстрационного объекта"><Armchair size={16} /><span>Детали</span></button>}
          <div className="map-view-switch" role="group" aria-label="Режим отображения карты">
            <button
              className={mode === 'plan' ? 'active' : ''}
              aria-pressed={mode === 'plan'}
              onClick={() => setMode('plan')}
            >
              План
            </button>
            <button
              className={mode === 'volume' ? 'active' : ''}
              aria-pressed={mode === 'volume'}
              onClick={() => setMode('volume')}
            >
              <Box size={14} /> Объём
            </button>
          </div>
          <button ref={expandButton} className="map-expand-button" aria-label={expanded ? 'Свернуть карту' : 'Развернуть карту'} aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
        </div>
      </div>
      {mode === 'plan' ? (
        <>
          <svg
            ref={svg}
            className="floor-map"
            viewBox={`${viewX} ${viewY} ${width} ${height}`}
            aria-label={`План: ${floor.name}`}
            data-testid="floor-map"
            onWheel={(event) => {
              if (event.ctrlKey)
                setZoom((value) => Math.min(3.5, Math.max(0.7, value - event.deltaY * 0.003)));
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              if (!touchPointers.current.size) gestureMoved.current = false;
              if (event.pointerType === 'touch') {
                touchPointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                if (touchPointers.current.size === 2) {
                  const [a, b] = [...touchPointers.current.values()];
                  pinch.current = { distance: Math.max(1, Math.hypot(a.x-b.x, a.y-b.y)), zoom };
                  drag.current = null;
                  gestureMoved.current = true;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  return;
                }
              } else if ((event.target as Element).closest('[data-place]')) return;
              drag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y };
              if (event.pointerType !== 'touch') event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (touchPointers.current.has(event.pointerId)) {
                touchPointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                if (pinch.current && touchPointers.current.size >= 2) {
                  const [a,b] = [...touchPointers.current.values()];
                  setZoom(Math.min(3.5, Math.max(.7, pinch.current.zoom * Math.hypot(a.x-b.x,a.y-b.y) / pinch.current.distance)));
                  return;
                }
              }
              if (!drag.current || !svg.current) return;
              if (Math.hypot(event.clientX-drag.current.x, event.clientY-drag.current.y) <= 4) return;
              gestureMoved.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              const rect = svg.current.getBoundingClientRect();
              const scale = Math.min(rect.width / width, rect.height / height);
              setPan({
                x: drag.current.px - (event.clientX - drag.current.x) / scale,
                y: drag.current.py - (event.clientY - drag.current.y) / scale,
              });
            }}
            onPointerUp={(event) => {
              touchPointers.current.delete(event.pointerId);
              pinch.current = null;
              drag.current = null;
            }}
            onPointerCancel={(event) => {
              touchPointers.current.delete(event.pointerId);
              pinch.current = null;
              drag.current = null;
            }}
            onClickCapture={(event) => {
              if (gestureMoved.current) { event.preventDefault(); event.stopPropagation(); gestureMoved.current = false; }
            }}
          >
            <defs>
              <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill="#dedfdd" />
              </pattern>
              <filter id="building-shadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow
                  dx="0"
                  dy="12"
                  stdDeviation="14"
                  floodColor="#25334a"
                  floodOpacity=".08"
                />
              </filter>
            </defs>
            <rect x={viewX} y={viewY} width={width} height={height} fill="url(#dots)" />
            {floor.backgroundAssetId && (
              <image
                href={assetUrl(floor.backgroundAssetId)}
                x="0"
                y="0"
                width={floor.width}
                height={floor.height}
                preserveAspectRatio="xMidYMid meet"
                opacity="0.5"
              />
            )}
            <g filter="url(#building-shadow)">
              {bounds && !floor.backgroundAssetId && (
                <>
                  <rect
                    x={bounds.left}
                    y={bounds.top}
                    width={bounds.right - bounds.left}
                    height={bounds.bottom - bounds.top}
                    rx="8"
                    fill="#d6dce1"
                  />
                  <rect
                    x={bounds.left + 7}
                    y={bounds.top + 7}
                    width={bounds.right - bounds.left - 14}
                    height={bounds.bottom - bounds.top - 14}
                    rx="4"
                    fill="#f1f3f5"
                  />
                </>
              )}
              {rooms.map((room) => {
                const place = room.kind === 'room' ? placeInRoom(room, places) : undefined;
                const appearance = roomAppearance(room.name, place?.category);
                const active = !!place && selected?.id === place.id;
                return (
                  <g key={room.id} className={place ? 'selectable-room' : undefined}
                    data-place={place?.id ? `room-${place.id}` : undefined}
                    onClick={place ? () => selectPlace(place) : undefined}>
                    <title>{room.name}{place ? ' · нажмите, чтобы выбрать' : ''}</title>
                    <rect
                      x={room.x}
                      y={room.y}
                      width={room.width}
                      height={room.height}
                      rx="3"
                      fill={room.kind === 'corridor' ? '#fafbf9' : active ? '#fbe5df' : appearance.fill}
                      fillOpacity={floor.backgroundAssetId ? 0.65 : 1}
                      stroke={active ? '#e52713' : '#b9b7b2'}
                      strokeWidth={active ? 3 : 2}
                    />
                    {details && project.slug === 'demo' && !(project.decorations ?? []).some((item) => item.roomId === room.id) && <PlanFurniture room={room} />}
                    {details && <PlanDecorations items={(project.decorations ?? []).filter((item) => item.floorId === floor.id && item.roomId === room.id)} />}
                    {room.kind === 'room' && !place && (
                      <text
                        x={room.x + room.width / 2}
                        y={room.y + room.height / 2}
                        className="room-label"
                      >
                        {room.name}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
            {project.nodes
              .filter(
                (node) =>
                  node.floorId === floor.id &&
                  rooms.some(
                    (room) =>
                      room.kind === 'room' &&
                      (((Math.abs(node.y - room.y) < 0.01 ||
                        Math.abs(node.y - room.y - room.height) < 0.01) &&
                        node.x >= room.x &&
                        node.x <= room.x + room.width) ||
                        ((Math.abs(node.x - room.x) < 0.01 ||
                          Math.abs(node.x - room.x - room.width) < 0.01) &&
                          node.y >= room.y &&
                          node.y <= room.y + room.height)),
                  ),
              )
              .map((node) => (
                <g
                  key={`door-${node.id}`}
                  transform={(() => {
                    const room = rooms.find((r) => r.kind === 'room' && node.x >= r.x && node.x <= r.x + r.width && node.y >= r.y && node.y <= r.y + r.height && (Math.abs(node.x - r.x) < .01 || Math.abs(node.x - r.x - r.width) < .01 || Math.abs(node.y - r.y) < .01 || Math.abs(node.y - r.y - r.height) < .01));
                    if (!room) return undefined;
                    const angle = Math.abs(node.x - room.x) < .01 ? 90 : Math.abs(node.x - room.x - room.width) < .01 ? 270 : Math.abs(node.y - room.y) < .01 ? 180 : 0;
                    return `rotate(${angle} ${node.x} ${node.y})`;
                  })()}
                >
                  <rect x={node.x - 12} y={node.y - 3} width="24" height="6" fill="#f2f4f5" />
                  <path
                    d={`M${node.x - 12},${node.y} v-22 a22,22 0 0 1 22,22`}
                    fill="none"
                    stroke="#8195a2"
                    strokeWidth="1.4"
                  />
                </g>
              ))}
            <text x={floor.width / 2} y={bounds ? bounds.top - 29 : 80} className="building-label">
              {project.title.toLocaleUpperCase('ru')}
            </text>
            <text x={floor.width / 2} y={floor.height - 30} className="floor-label">
              {floor.name.toUpperCase()} · УСЛОВНЫЙ ПЛАН
            </text>
            {routeSegments.map((points, index) => (
              <g key={index} data-testid="route-segment">
                <polyline
                  points={points}
                  stroke="white"
                  strokeWidth="12"
                  fill="none"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <polyline
                  className="route-line"
                  points={points}
                  stroke="#e52713"
                  strokeWidth="5"
                  fill="none"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            ))}
            {project.nodes
              .filter(
                (node) =>
                  node.floorId === floor.id && (node.kind === 'stairs' || node.kind === 'elevator'),
              )
              .map((node) => (
                <g
                  key={node.id}
                  transform={`translate(${node.x},${node.y})`}
                  className={`map-transition map-transition-${node.kind}`}
                >
                  <rect x="-15" y="-15" width="30" height="30" rx="9" />
                  {node.kind === 'stairs' ? (
                    <path d="M-8 7h4V3h4v-4h4v-4h4M4-5l4 0 0 4" />
                  ) : (
                    <path d="M0-9v18M-4-5l4-4 4 4M-4 5l4 4 4-4" />
                  )}
                  <text x="20" y="4" className="transition-label">
                    {node.kind === 'stairs' ? 'Лестница' : 'Лифт'}
                  </text>
                </g>
              ))}
            {places
              .filter((place) => !place.id.startsWith('elevator'))
              .map((place) => {
                const active = selected?.id === place.id;
                const start = route?.nodes[0]?.id === place.nodeId;
                const end = route?.nodes.at(-1)?.id === place.nodeId;
                return (
                  <g
                    key={place.id}
                    data-place={place.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Открыть ${place.name}`}
                    className="map-place"
                    transform={`translate(${place.x},${place.y})`}
                    onClick={() => selectPlace(place)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        selectPlace(place);
                      }
                    }}
                  >
                    <circle className="map-place-hit" r="32" fill="transparent" />
                    {(active || start || end) && (
                      <circle r="24" fill={start ? '#ebe9e5' : '#fce8e4'} />
                    )}
                    <circle
                      r="15"
                      fill={start ? '#292a2c' : active || end ? '#e52713' : '#fff'}
                      stroke={start ? '#292a2c' : active || end ? '#e52713' : '#a7a6a3'}
                      strokeWidth="1.5"
                    />
                    {start || end ? <text textAnchor="middle" dy="5" fontSize="13" fontWeight="700" fill="white">{start ? 'А' : 'Б'}</text>
                      : <PlaceGlyph place={place} active={active} />}
                    <text
                      y="35"
                      textAnchor="middle"
                      className={`place-label ${active ? 'selected' : ''}`}
                    >
                      {place.name}
                    </text>
                  </g>
                );
              })}
            {project.panoramas
              .filter((p) => p.floorId === floor.id)
              .map((p) => (
                <g
                  key={p.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Открыть панораму: ${p.name}`}
                  style={{ cursor: 'pointer' }}
                  transform={`translate(${p.x} ${p.y})`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => onPanorama(p.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onPanorama(p.id);
                    }
                  }}
                >
                  <circle r="19" fill="#292a2c" stroke="white" strokeWidth="3" />
                  <rect
                    x="-11"
                    y="-7"
                    width="22"
                    height="15"
                    rx="3"
                    fill="none"
                    stroke="white"
                    strokeWidth="2"
                  />
                  <circle r="4" fill="white" />
                  <title>{p.name}</title>
                </g>
              ))}
          </svg>
          <div className="map-bottom-left">
            <div className="north">
              <Compass size={23} />
              <span>С</span>
            </div>
            <div className="scale">
              <span style={{ width: `${scaleMeters * pixelsPerMeter}px` }} />
              {scaleMeters} м <small>по масштабу демо</small>
            </div>
          </div>
          {route && route.nodes.some((node) => node.floorId === floor.id) && (
            <button className="route-focus-button" onClick={() => {
              const nodes = route.nodes.filter((node) => node.floorId === floor.id);
              const minX = Math.min(...nodes.map((node) => node.x));
              const maxX = Math.max(...nodes.map((node) => node.x));
              const minY = Math.min(...nodes.map((node) => node.y));
              const maxY = Math.max(...nodes.map((node) => node.y));
              setZoom(Math.max(.7, Math.min(3.5, floor.width / (maxX - minX + 180), floor.height / (maxY - minY + 240))));
              setPan({ x: (minX + maxX - floor.width) / 2, y: (minY + maxY - floor.height) / 2 });
            }}><ScanLine size={16} /> Показать маршрут</button>
          )}
          <div className="map-controls">
            <button
              aria-label="Увеличить карту"
              onClick={() => setZoom((value) => Math.min(3.5, value + 0.25))}
            >
              <Plus size={19} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              aria-label="Уменьшить карту"
              onClick={() => setZoom((value) => Math.max(0.7, value - 0.25))}
            >
              <Minus size={19} />
            </button>
            <div />
            <button
              aria-label="Показать весь этаж"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
            >
              <LocateFixed size={19} />
            </button>
          </div>
          <div className="map-footnote">
            <span>
              <span className="legend-dot" /> Место
            </span>
            <span>
              <span className="legend-stairs">↗</span> Лестница
            </span>
            <span>
              <span className="legend-elevator">↕</span> Лифт
            </span>
            {project.slug === 'demo' && <button onClick={exportMap}>
              <ArrowDownToLine size={14} /> Экспорт проекта
            </button>}
            <span className="map-tip">
              <ArrowUpRight size={13} /> {details && project.slug === 'demo' ? 'Обстановка условная · выберите место' : 'Выберите место, чтобы узнать больше'}
            </span>
          </div>
        </>
      ) : (
        <IsometricMap
          project={project}
          details={details}
          activeFloorId={floor.id}
          selected={selected}
          route={route}
          onSelect={selectPlace}
          onPanorama={onPanorama}
        />
      )}
    </section>
  );
}
