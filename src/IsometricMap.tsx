import { useEffect, useState } from 'react';
import { roomAppearance } from './mapAppearance';
import { demoInterior, interiorColors } from './demoInterior';
import type { Decoration, MapNode, Place, Project, Route, Room } from './types';

interface Props {
  project: Project;
  details: boolean;
  activeFloorId: string;
  selected: Place | null;
  route: Route | null;
  onSelect: (place: Place) => void;
  onPanorama: (id: string) => void;
}

const levelGap = 176;

function point(x: number, y: number, level: number, floorCount: number): [number, number] {
  return [
    510 + (x - y) * 0.55,
    148 + Math.max(0, floorCount - 2) * 88 + (x + y) * 0.22 - level * levelGap,
  ];
}

function polygon(points: [number, number][]) {
  return points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

function roomCorners(room: Room) {
  return [
    [room.x, room.y],
    [room.x + room.width, room.y],
    [room.x + room.width, room.y + room.height],
    [room.x, room.y + room.height],
  ] as [number, number][];
}

function NodeSymbol({ node }: { node: MapNode }) {
  return (
    <g aria-label={node.kind === 'stairs' ? 'Лестница' : 'Лифт'}>
      <circle r="15" fill="#fff" stroke="#d5d8da" strokeWidth="1.4" />
      {node.kind === 'stairs' ? (
        <g
          fill="none"
          stroke="#24282b"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        >
          <path d="M-8 7h4V3h4v-4h4v-4h4" />
          <path d="m4-8 4 0 0 4" />
        </g>
      ) : (
        <g
          fill="none"
          stroke="#24282b"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
        >
          <path d="M0-8v16M-3-5l3-3 3 3M-3 5l3 3 3-3" />
        </g>
      )}
    </g>
  );
}

function RoomFurniture({
  room,
  level,
  floorCount,
  decorations,
}: {
  room: Room;
  level: number;
  floorCount: number;
  decorations: Decoration[];
}) {
  const fallback = decorations.length ? [] : demoInterior(room);
  if (!fallback.length) return null;
  return <g className="iso-interior" aria-hidden="true">
    {fallback.map((shape, i) => {
      const p = (x: number, y: number) => point(x, y, level, floorCount);
      const corners: [number, number][] = [[shape.x, shape.y], [shape.x + shape.width, shape.y], [shape.x + shape.width, shape.y + shape.height], [shape.x, shape.y + shape.height]];
      const projected = corners.map(([x, y]) => p(x, y));
      const surface = shape.round ? Array.from({ length: 16 }, (_, index) => {
        const angle = index * Math.PI / 8;
        return p(shape.x + shape.width / 2 + Math.cos(angle) * shape.width / 2, shape.y + shape.height / 2 + Math.sin(angle) * shape.height / 2);
      }) : projected;
      return <g key={i}>
        <polygon points={polygon([projected[2], projected[3], [projected[3][0], projected[3][1] + 4], [projected[2][0], projected[2][1] + 4]])} style={{ fill: '#a1afb4', strokeWidth: .5 }} />
        <polygon points={polygon(surface)} style={{ fill: interiorColors[shape.kind], stroke: '#8e9da5', strokeWidth: .6 }} />
      </g>;
    })}
  </g>;
}

export default function IsometricMap({
  project,
  details,
  activeFloorId,
  selected,
  route,
  onSelect,
  onPanorama,
}: Props) {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const floors = [...project.floors].sort((a, b) => a.level - b.level);
  const floorIndex = new Map(floors.map((floor, index) => [floor.id, index]));
  const floorCount = floors.length;
  const allRooms = project.rooms;
  const bounds = allRooms.length
    ? {
        left: Math.min(...allRooms.map((room) => room.x)),
        top: Math.min(...allRooms.map((room) => room.y)),
        right: Math.max(...allRooms.map((room) => room.x + room.width)),
        bottom: Math.max(...allRooms.map((room) => room.y + room.height)),
      }
    : { left: 100, top: 100, right: 900, bottom: 600 };
  const projectPoint = (x: number, y: number, floorId: string) =>
    point(x, y, floorIndex.get(floorId) ?? 0, floorCount);
  const routePoints = (route?.nodes ?? []).map((node) =>
    projectPoint(node.x, node.y, node.floorId),
  );

  return (
    <div className="isometric-map-wrap" data-testid="isometric-map">
      <svg
        className="isometric-map"
        viewBox={
          compact
            ? `220 0 760 ${520 + Math.max(0, floorCount - 2) * 176}`
            : `0 0 1020 ${560 + Math.max(0, floorCount - 2) * 176}`
        }
        role="group"
        aria-label={`Объёмная схема ${project.title}, ${floorCount} этажа`}
      >
        <defs>
          <filter id="iso-shadow" x="-20%" y="-20%" width="150%" height="160%">
            <feDropShadow
              dx="0"
              dy="12"
              stdDeviation="12"
              floodColor="#1f2428"
              floodOpacity=".12"
            />
          </filter>
          <linearGradient id="iso-hall" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f5f4f1" />
            <stop offset="1" stopColor="#eae9e5" />
          </linearGradient>
        </defs>

        <ellipse cx="510" cy="490" rx="340" ry="50" fill="#171a1c" opacity=".07" />

        {[...floors].reverse().map((floor) => {
          const level = floorIndex.get(floor.id) ?? 0;
          const p = (x: number, y: number) => point(x, y, level, floorCount);
          const frontLeft = p(bounds.left, bounds.bottom);
          const frontRight = p(bounds.right, bounds.bottom);
          const rearRight = p(bounds.right, bounds.top);
          const slabDepth = 22;
          const roomFloor = project.rooms.filter((room) => room.floorId === floor.id);
          return (
            <g
              key={floor.id}
              className={`iso-floor ${floor.id === activeFloorId ? 'is-active' : ''}`}
            >
              <polygon
                points={polygon([
                  frontRight,
                  frontLeft,
                  [frontLeft[0], frontLeft[1] + slabDepth],
                  [frontRight[0], frontRight[1] + slabDepth],
                ])}
                className="iso-slab-front"
              />
              <polygon
                points={polygon([
                  rearRight,
                  frontRight,
                  [frontRight[0], frontRight[1] + slabDepth],
                  [rearRight[0], rearRight[1] + slabDepth],
                ])}
                className="iso-slab-side"
              />
              <polygon
                points={polygon([
                  p(bounds.left, bounds.top),
                  p(bounds.right, bounds.top),
                  p(bounds.right, bounds.bottom),
                  p(bounds.left, bounds.bottom),
                ])}
                className="iso-floor-base"
                filter="url(#iso-shadow)"
              />
              {roomFloor.map((room) => (
                <g key={room.id} className={`iso-room ${room.kind}`}>
                  {(() => {
                    const corners = roomCorners(room).map(([x, y]) => p(x, y));
                    const [, rearRight, frontRight, frontLeft] = corners;
                    const wallHeight = 12;
                    return (
                      <>
                        <polygon
                          points={polygon([
                            frontRight,
                            frontLeft,
                            [frontLeft[0], frontLeft[1] + wallHeight],
                            [frontRight[0], frontRight[1] + wallHeight],
                          ])}
                          className="iso-room-front"
                        />
                        <polygon
                          points={polygon([
                            rearRight,
                            frontRight,
                            [frontRight[0], frontRight[1] + wallHeight],
                            [rearRight[0], rearRight[1] + wallHeight],
                          ])}
                          className="iso-room-side"
                        />
                        <polygon points={polygon(corners)} className="iso-room-top" style={{ fill: room.kind === 'corridor' ? '#fafbf9' : roomAppearance(room.name).fill }} />
                      </>
                    );
                  })()}
                  {details && <RoomFurniture room={room} level={level} floorCount={floorCount} decorations={(project.decorations ?? []).filter((item) => item.floorId === floor.id && item.roomId === room.id)} />}
                  {room.kind === 'room' &&
                    !project.places.some(
                      (place) =>
                        place.floorId === room.floorId &&
                        place.x >= room.x &&
                        place.x <= room.x + room.width &&
                        place.y >= room.y &&
                        place.y <= room.y + room.height,
                    ) && (
                      <text
                        x={
                          projectPoint(
                            room.x + room.width / 2,
                            room.y + room.height / 2,
                            room.floorId,
                          )[0]
                        }
                        y={
                          projectPoint(
                            room.x + room.width / 2,
                            room.y + room.height / 2,
                            room.floorId,
                          )[1] - 4
                        }
                        className="iso-room-label"
                      >
                        {room.name}
                      </text>
                    )}
                </g>
              ))}
              {(project.decorations ?? []).filter((item) => item.floorId === floor.id).map((item) => {
                const corners: [number, number][] = [[item.x, item.y], [item.x + item.width, item.y], [item.x + item.width, item.y + item.height], [item.x, item.y + item.height]];
                const projected = corners.map(([x, y]) => p(x, y));
                const center = p(item.x + item.width / 2, item.y + item.height / 2);
                const fill = item.kind === 'plant' ? interiorColors.plant : ({ table: interiorColors.table, chair: interiorColors.seat, sofa: '#8a718f', desk: '#8d9ca3', counter: interiorColors.counter, shelf: interiorColors.shelf }[item.kind] ?? '#a6b4ba');
                return <g key={`decoration-${item.id}`} className="iso-decoration" data-iso-decoration={item.id} transform={`rotate(${item.rotation ?? 0} ${center[0]} ${center[1]})`}>
                  <polygon points={polygon([projected[2], projected[3], [projected[3][0], projected[3][1] + 5], [projected[2][0], projected[2][1] + 5]])} style={{ fill: '#a1afb4', strokeWidth: .5 }} />
                  <polygon points={polygon(projected)} style={{ fill, stroke: '#71838c', strokeWidth: .8 }} />
                </g>;
              })}
              {project.nodes
                .filter(
                  (node) =>
                    node.floorId === floor.id &&
                    (node.kind === 'stairs' || node.kind === 'elevator'),
                )
                .map((node) => {
                  const [x, y] = p(node.x, node.y);
                  return (
                    <g key={node.id} transform={`translate(${x} ${y})`} className="iso-transition">
                      <title>{node.kind === 'stairs' ? 'Лестница' : 'Лифт'}</title>
                      <NodeSymbol node={node} />
                    </g>
                  );
                })}
              <g
                className="iso-floor-tag"
                transform={`translate(${p(bounds.left, bounds.top)[0] - 70} ${p(bounds.left, bounds.top)[1] + 16})`}
              >
                <rect x="-45" y="-20" width="90" height="38" rx="12" />
                <text y="-1">{floor.name}</text>
                <text y="11" className="iso-floor-subtitle">
                  {floor.id === activeFloorId ? 'ВЫБРАН' : `УРОВЕНЬ ${floor.level}`}
                </text>
              </g>
            </g>
          );
        })}

        {project.edges
          .filter((edge) => edge.kind === 'stairs' || edge.kind === 'elevator')
          .map((edge) => {
            const from = project.nodes.find((node) => node.id === edge.fromId);
            const to = project.nodes.find((node) => node.id === edge.toId);
            if (!from || !to || from.floorId === to.floorId) return null;
            const [x1, y1] = projectPoint(from.x, from.y, from.floorId);
            const [x2, y2] = projectPoint(to.x, to.y, to.floorId);
            return (
              <g key={edge.id} className={`iso-connector iso-connector-${edge.kind}`}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} />
                <line className="iso-connector-core" x1={x1} y1={y1} x2={x2} y2={y2} />
                <g transform={`translate(${x1} ${y1})`}>
                  <NodeSymbol node={from} />
                </g>
                <g transform={`translate(${x2} ${y2})`}>
                  <NodeSymbol node={to} />
                </g>
                <title>{edge.kind === 'stairs' ? 'Межэтажная лестница' : 'Межэтажный лифт'}</title>
              </g>
            );
          })}

        {routePoints.length > 1 && (
          <g className="iso-route" aria-label="Рассчитанный маршрут">
            <polyline points={polygon(routePoints)} fill="none" className="iso-route-halo" />
            <polyline points={polygon(routePoints)} fill="none" className="iso-route-line" />
          </g>
        )}

        {project.places
          .filter((place) => !place.id.startsWith('elevator'))
          .map((place) => {
            const [x, y] = projectPoint(place.x, place.y, place.floorId);
            const active = selected?.id === place.id;
            const start = route?.nodes[0]?.id === place.nodeId;
            const end = route?.nodes.at(-1)?.id === place.nodeId;
            return (
              <g
                key={place.id}
                data-place={place.id}
                className={`iso-place ${active ? 'is-selected' : ''} ${start ? 'is-start' : ''} ${end ? 'is-end' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={`Открыть ${place.name}, ${floors[floorIndex.get(place.floorId) ?? 0]?.name ?? ''}`}
                transform={`translate(${x} ${y})`}
                onClick={() => onSelect(place)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(place);
                  }
                }}
              >
                <circle r="20" className="iso-place-halo" />
                <circle r="11" className="iso-place-dot" />
                <circle r="3" fill="currentColor" />
                <text y="31" className="iso-place-label">
                  {place.name}
                </text>
              </g>
            );
          })}

        {project.panoramas.map((panorama) => {
          const [x, y] = projectPoint(panorama.x, panorama.y, panorama.floorId);
          return (
            <g
              key={panorama.id}
              transform={`translate(${x} ${y})`}
              className="iso-panorama"
              role="button"
              tabIndex={0}
              aria-label={`Открыть панораму: ${panorama.name}`}
              onClick={() => onPanorama(panorama.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onPanorama(panorama.id);
                }
              }}
            >
              <circle r="10" />
              <text y="4">360°</text>
            </g>
          );
        })}
      </svg>
      <div className="iso-caption">
        <strong>Объёмная схема</strong>
        <span>Лестница ↗ · лифт ↕ · красная линия — вычисленный маршрут</span>
        <span>Условная визуализация плана, не модель реального здания</span>
      </div>
    </div>
  );
}
