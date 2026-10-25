import { assetUrl } from './offline';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api } from './api';
import PlanPreview from './PlanPreview';
import { roomAppearance } from './mapAppearance';
import IsometricMap from './IsometricMap';
import { demoInterior, interiorColors } from './demoInterior';
import { MousePointer2, Square, RectangleHorizontal, CircleDot, DoorOpen, MapPin, GitBranch, Move, Undo2, Redo2, Eye, Pencil, Save, Layers3, Cuboid } from 'lucide-react';
import type { Decoration, DecorationKind, Edge, Project } from './types';
import { readRoomPlan, renderRoomPlan, roomPlanBounds, type RoomPlanScan } from './roomPlan';
import './plan-editor.css';

type Selection = { kind: 'rooms' | 'nodes' | 'places' | 'edges' | 'decorations'; id: string };
type Tool = 'select' | 'room' | 'corridor' | 'node' | 'door' | 'place' | 'edge' | 'decoration' | 'move';
type ObjectFilter = 'all' | 'rooms' | 'places' | 'routes' | 'decorations';
const labels: Record<Tool, string> = {
  select: 'Выбор',
  room: 'Комната',
  corridor: 'Коридор',
  node: 'Узел пути',
  door: 'Дверь',
  place: 'Место',
  edge: 'Проход',
  decoration: 'Декорация',
  move: 'Перемещение',
};
const decorationLabels: Record<DecorationKind, string> = {
  table: 'Стол',
  chair: 'Стул',
  sofa: 'Диван',
  desk: 'Рабочий стол',
  plant: 'Растение',
  counter: 'Стойка',
  shelf: 'Стеллаж',
};
const toolIcons = { select: MousePointer2, room: Square, corridor: RectangleHorizontal, node: CircleDot, door: DoorOpen, place: MapPin, edge: GitBranch, decoration: Square, move: Move };
const uid = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return `local-${Date.now().toString(36)}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};
const boundedNumber = (raw: string, fallback: number, min: number, max: number) => {
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
};
function hydrateDemoDecorations(project: Project): Project {
  if (project.slug !== 'demo' || project.decorations?.length) return structuredClone(project);
  const decorations: Decoration[] = project.rooms.flatMap((room) => demoInterior(room).map((shape, index) => ({
    id: `demo-decoration-${room.id}-${index}`,
    floorId: room.floorId,
    roomId: room.id,
    kind: (shape.kind === 'seat' ? 'chair' : shape.kind === 'stage' ? 'counter' : shape.kind) as DecorationKind,
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    rotation: 0,
  })));
  return { ...structuredClone(project), decorations };
}
function validateDraft(project: Project) {
  if (!project.floors.length) return 'Добавьте хотя бы один этаж.';
  for (const floor of project.floors) {
    if (![floor.width, floor.height, floor.metersPerUnit].every(Number.isFinite) || floor.width <= 0 || floor.height <= 0 || floor.metersPerUnit <= 0)
      return `Проверьте размеры и масштаб этажа «${floor.name}»: значения должны быть положительными.`;
  }
  const floors = new Set(project.floors.map((floor) => floor.id));
  for (const room of project.rooms) {
    const floor = project.floors.find((candidate) => candidate.id === room.floorId);
    if (!floor || ![room.x, room.y, room.width, room.height].every(Number.isFinite) || room.width <= 0 || room.height <= 0 || room.x < 0 || room.y < 0 || room.x + room.width > floor.width || room.y + room.height > floor.height)
      return `Помещение «${room.name}» выходит за границы этажа или имеет неверный размер.`;
  }
  const nodes = new Map(project.nodes.map((node) => [node.id, node]));
  for (const node of project.nodes) {
    const floor = project.floors.find((candidate) => candidate.id === node.floorId);
    if (!floor || !floors.has(node.floorId) || ![node.x, node.y].every(Number.isFinite) || node.x < 0 || node.y < 0 || node.x > floor.width || node.y > floor.height)
      return `Узел «${node.label}» находится вне границ этажа.`;
  }
  for (const edge of project.edges) {
    const from = nodes.get(edge.fromId), to = nodes.get(edge.toId);
    if (!from || !to) return 'В графе есть проход со ссылкой на удалённый узел.';
    if (from.floorId !== to.floorId && (edge.kind === 'walk' || !edge.distanceMeters || edge.distanceMeters <= 0))
      return 'Межэтажные проходы должны иметь тип лестницы/лифта и положительную длину.';
  }
  return '';
}

export default function PlanEditor({
  project,
  onClose,
  onSave,
  mediaEnabled = true,
}: {
  project: Project;
  onClose: () => void;
  onSave: (project: Project) => Promise<Project>;
  mediaEnabled?: boolean;
}) {
  const [draft, setDraft] = useState(() => hydrateDemoDecorations(project));
  const [baseline, setBaseline] = useState(() => JSON.stringify(hydrateDemoDecorations(project)));
  const [history, setHistory] = useState<Project[]>([]);
  const [future, setFuture] = useState<Project[]>([]);
  const [preview, setPreview] = useState(false);
  const [view3d, setView3d] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'canvas' | 'tools' | 'properties'>('canvas');
  const [objectQuery, setObjectQuery] = useState('');
  const [objectFilter, setObjectFilter] = useState<ObjectFilter>('all');
  const [layers, setLayers] = useState({ background: true, graph: true, labels: true, interior: true });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [floorId, setFloorId] = useState(project.floors[0].id);
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const [edgeStart, setEdgeStart] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [snap, setSnap] = useState(true);
  const [roomPlan, setRoomPlan] = useState<RoomPlanScan | null>(null);
  const [roomPlanStory, setRoomPlanStory] = useState(0);
  const [roomPlanPreviewUrl, setRoomPlanPreviewUrl] = useState('');
  useEffect(() => {
    if (!roomPlanPreviewUrl) return;
    return () => URL.revokeObjectURL(roomPlanPreviewUrl);
  }, [roomPlanPreviewUrl]);
  const [scaleError, setScaleError] = useState('');
  const [decorationKind, setDecorationKind] = useState<DecorationKind>('table');
  const decorationFill: Record<DecorationKind, string> = { table: interiorColors.table, chair: interiorColors.seat, sofa: '#8a718f', desk: '#8d9ca3', plant: interiorColors.plant, counter: interiorColors.counter, shelf: interiorColors.shelf };
  const svg = useRef<SVGSVGElement>(null);
  const planScroll = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const dragRef = useRef<{ pointerId: number; selection: Selection; initial: Project; startX: number; startY: number; originX: number; originY: number; originWidth?: number; originHeight?: number; operation: 'move' | 'resize'; moved: boolean } | null>(null);
  const drawDragRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const suppressClick = useRef(false);
  const [canvasWidth, setCanvasWidth] = useState(800);
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setCanvasWidth(entry.contentRect.width);
    });
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, [preview]);
  const modal = useRef<HTMLDivElement>(null);
  const closeRef = useRef<() => void>(() => {});
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    modal.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if ((event.target as Element).closest('[role="dialog"]') !== modal.current) return;
      if (event.key === 'Escape') closeRef.current();
      if (event.key !== 'Tab') return;
      const items = Array.from(
        modal.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
        ) ?? [],
      ).filter((e) => e.getClientRects().length && !e.closest('[inert]'));
      const first = items[0],
        last = items.at(-1);
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
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', keydown);
      prior?.focus();
    };
  }, []);
  const floor = draft.floors.find((f) => f.id === floorId) ?? draft.floors[0];
  const pendingEdgeNode = edgeStart ? draft.nodes.find((node) => node.id === edgeStart) : null;
  // ResizeObserver can briefly report a zero/small width while the editor
  // mounts or a floor changes. Keep SVG hit targets bounded during that frame
  // so one node cannot balloon over the whole plan and intercept other clicks.
  const markerRadius = Math.min(24, Math.max(8, (9 * floor.width) / Math.max(320, canvasWidth)));
  const labelSize = Math.min(28, Math.max(12, (12 * floor.width) / Math.max(320, canvasWidth)));
  const item = selection ? draft[selection.kind].find((item) => item.id === selection.id) : null;
  const dirty = JSON.stringify(draft) !== baseline;
  const change = (next: Project) => {
    setHistory((h) => [...h.slice(-39), draft]);
    setFuture([]);
    setDraft(next);
    setError('');
    setNotice('');
  };
  const planPoint = (clientX: number, clientY: number) => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return {
      x: Math.max(0, Math.min(floor.width, point.x)),
      y: Math.max(0, Math.min(floor.height, point.y)),
    };
  };
  const startObjectDrag = (event: ReactPointerEvent<SVGElement>, target: Selection, operation: 'move' | 'resize' = 'move') => {
    if (tool !== 'select' || event.button !== 0 || busy) return;
    const point = planPoint(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    setSelection(target);
    const targetItem = draft[target.kind].find((candidate) => candidate.id === target.id) as (typeof item & { x: number; y: number; width?: number; height?: number }) | undefined;
    if (!targetItem) return;
    const selectedNodeId = target.kind === 'places'
      ? draft.places.find((place) => place.id === target.id)?.nodeId
      : target.kind === 'nodes' ? target.id : null;
    const node = selectedNodeId ? draft.nodes.find((candidate) => candidate.id === selectedNodeId) : null;
    const originX = node?.x ?? targetItem.x;
    const originY = node?.y ?? targetItem.y;
    dragRef.current = {
      pointerId: event.pointerId,
      selection: target,
      initial: draft,
      startX: point.x,
      startY: point.y,
      originX,
      originY,
      originWidth: targetItem.width,
      originHeight: targetItem.height,
      operation,
      moved: false,
    };
    svg.current?.setPointerCapture(event.pointerId);
  };
  const updateObjectDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = planPoint(event.clientX, event.clientY);
    if (!point) return;
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 1.5) return;
    drag.moved = true;
    event.preventDefault();
    suppressClick.current = true;
    const { selection: target, initial, operation } = drag;
    let next: Project = initial;
    if (target.kind === 'rooms') {
      next = { ...initial, rooms: initial.rooms.map((room) => {
        if (room.id !== target.id) return room;
        if (operation === 'resize') {
          const width = Math.max(10, Math.min(floor.width - room.x, drag.originWidth! + dx));
          const height = Math.max(10, Math.min(floor.height - room.y, drag.originHeight! + dy));
          return { ...room, width: snap ? Math.max(10, Math.round(width / 10) * 10) : width, height: snap ? Math.max(10, Math.round(height / 10) * 10) : height };
        }
        const x = Math.max(0, Math.min(floor.width - room.width, drag.originX + dx));
        const y = Math.max(0, Math.min(floor.height - room.height, drag.originY + dy));
        return { ...room, x: snap ? Math.round(x / 10) * 10 : x, y: snap ? Math.round(y / 10) * 10 : y };
      }) };
    } else if (target.kind === 'decorations') {
      next = { ...initial, decorations: (initial.decorations ?? []).map((decoration) => {
        if (decoration.id !== target.id) return decoration;
        if (operation === 'resize') {
          const width = Math.max(8, Math.min(floor.width - decoration.x, drag.originWidth! + dx));
          const height = Math.max(8, Math.min(floor.height - decoration.y, drag.originHeight! + dy));
          return { ...decoration, width: snap ? Math.max(8, Math.round(width / 10) * 10) : width, height: snap ? Math.max(8, Math.round(height / 10) * 10) : height };
        }
        const x = Math.max(0, Math.min(floor.width - decoration.width, drag.originX + dx));
        const y = Math.max(0, Math.min(floor.height - decoration.height, drag.originY + dy));
        return { ...decoration, x: snap ? Math.round(x / 10) * 10 : x, y: snap ? Math.round(y / 10) * 10 : y };
      }) };
    } else if (target.kind === 'nodes' || target.kind === 'places') {
      const nodeId = target.kind === 'nodes' ? target.id : initial.places.find((place) => place.id === target.id)?.nodeId;
      if (!nodeId) return;
      const x0 = Math.max(0, Math.min(floor.width, drag.originX + dx));
      const y0 = Math.max(0, Math.min(floor.height, drag.originY + dy));
      const x = snap ? Math.round(x0 / 10) * 10 : x0;
      const y = snap ? Math.round(y0 / 10) * 10 : y0;
      next = {
        ...initial,
        nodes: initial.nodes.map((node) => node.id === nodeId ? { ...node, x, y } : node),
        places: initial.places.map((place) => place.nodeId === nodeId ? { ...place, x, y } : place),
        panoramas: initial.panoramas.map((panorama) => panorama.nodeId === nodeId ? { ...panorama, x, y } : panorama),
      };
    }
    setDraft(next);
  };
  const finishObjectDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      setHistory((historyItems) => [...historyItems.slice(-39), drag.initial]);
      setFuture([]);
      setNotice(drag.operation === 'resize' ? 'Размер обновлён. Изменение можно отменить.' : 'Объект перемещён. Изменение можно отменить.');
      setError('');
    }
    dragRef.current = null;
    if (svg.current?.hasPointerCapture(event.pointerId)) svg.current.releasePointerCapture(event.pointerId);
  };
  const finishRoomDraw = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drawing = drawDragRef.current;
    if (!drawing || drawing.pointerId !== event.pointerId) return;
    const end = planPoint(event.clientX, event.clientY);
    drawDragRef.current = null;
    if (!end || Math.hypot(end.x - drawing.startX, end.y - drawing.startY) < 10) {
      if (anchorRef.current?.x === drawing.startX && anchorRef.current?.y === drawing.startY) {
        setAnchor(null); anchorRef.current = null;
      }
      return;
    }
    const x = snap ? Math.round(end.x / 10) * 10 : end.x;
    const y = snap ? Math.round(end.y / 10) * 10 : end.y;
    const width = Math.abs(x - drawing.startX);
    const height = Math.abs(y - drawing.startY);
    if (width < 10 || height < 10) {
      setError('Комната слишком мала. Растяните блок хотя бы на 10 единиц по каждой стороне.');
      setAnchor(null);
      anchorRef.current = null;
      return;
    }
    const room: Project['rooms'][number] = {
      id: uid(), floorId: floor.id,
      name: tool === 'room' ? 'Новое помещение' : 'Коридор',
      kind: tool === 'room' ? 'room' : 'corridor',
      x: Math.min(x, drawing.startX), y: Math.min(y, drawing.startY), width, height,
    };
    setHistory((historyItems) => [...historyItems.slice(-39), draft]);
    setFuture([]);
    setDraft((current) => ({ ...current, rooms: [...current.rooms, room] }));
    setSelection({ kind: 'rooms', id: room.id });
    setNotice('Блок создан. Потяните за угол, чтобы изменить размер; имя и точные размеры — справа.');
    setError('');
    setAnchor(null);
    anchorRef.current = null;
    suppressClick.current = true;
    if (svg.current?.hasPointerCapture(event.pointerId)) svg.current.releasePointerCapture(event.pointerId);
  };
  const decorationSizes: Record<DecorationKind, [number, number]> = { table: [70, 45], chair: [24, 24], sofa: [90, 32], desk: [80, 36], plant: [24, 24], counter: [110, 28], shelf: [90, 22] };
  const addDecoration = (atX?: number, atY?: number) => {
    const room = selection?.kind === 'rooms' ? draft.rooms.find((item) => item.id === selection.id) : null;
    const [width, height] = decorationSizes[decorationKind];
    const x0 = atX ?? (room ? room.x + room.width / 2 : floor.width / 2);
    const y0 = atY ?? (room ? room.y + room.height / 2 : floor.height / 2);
    const containingRoom = room ?? draft.rooms.find((candidate) => candidate.floorId === floor.id && candidate.kind === 'room' && x0 >= candidate.x && x0 <= candidate.x + candidate.width && y0 >= candidate.y && y0 <= candidate.y + candidate.height);
    const minX = containingRoom ? containingRoom.x + 4 : 0;
    const maxX = containingRoom ? containingRoom.x + containingRoom.width - width - 4 : floor.width - width;
    const minY = containingRoom ? containingRoom.y + 4 : 0;
    const maxY = containingRoom ? containingRoom.y + containingRoom.height - height - 4 : floor.height - height;
    if (maxX < minX || maxY < minY) {
      setError('В выбранной комнате недостаточно места для этой декорации.');
      return;
    }
    const next = { id: uid(), floorId: floor.id, roomId: containingRoom?.id, kind: decorationKind, x: Math.max(minX, Math.min(maxX, x0 - width / 2)), y: Math.max(minY, Math.min(maxY, y0 - height / 2)), width, height, rotation: 0 };
    change({ ...draft, decorations: [...(draft.decorations ?? []), next] });
    setSelection({ kind: 'decorations', id: next.id });
    setTool('select');
    setNotice(`Декорация «${decorationLabels[decorationKind]}» размещена на плане.`);
  };
  const restore = (next: Project) => {
    setDraft(next);
    setSelection((current) => current && next[current.kind].some((item) => item.id === current.id) ? current : null);
    anchorRef.current = null; setAnchor(null); setEdgeStart(''); setTool('select'); setError(''); setNotice('');
    if (!next.floors.some((f) => f.id === floorId)) setFloorId(next.floors[0].id);
  };
  const undo = () => { if (!history.length || busy) return; setFuture((f) => [...f, draft]); restore(history.at(-1)!); setHistory((h) => h.slice(0, -1)); };
  const redo = () => { if (!future.length || busy) return; setHistory((h) => [...h, draft]); restore(future.at(-1)!); setFuture((f) => f.slice(0, -1)); };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (preview || (event.target as Element).closest('input,textarea,select,[contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });
  const switchTool = (value: Tool) => {
    setTool(value);
    setMobilePanel('canvas');
    setCursor(null);
    if (value === 'edge' || value === 'node' || value === 'door' || value === 'place') setLayers((current) => ({ ...current, graph: true }));
    anchorRef.current = null;
    setAnchor(null);
    // Keep a pending cross-floor connection while the operator switches to
    // the node tool to place the matching endpoint. It can be cancelled only
    // with the explicit “Сбросить начало” action in the connection card.
  };
  const switchFloor = (nextFloorId: string) => {
    if (nextFloorId === floor.id) return;
    const pending = edgeStart ? draft.nodes.find((node) => node.id === edgeStart) : null;
    setFloorId(nextFloorId);
    setSelection(null);
    setCursor(null);
    setAnchor(null);
    anchorRef.current = null;
    if (pending) {
      setTool('edge');
      setNotice(`Начало связи сохранено: «${pending.label}». На новом этаже выберите второй узел того же типа.`);
      setError('');
    } else {
      setNotice('');
    }
  };
  const toggle3d = () => {
    setView3d((current) => !current);
  };
  const patch = (values: Record<string, unknown>) => {
    if (!selection) return;
    if (selection.kind === 'nodes' && typeof values.kind === 'string') {
      const node = draft.nodes.find((candidate) => candidate.id === selection.id);
      if (!node || !['walk', 'stairs', 'elevator'].includes(values.kind)) return;
      const nextKind = values.kind as typeof node.kind;
      const crossing = draft.edges.filter((edge) =>
        edge.fromId === node.id || edge.toId === node.id,
      ).some((edge) => {
        const otherId = edge.fromId === node.id ? edge.toId : edge.fromId;
        const other = draft.nodes.find((candidate) => candidate.id === otherId);
        return other && other.floorId !== node.floorId;
      });
      if (crossing && nextKind === 'walk') {
        setError('Межэтажный узел должен быть лестницей или лифтом. Сначала удалите межэтажные проходы.');
        return;
      }
      const nextNodes = draft.nodes.map((candidate) =>
        candidate.id === node.id ? { ...candidate, kind: nextKind } : candidate,
      );
      const nextEdges = draft.edges.map((edge) => {
        if (edge.fromId !== node.id && edge.toId !== node.id) return edge;
        const otherId = edge.fromId === node.id ? edge.toId : edge.fromId;
        const other = draft.nodes.find((candidate) => candidate.id === otherId);
        if (!other || other.floorId === node.floorId) return edge;
        return {
          ...edge,
          kind: nextKind,
          accessible: nextKind !== 'stairs',
          distanceMeters: edge.distanceMeters && edge.distanceMeters > 0 ? edge.distanceMeters : 6,
        };
      });
      change({ ...draft, nodes: nextNodes, edges: nextEdges });
      return;
    }
    if (selection.kind === 'rooms' && ('width' in values || 'height' in values)) {
      const room = draft.rooms.find((candidate) => candidate.id === selection.id);
      if (!room) return;
      const width = boundedNumber(String(values.width ?? room.width), room.width, 10, Math.max(10, floor.width - room.x));
      const height = boundedNumber(String(values.height ?? room.height), room.height, 10, Math.max(10, floor.height - room.y));
      values = { ...values, width, height };
    }
    if (selection.kind === 'decorations') {
      const decoration = (draft.decorations ?? []).find((candidate) => candidate.id === selection.id);
      if (!decoration) return;
      const width = boundedNumber(String(values.width ?? decoration.width), decoration.width, 8, floor.width);
      const height = boundedNumber(String(values.height ?? decoration.height), decoration.height, 8, floor.height);
      values = { ...values, width, height, x: boundedNumber(String(values.x ?? decoration.x), decoration.x, 0, Math.max(0, floor.width - width)), y: boundedNumber(String(values.y ?? decoration.y), decoration.y, 0, Math.max(0, floor.height - height)) };
    }
    const next = {
      ...draft,
      [selection.kind]: draft[selection.kind].map((item) =>
        item.id === selection.id ? { ...item, ...values } : item,
      ),
    };
    if (selection.kind === 'places' && typeof values.name === 'string') {
      const place = draft.places.find((p) => p.id === selection.id);
      next.nodes = draft.nodes.map((n) =>
        n.id === place?.nodeId ? { ...n, label: values.name as string } : n,
      );
    }
    change(next);
  };
  const updateFloor = (values: Record<string, unknown>) =>
    change({
      ...draft,
      floors: draft.floors.map((f) => (f.id === floor.id ? { ...f, ...values } : f)),
    });
  const move = (x: number, y: number) => {
    if (!selection || !item || !('x' in item)) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (selection.kind === 'rooms') {
      const room = item as Project['rooms'][number];
      patch({ x: Math.max(0, Math.min(floor.width - room.width, x)), y: Math.max(0, Math.min(floor.height - room.height, y)) });
      return;
    }
    if (selection.kind === 'decorations') {
      const decoration = item as Project['decorations'][number];
      patch({ x: Math.max(0, Math.min(floor.width - decoration.width, x)), y: Math.max(0, Math.min(floor.height - decoration.height, y)) });
      return;
    }
    const nodeId = 'nodeId' in item ? item.nodeId : item.id;
    change({
      ...draft,
      nodes: draft.nodes.map((n) => (n.id === nodeId ? { ...n, x: Math.max(0, Math.min(floor.width, x)), y: Math.max(0, Math.min(floor.height, y)) } : n)),
      places: draft.places.map((p) => (p.nodeId === nodeId ? { ...p, x: Math.max(0, Math.min(floor.width, x)), y: Math.max(0, Math.min(floor.height, y)) } : p)),
      panoramas: draft.panoramas.map((p) => (p.nodeId === nodeId ? { ...p, x: Math.max(0, Math.min(floor.width, x)), y: Math.max(0, Math.min(floor.height, y)) } : p)),
    });
  };
  const prune = (next: Project) => {
    const nodes = new Set(next.nodes.map((n) => n.id));
    next.edges = next.edges.filter((e) => nodes.has(e.fromId) && nodes.has(e.toId));
    next.places = next.places.filter((p) => nodes.has(p.nodeId));
    next.panoramas = next.panoramas.filter((p) => nodes.has(p.nodeId));
    const places = new Set(next.places.map((p) => p.id)),
      panoramas = new Set(next.panoramas.map((p) => p.id));
    next.panoramas = next.panoramas.map((p) => ({
      ...p,
      hotspots: p.hotspots.filter(
        (h) =>
          (!h.placeId || places.has(h.placeId)) &&
          (!h.targetPanoramaId || panoramas.has(h.targetPanoramaId)),
      ),
    }));
    return next;
  };
  const importRoomPlan = async () => {
    if (!roomPlan) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const floorScan = {
        ...roomPlan,
        rooms: roomPlan.rooms.filter((room) => (room.story ?? 0) === roomPlanStory),
      };
      if (!floorScan.rooms.length) throw new Error('В скане нет комнат выбранного уровня. Выберите другой уровень.');
      const background = await renderRoomPlan(floorScan, floor.width, floor.height);
      const asset = await api.importPlan(background, draft.slug);
      updateFloor({ backgroundAssetId: asset.assetId });
      setNotice('Скан добавлен как подложка. Проверьте совпадение с помещением и вручную разметьте граф маршрута.');
      setRoomPlan(null);
      setRoomPlanPreviewUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось импортировать RoomPlan-скан.');
    } finally {
      setBusy(false);
    }
  };
  const remove = () => {
    if (!selection) return;
    change(
      prune({
        ...draft,
        [selection.kind]: draft[selection.kind].filter((item) => item.id !== selection.id),
      }),
    );
    setSelection(null);
  };
  const duplicateSelection = () => {
    if (!selection) return;
    const offset = 20;
    if (selection.kind === 'rooms') {
      const room = draft.rooms.find((candidate) => candidate.id === selection.id);
      if (!room) return;
      const copy = { ...room, id: uid(), name: `${room.name} — копия`, x: Math.min(floor.width - room.width, room.x + offset), y: Math.min(floor.height - room.height, room.y + offset) };
      change({ ...draft, rooms: [...draft.rooms, copy] });
      setSelection({ kind: 'rooms', id: copy.id });
    } else if (selection.kind === 'decorations') {
      const decoration = (draft.decorations ?? []).find((candidate) => candidate.id === selection.id);
      if (!decoration) return;
      const copy = { ...decoration, id: uid(), x: Math.min(floor.width - decoration.width, decoration.x + offset), y: Math.min(floor.height - decoration.height, decoration.y + offset) };
      change({ ...draft, decorations: [...(draft.decorations ?? []), copy] });
      setSelection({ kind: 'decorations', id: copy.id });
    } else if (selection.kind === 'places' || selection.kind === 'nodes') {
      const originalNodeId = selection.kind === 'places' ? draft.places.find((place) => place.id === selection.id)?.nodeId : selection.id;
      const originalNode = draft.nodes.find((node) => node.id === originalNodeId);
      if (!originalNode) return;
      const node = { ...originalNode, id: uid(), label: `${originalNode.label} — копия`, x: Math.min(floor.width, originalNode.x + offset), y: Math.min(floor.height, originalNode.y + offset) };
      if (selection.kind === 'places') {
        const place = draft.places.find((candidate) => candidate.id === selection.id)!;
        const copy = { ...place, id: uid(), nodeId: node.id, name: `${place.name} — копия`, x: node.x, y: node.y };
        change({ ...draft, nodes: [...draft.nodes, node], places: [...draft.places, copy] });
        setSelection({ kind: 'places', id: copy.id });
      } else {
        change({ ...draft, nodes: [...draft.nodes, node] });
        setSelection({ kind: 'nodes', id: node.id });
      }
    }
    setNotice('Копия добавлена. Перетащите её на нужное место.');
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (preview || view3d || (event.target as Element).closest('input,textarea,select,[contenteditable="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateSelection();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
        event.preventDefault();
        remove();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [draft, selection, preview, view3d, busy]);
  const connect = (id: string) => {
    if (!edgeStart) {
      setEdgeStart(id);
      const node = draft.nodes.find((candidate) => candidate.id === id);
      setError('');
      setNotice(`Начало связи сохранено: «${node?.label ?? 'узел'}». Переключите этаж и выберите второй узел.`);
      return;
    }
    if (id === edgeStart) {
      setError('Выберите другую точку для конца прохода.');
      return;
    }
    if (
      draft.edges.some(
        (e) =>
          (e.fromId === edgeStart && e.toId === id) ||
          (e.bidirectional && e.toId === edgeStart && e.fromId === id),
      )
    ) {
      setError('Эти точки уже соединены. Выберите проход, чтобы изменить его.');
      return;
    }
    const start = draft.nodes.find((n) => n.id === edgeStart),
      end = draft.nodes.find((n) => n.id === id);
    if (!start || !end) {
      setEdgeStart('');
      setError('Точка удалена. Выберите начало прохода заново.');
      return;
    }
    if (start.floorId !== end.floorId && (start.kind === 'walk' || end.kind !== start.kind)) {
      setError('Для связи этажей нужны два узла типа «Лестница» или два узла типа «Лифт».');
      return;
    }
    const edge: Edge = {
      id: uid(),
      fromId: edgeStart,
      toId: id,
      kind: start.floorId === end.floorId ? 'walk' : start.kind,
      accessible: start.floorId === end.floorId || start.kind !== 'stairs',
      bidirectional: true,
      blocked: false,
      distanceMeters: start.floorId === end.floorId ? null : 6,
    };
    change({ ...draft, edges: [...draft.edges, edge] });
    setSelection({ kind: 'edges', id: edge.id });
    setEdgeStart('');
    setNotice('Проход добавлен. Для связи этажей проверьте фактическую длину.');
  };
  const point = (event: React.MouseEvent<SVGSVGElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (busy) return;
    // Keep the drawing interaction on the canvas itself; child SVG shapes are visual only.
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    let x = Math.max(0, Math.min(floor.width, snap ? Math.round(p.x / 10) * 10 : p.x));
    let y = Math.max(0, Math.min(floor.height, snap ? Math.round(p.y / 10) * 10 : p.y));
    if (tool === 'move') {
      move(x, y);
      switchTool('select');
      return;
    }
    if (tool === 'decoration') {
      addDecoration(x, y);
      return;
    }
    if (tool === 'room' || tool === 'corridor') {
      const currentAnchor = anchorRef.current;
      if (!currentAnchor) {
        anchorRef.current = { x, y };
        setAnchor({ x, y });
        return;
      }
      const width = Math.abs(x - currentAnchor.x),
        height = Math.abs(y - currentAnchor.y);
      if (width < 10 || height < 10) {
        setError('Укажите противоположный угол: минимальный размер — 10 единиц.');
        return;
      }
      const room = {
        id: uid(),
        floorId: floor.id,
        name: tool === 'room' ? 'Новое помещение' : 'Коридор',
        kind: tool,
        x: Math.min(x, currentAnchor.x),
        y: Math.min(y, currentAnchor.y),
        width,
        height,
      };
      setHistory((historyItems) => [...historyItems.slice(-39), draft]);
      setFuture([]);
      setDraft((current) => ({ ...current, rooms: [...current.rooms, room] }));
      setError('');
      setNotice('Помещение добавлено. Выберите его справа, чтобы задать название и размеры.');
      setSelection({ kind: 'rooms', id: room.id });
      anchorRef.current = null;
      setAnchor(null);
      return;
    }
    if (tool === 'node' || tool === 'door' || tool === 'place') {
      if (tool === 'door') {
        const candidates = draft.rooms
          .filter((r) => r.floorId === floor.id && r.kind === 'room')
          .flatMap((r) => [
            { x: Math.max(r.x, Math.min(r.x + r.width, x)), y: r.y },
            { x: Math.max(r.x, Math.min(r.x + r.width, x)), y: r.y + r.height },
            { x: r.x, y: Math.max(r.y, Math.min(r.y + r.height, y)) },
            { x: r.x + r.width, y: Math.max(r.y, Math.min(r.y + r.height, y)) },
          ])
          .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
        if (!candidates.length || Math.hypot(candidates[0].x - x, candidates[0].y - y) > 40) {
          setError('Поставьте дверь рядом со стеной комнаты. Точка привяжется к границе.');
          return;
        }
        x = candidates[0].x;
        y = candidates[0].y;
      }
      const node = {
        id: uid(),
        floorId: floor.id,
        x,
        y,
        label: tool === 'door' ? 'Дверь' : tool === 'place' ? 'Новое место' : 'Узел пути',
        kind: 'walk' as const,
      };
      const place = {
        id: uid(),
        floorId: floor.id,
        nodeId: node.id,
        x,
        y,
        name: 'Новое место',
        category: 'Место',
        description: '',
      };
      change({
        ...draft,
        nodes: [...draft.nodes, node],
        places: tool === 'place' ? [...draft.places, place] : draft.places,
      });
      setSelection({
        kind: tool === 'place' ? 'places' : 'nodes',
        id: tool === 'place' ? place.id : node.id,
      });
    }
  };
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const close = () => {
    if (busy) return;
    if (!dirty || window.confirm('Закрыть редактор без сохранения изменений?')) onClose();
  };
  closeRef.current = close;
  const selectedNode =
    selection?.kind === 'nodes' ? draft.nodes.find((n) => n.id === selection.id) : undefined;
  const selectedEdge =
    selection?.kind === 'edges' ? draft.edges.find((e) => e.id === selection.id) : undefined;
  const selectedRoom =
    selection?.kind === 'rooms' ? draft.rooms.find((r) => r.id === selection.id) : undefined;
  const selectedPlace =
    selection?.kind === 'places' ? draft.places.find((p) => p.id === selection.id) : undefined;
  const selectedDecoration =
    selection?.kind === 'decorations' ? (draft.decorations ?? []).find((d) => d.id === selection.id) : undefined;

  return (
    <div
      ref={modal}
      tabIndex={-1}
      className="plan-editor"
      data-mobile-panel={mobilePanel}
      role="dialog"
      aria-modal="true"
      aria-label="Редактор плана"
    >
      <header className="plan-header">
        <div>
          <span className="plan-eyebrow">ОРГАНИЗАТОР / ПЛАН ПРОСТРАНСТВА</span>
          <h2>Конструктор пространства</h2>
        </div>
        <div className="plan-actions">
          <span>{dirty ? 'Есть несохранённые изменения' : `Сохранено · v${draft.revision}`}</span>
          <button
            disabled={!history.length || busy}
            onClick={undo}
          ><Undo2 size={15} /> Отменить действие</button>
          <button disabled={!future.length || busy} onClick={redo}><Redo2 size={15} /> Повторить действие</button>
          <button aria-pressed={preview} disabled={busy} onClick={() => setPreview(!preview)}>{preview ? <Pencil size={15} /> : <Eye size={15} />}{preview ? 'К конструктору' : 'Предпросмотр'}</button>
          {!preview && <button aria-pressed={view3d} disabled={busy} onClick={toggle3d}><Cuboid size={15} />{view3d ? '2D-план' : '3D-обзор'}</button>}
          <button
            className="plan-primary"
            disabled={busy || !dirty}
            onClick={async () => {
              const validation = validateDraft(draft);
              if (validation) {
                setError(validation);
                return;
              }
              setBusy(true);
              setError('');
              try {
                const saved = await onSave(draft);
                setDraft(saved);
                setBaseline(JSON.stringify(saved));
                setHistory([]);
                setFuture([]);
                setNotice(
                  'План сохранён. Опубликуйте черновик, чтобы посетители увидели изменения.',
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Не удалось сохранить план.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <Save size={15} /> Сохранить план
          </button>
          <button disabled={busy} onClick={close} aria-label="Закрыть редактор плана">
            ✕
          </button>
        </div>
      </header>
      {(error || notice) && <div className="plan-feedback plan-global-feedback" role={error ? 'alert' : 'status'}>{error || notice}</div>}
      {!preview && !view3d && <nav className="plan-mobile-nav" aria-label="Панели конструктора">
        <button aria-pressed={mobilePanel === 'canvas'} onClick={() => setMobilePanel('canvas')}>План</button>
        <button aria-pressed={mobilePanel === 'tools'} onClick={() => setMobilePanel('tools')}>Инструменты</button>
        <button aria-label="Свойства и объекты" aria-pressed={mobilePanel === 'properties'} onClick={() => setMobilePanel('properties')}>{selection ? 'Свойства •' : 'Объекты'}</button>
      </nav>}
      {preview ? <PlanPreview project={draft} validationError={scaleError} /> : <div className="plan-editor-workspace">
        <div className="plan-body" inert={busy || view3d}>
        <aside className="plan-tools">
          <h3><Layers3 size={16} /> Слои</h3>
          {(['background', 'graph', 'labels', 'interior'] as const).map((key, index) => <label key={key} className="plan-check"><input type="checkbox" checked={layers[key]} onChange={(event) => setLayers({ ...layers, [key]: event.target.checked })} />{['Подложка', 'Сеть проходов', 'Подписи объектов', 'Декорации'][index]}</label>)}
          <h3>Инструменты</h3>
          <div className="plan-tool-grid">
            {(Object.keys(labels) as Tool[])
              .filter((t) => t !== 'move' && t !== 'decoration')
              .map((t) => (
                <button key={t} aria-pressed={tool === t} onClick={() => switchTool(t)}>
                  {(() => { const Icon = toolIcons[t]; return <Icon size={18} />; })()}{labels[t]}
                </button>
              ))}
          </div>
          <label className="plan-check">
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />{' '}
            Сетка 10 единиц
          </label>
          <p className="plan-help">
            Комната и коридор — два противоположных угла. Место создаёт точку маршрута. Дверь
            привязывается к стене. Проход соединяет два узла; для смены этажа выберите второй этаж,
            не меняя инструмент.
          </p>
          <section className="plan-decoration-panel" aria-label="Каталог декораций">
            <div className="plan-library-heading"><h3>Библиотека мебели</h3><span>{(draft.decorations ?? []).filter((item) => item.floorId === floor.id).length}</span></div>
            <p className="plan-help">Нажмите на предмет, затем поставьте его в нужное место. Перетаскивайте готовые объекты прямо на плане.</p>
            <div className="plan-decoration-library" data-testid="decoration-library">
              {(Object.keys(decorationLabels) as DecorationKind[]).map((kind) => (
                <button key={kind} className="plan-decoration-tile" aria-pressed={tool === 'decoration' && decorationKind === kind} onClick={() => { setDecorationKind(kind); switchTool('decoration'); }}>
                  <span className={`plan-decoration-glyph is-${kind}`} aria-hidden="true">{({ table: '▦', chair: '⌑', sofa: '▰', desk: '▤', plant: '✳', counter: '▰', shelf: '▥' } as Record<DecorationKind, string>)[kind]}</span>
                  <span>{decorationLabels[kind]}</span>
                </button>
              ))}
            </div>
            {tool === 'decoration' && <div className="plan-placement-hint" role="status">{decorationLabels[decorationKind]} выбрано · щёлкните по плану, чтобы поставить</div>}
            <details className="plan-decoration-list">
              <summary>Декорации этажа · {(draft.decorations ?? []).filter((item) => item.floorId === floor.id).length}</summary>
              <div className="plan-decoration-list-items">
              {(draft.decorations ?? []).filter((item) => item.floorId === floor.id).map((item) => {
                const roomName = draft.rooms.find((room) => room.id === item.roomId)?.name ?? 'Вне помещения';
                return <button key={item.id} data-decoration-id={item.id} className="plan-decoration-item" aria-label={`Выбрать декорацию: ${decorationLabels[item.kind]}, ${roomName}`} onClick={() => setSelection({ kind: 'decorations', id: item.id })}>
                  <span aria-hidden="true">{item.kind === 'plant' ? '✳' : '◇'}</span>
                  <span><strong>{decorationLabels[item.kind]}</strong><small>{roomName}</small></span>
                </button>;
              })}
              </div>
            </details>
          </section>
          {pendingEdgeNode && (
            <div className="plan-pending-edge" role="status">
              <strong>Связь между этажами</strong>
              <span>Начало: {pendingEdgeNode.label} · {draft.floors.find((item) => item.id === pendingEdgeNode.floorId)?.name}</span>
              <small>Переключите этаж, выберите узел того же типа и задайте длину.</small>
              <button onClick={() => { setEdgeStart(''); setNotice(''); setError(''); }}>Сбросить начало</button>
            </div>
          )}
          <h3>Этаж и масштаб</h3>
          <label>
            Название пространства
            <input
              value={draft.title}
              maxLength={200}
              onChange={(event) => change({ ...draft, title: event.target.value })}
            />
          </label>
          <label>
            Этаж
            <select
              value={floor.id}
              onChange={(e) => switchFloor(e.target.value)}
            >
              {draft.floors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => {
              const next = {
                id: uid(),
                name: `Этаж ${Math.max(...draft.floors.map((f) => f.level)) + 1}`,
                level: Math.max(...draft.floors.map((f) => f.level)) + 1,
                width: 1000,
                height: 700,
                metersPerUnit: 0.1,
              };
              change({ ...draft, floors: [...draft.floors, next] });
              setFloorId(next.id);
              setSelection(null);
            }}
          >
            Добавить этаж
          </button>
          <label>
            Название этажа
            <input
              value={floor.name}
              maxLength={100}
              onChange={(e) => updateFloor({ name: e.target.value })}
            />
          </label>
          <div className="plan-pair">
            <label>
              Ширина
              <input
                type="number"
                min="10"
                max="100000"
                value={floor.width}
                onChange={(e) => updateFloor({ width: Number(e.target.value) })}
              />
            </label>
            <label>
              Высота
              <input
                type="number"
                min="10"
                max="100000"
                value={floor.height}
                onChange={(e) => updateFloor({ height: Number(e.target.value) })}
              />
            </label>
          </div>
          <label>
            Метров в единице плана
            <input
              type="number"
              max="100"
              step="0.001"
              value={floor.metersPerUnit}
              onChange={(e) => {
                const value = Number(e.target.value);
                setScaleError(!Number.isFinite(value) || value <= 0 ? 'Масштаб этажей и длины переходов должны быть положительными числами' : '');
                updateFloor({ metersPerUnit: value });
              }}
            />
          </label>
          <p className="plan-help">
            Например, 100 единиц = 10 м → масштаб 0,1. Измерьте известный отрезок на исходном плане.
          </p>
          {mediaEnabled ? <label className="plan-upload">
            Загрузить подложку
            <input
              type="file"
              accept="image/png,image/jpeg"
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setBusy(true);
                setError('');
                try {
                  const asset = await api.importPlan(file, draft.slug);
                  updateFloor({ backgroundAssetId: asset.assetId });
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Ошибка загрузки');
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label> : <p className="plan-help">Загрузка подложки появится после настройки личного хранилища изображений.</p>}
          {layers.background && floor.backgroundAssetId && (
            <button onClick={() => updateFloor({ backgroundAssetId: null })}>
              Убрать подложку
            </button>
          )}
          <details className="plan-roomplan">
            <summary>LiDAR · Apple RoomPlan</summary>
            <p className="plan-help">
              Скан снимите в нативном iOS companion (его нужно собрать в Xcode на Mac) на устройстве
              с LiDAR, затем загрузите JSON. Обычный iPhone 13 LiDAR не имеет. Скан станет подложкой этажа;
              прежняя подложка заменится только после подтверждения. Узлы и маршрут размечаются вручную.
            </p>
            <label className="plan-upload">
              Файл скана JSON
              <input
                type="file"
                accept="application/json,.json"
                disabled={busy}
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setError('');
                  try {
                    const scan = await readRoomPlan(file);
                    const initialStory = scan.rooms[0].story ?? 0;
                    const floorScan = { ...scan, rooms: scan.rooms.filter((room) => (room.story ?? 0) === initialStory) };
                    const previewImage = await renderRoomPlan(floorScan, floor.width, floor.height);
                    setRoomPlan(scan);
                    setRoomPlanStory(initialStory);
                    setRoomPlanPreviewUrl(URL.createObjectURL(previewImage));
                  } catch (err) {
                    setRoomPlan(null);
                    setRoomPlanPreviewUrl('');
                    setError(err instanceof Error ? err.message : 'Не удалось прочитать скан.');
                  } finally {
                    event.target.value = '';
                  }
                }}
              />
            </label>
            {roomPlan && (() => {
              const levels = [...new Set(roomPlan.rooms.map((room) => room.story ?? 0))].sort((a, b) => a - b);
              const selectedRooms = roomPlan.rooms.filter((room) => (room.story ?? 0) === roomPlanStory);
              const selectedScan = { ...roomPlan, rooms: selectedRooms };
              const bounds = roomPlanBounds(selectedScan);
              const rooms = selectedRooms.length;
              const walls = selectedRooms.reduce((total, room) => total + room.walls.length, 0);
              const openings = selectedRooms.reduce((total, room) => total + room.openings.length, 0);
              const objects = selectedRooms.reduce((total, room) => total + (room.objects?.length ?? 0), 0);
              const lowConfidence = selectedRooms.reduce((total, room) => total + room.walls.filter((wall) => wall.confidence === 'low').length + room.openings.filter((opening) => opening.confidence === 'low').length + (room.objects ?? []).filter((object) => object.confidence === 'low').length, 0);
              return (
                <div className="plan-roomplan-summary" role="status">
                  {levels.length > 1 && <label>Этаж RoomPlan<select aria-label="Этаж RoomPlan" value={roomPlanStory} onChange={async (event) => {
                    const story = Number(event.currentTarget.value);
                    const scan = { ...roomPlan, rooms: roomPlan.rooms.filter((room) => (room.story ?? 0) === story) };
                    try {
                      const image = await renderRoomPlan(scan, floor.width, floor.height);
                      setRoomPlanStory(story);
                      setRoomPlanPreviewUrl(URL.createObjectURL(image));
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Не удалось подготовить выбранный этаж.');
                    }
                  }}>{levels.map((story) => <option key={story} value={story}>Уровень {story + 1}</option>)}</select></label>}
                  <strong>{rooms} помещений · {walls} стен · {openings} проёмов · {objects} предметов</strong>
                  <span>Габарит скана: {bounds.width.toFixed(2)} × {bounds.height.toFixed(2)} м</span>
                  <span>{levels.length > 1 ? `${levels.length} уровней RoomPlan · ` : ''}Низкая уверенность: {lowConfidence} элементов. Скан остаётся черновой подложкой, маршруты автоматически не создаются.</span>
                  {roomPlanPreviewUrl && <img className="plan-roomplan-preview" src={roomPlanPreviewUrl} alt="Предпросмотр обмерных стен, проёмов и распознанных предметов" />}
                  <span>Сверьте размер и ориентацию с планом этажа. Низкая уверенность означает, что участок особенно важно проверить на месте.</span>
                  <button disabled={busy} onClick={() => void importRoomPlan()}>
                    {busy ? 'Подготавливаем…' : 'Добавить скан как подложку'}
                  </button>
                  <button disabled={busy} onClick={() => { setRoomPlan(null); setRoomPlanPreviewUrl(''); }}>Отмена</button>
                </div>
              );
            })()}
          </details>
          <details>
            <summary>Удаление этажа</summary>
            <p className="plan-help">
              Удалятся помещения, точки, проходы и связанные панорамы этого этажа. До сохранения
              доступна отмена.
            </p>
            <button
              disabled={draft.floors.length < 2}
              onClick={() => {
                const next = prune({
                  ...draft,
                  floors: draft.floors.filter((f) => f.id !== floor.id),
                  rooms: draft.rooms.filter((r) => r.floorId !== floor.id),
                  nodes: draft.nodes.filter((n) => n.floorId !== floor.id),
                  decorations: (draft.decorations ?? []).filter((item) => item.floorId !== floor.id),
                });
                change(next);
                setFloorId(next.floors[0].id);
                setSelection(null);
              }}
            >
              Удалить текущий этаж
            </button>
          </details>
        </aside>
        <section className="plan-stage">
          <div className="plan-stage-bar">
            <strong>{floor.name}</strong>
            <select className="plan-mobile-floor" aria-label="Этаж на плане" value={floor.id} onChange={(event) => switchFloor(event.target.value)}>
              {draft.floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <span>
              {tool === 'edge'
                ? edgeStart
                  ? 'Выберите конец прохода'
                  : 'Выберите начало прохода'
                : anchor
                  ? 'Укажите противоположный угол'
                  : labels[tool]}
            </span>
            <div>
              <button
                aria-label="Уменьшить план"
                onClick={() => setZoom((z) => Math.max(1, z - 0.25))}
              >
                −
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button
                aria-label="Увеличить план"
                onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
              >
                +
              </button>
            </div>
          </div>
          <div
            ref={planScroll}
            className={`plan-scroll ${panRef.current?.moved ? 'is-panning' : ''}`}
            onPointerDown={(event) => {
              // Touch uses the browser's two-axis scroll; custom capture is for a mouse.
              if (event.pointerType === 'touch') return;
              if (tool !== 'select' || event.button !== 0) return;
              // Interactive room/node groups must keep the pointer so their
              // click handlers can select them; pan only starts on the canvas
              // background or empty SVG space.
              if (event.target !== event.currentTarget && (event.target as Element).closest('g')) return;
              const element = event.currentTarget;
              panRef.current = {
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                left: element.scrollLeft,
                top: element.scrollTop,
                moved: false,
              };
              element.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const pan = panRef.current;
              const element = planScroll.current;
              if (!pan || pan.pointerId !== event.pointerId || !element) return;
              const dx = event.clientX - pan.x;
              const dy = event.clientY - pan.y;
              if (!pan.moved && Math.hypot(dx, dy) > 4) pan.moved = true;
              if (pan.moved) {
                event.preventDefault();
                suppressClick.current = true;
                element.scrollLeft = pan.left - dx;
                element.scrollTop = pan.top - dy;
              }
            }}
            onPointerUp={(event) => {
              if (panRef.current?.pointerId === event.pointerId) {
                if (panRef.current.moved) suppressClick.current = true;
                panRef.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
            onPointerCancel={() => { panRef.current = null; }}
          >
            <svg
              key={floor.id}
              ref={svg}
              data-testid="plan-editor-canvas"
              aria-label="Полотно редактора"
              viewBox={`0 0 ${Math.max(1, floor.width)} ${Math.max(1, floor.height)}`}
              style={{ width: `${zoom * 100}%`, minHeight: 450 }}
              onPointerDown={(event) => {
                if ((tool !== 'room' && tool !== 'corridor') || anchorRef.current || event.button !== 0) return;
                const start = planPoint(event.clientX, event.clientY);
                if (!start) return;
                const x = snap ? Math.round(start.x / 10) * 10 : start.x;
                const y = snap ? Math.round(start.y / 10) * 10 : start.y;
                drawDragRef.current = { pointerId: event.pointerId, startX: x, startY: y };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onClick={point}
              onPointerMove={(event) => {
                updateObjectDrag(event);
                const drawing = drawDragRef.current;
                if (drawing?.pointerId === event.pointerId) {
                  const point = planPoint(event.clientX, event.clientY);
                  if (point && Math.hypot(point.x - drawing.startX, point.y - drawing.startY) > 3) {
                    anchorRef.current = { x: drawing.startX, y: drawing.startY };
                    setAnchor({ x: drawing.startX, y: drawing.startY });
                    setCursor({ x: snap ? Math.round(point.x / 10) * 10 : point.x, y: snap ? Math.round(point.y / 10) * 10 : point.y });
                  }
                }
                if (!anchor) return;
                const matrix = svg.current?.getScreenCTM(); if (!matrix) return;
                const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
                setCursor({ x: Math.max(0, Math.min(floor.width, snap ? Math.round(p.x / 10) * 10 : p.x)), y: Math.max(0, Math.min(floor.height, snap ? Math.round(p.y / 10) * 10 : p.y)) });
              }}
              onPointerUp={(event) => { finishObjectDrag(event); finishRoomDraw(event); }}
              onPointerCancel={(event) => { if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null; }}
            >
              <defs>
                <pattern id="editor-grid" width="10" height="10" patternUnits="userSpaceOnUse">
                  <circle cx="0" cy="0" r=".8" fill="#b4c7d9" />
                </pattern>
              </defs>
              <rect width={floor.width} height={floor.height} fill="#f4f8fc" />
              <rect width={floor.width} height={floor.height} fill="url(#editor-grid)" />
              {layers.background && floor.backgroundAssetId && (
                <image
                  href={assetUrl(floor.backgroundAssetId)}
                  width={floor.width}
                  height={floor.height}
                  preserveAspectRatio="xMidYMid meet"
                  opacity=".45"
                />
              )}
              {draft.rooms
                .filter((r) => r.floorId === floor.id)
                .map((r) => (
                  <g
                    key={r.id}
                    data-room-id={r.id}
                    style={{ pointerEvents: tool === 'select' ? 'auto' : 'none', touchAction: tool === 'select' ? 'none' : undefined }}
                    onPointerDown={(event) => startObjectDrag(event, { kind: 'rooms', id: r.id })}
                    onClick={(event) => {
                      if (tool === 'select') {
                        event.stopPropagation();
                        setSelection({ kind: 'rooms', id: r.id });
                      }
                    }}
                  >
                    <rect
                      x={r.x}
                      y={r.y}
                      width={r.width}
                      height={r.height}
                      fill={r.kind === 'corridor' ? '#f7fafb' : roomAppearance(r.name).fill}
                      stroke={selection?.id === r.id ? '#e52713' : '#899ba6'}
                      strokeWidth={selection?.id === r.id ? 4 : 2}
                    />
                    {selection?.kind === 'rooms' && selection.id === r.id && <rect className="plan-resize-handle" aria-label="Изменить размер помещения" x={r.x + r.width - 6} y={r.y + r.height - 6} width="12" height="12" onPointerDown={(event) => startObjectDrag(event, { kind: 'rooms', id: r.id }, 'resize')} />}
                    {layers.interior && draft.slug === 'demo' && !(draft.decorations ?? []).some((item) => item.roomId === r.id) && demoInterior(r).map((shape, index) => (
                      <g key={`${r.id}-interior-${index}`} pointerEvents="none" opacity=".78">
                        {shape.round ? (
                          <ellipse cx={shape.x + shape.width / 2} cy={shape.y + shape.height / 2} rx={shape.width / 2} ry={shape.height / 2} fill={interiorColors[shape.kind]} stroke="#8e9da5" strokeWidth="1" />
                        ) : (
                          <rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx="2" fill={interiorColors[shape.kind]} stroke="#8e9da5" strokeWidth="1" />
                        )}
                      </g>
                    ))}
                  </g>
                ))}
              {layers.interior && (draft.decorations ?? []).filter((item) => item.floorId === floor.id).map((item) => (
                <g key={item.id} data-decoration-id={item.id} transform={`rotate(${item.rotation ?? 0} ${item.x + item.width / 2} ${item.y + item.height / 2})`} style={{ pointerEvents: tool === 'select' ? 'auto' : 'none', cursor: 'move', touchAction: tool === 'select' ? 'none' : undefined }} opacity=".9" onPointerDown={(event) => startObjectDrag(event, { kind: 'decorations', id: item.id })} onClick={(event) => { if (tool === 'select') { event.stopPropagation(); setSelection({ kind: 'decorations', id: item.id }); } }}>
                  {item.kind === 'plant' ? <circle cx={item.x + item.width / 2} cy={item.y + item.height / 2} r={Math.min(item.width, item.height) / 2} fill={decorationFill.plant} stroke="#52795a" strokeWidth="2" /> : <rect x={item.x} y={item.y} width={item.width} height={item.height} rx={item.kind === 'sofa' ? 8 : 3} fill={decorationFill[item.kind]} stroke="#71838c" strokeWidth="1.5" />}
                  {selection?.kind === 'decorations' && selection.id === item.id && <rect className="plan-resize-handle" x={item.x + item.width - 5} y={item.y + item.height - 5} width="10" height="10" onPointerDown={(event) => startObjectDrag(event, { kind: 'decorations', id: item.id }, 'resize')} />}
                </g>
              ))}
              {layers.graph && draft.edges.map((e) => {
                const a = draft.nodes.find((n) => n.id === e.fromId),
                  b = draft.nodes.find((n) => n.id === e.toId);
                if (!a || !b || a.floorId !== floor.id || b.floorId !== floor.id) return null;
                return (
                  <g
                    key={e.id}
                    style={{ pointerEvents: tool === 'select' ? 'auto' : 'none' }}
                    onClick={(event) => {
                      if (tool === 'select') {
                        event.stopPropagation();
                        setSelection({ kind: 'edges', id: e.id });
                      }
                    }}
                  >
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke="transparent"
                      strokeWidth="18"
                    />
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={
                        e.blocked ? '#c34747' : selection?.id === e.id ? '#004be6' : '#37a38c'
                      }
                      strokeWidth={selection?.id === e.id ? 5 : 3}
                      strokeDasharray={e.blocked ? '7 5' : undefined}
                      pointerEvents="none"
                    />
                  </g>
                );
              })}
              {(layers.graph ? draft.nodes : draft.nodes.filter((n) => draft.places.some((p) => p.nodeId === n.id)))
                .filter((n) => n.floorId === floor.id)
                .map((n) => {
                  const p = draft.places.find((p) => p.nodeId === n.id);
                  return (
                    <g
                      key={n.id}
                      style={{ pointerEvents: tool === 'select' || tool === 'edge' ? 'auto' : 'none', touchAction: tool === 'select' ? 'none' : undefined }}
                      role="button"
                      tabIndex={0}
                      aria-label={`Узел: ${p?.name || n.label}`}
                      onPointerDown={(event) => startObjectDrag(event, { kind: p ? 'places' : 'nodes', id: p?.id || n.id })}
                      onClick={(event) => {
                        if (tool === 'select' || tool === 'edge') {
                          event.stopPropagation();
                          if (tool === 'edge') connect(n.id);
                          else setSelection({ kind: p ? 'places' : 'nodes', id: p?.id || n.id });
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          if (tool === 'edge') connect(n.id);
                          else setSelection({ kind: 'nodes', id: n.id });
                        }
                      }}
                    >
                      <circle
                        cx={n.x}
                        cy={n.y}
                        r={p ? markerRadius * 1.2 : markerRadius}
                        fill={edgeStart === n.id ? '#ffad39' : p ? '#293f4e' : '#fff'}
                        stroke={
                          selection?.id === n.id || (p && selection?.id === p.id) ? '#e52713' : '#607b8b'
                        }
                        strokeWidth="3"
                      />
                      {layers.labels && (p || n.kind !== 'walk' || selection?.id === n.id) && <text
                        x={n.x + markerRadius * 1.5}
                        y={n.y + labelSize / 3}
                        fontSize={labelSize}
                        fill="#264561"
                      >
                        {p?.name || n.label}
                      </text>}
                    </g>
                  );
                })}
              {layers.labels && draft.rooms.filter((room) => room.floorId === floor.id).map((room) => (
                <text
                  key={`room-label-${room.id}`}
                  x={room.x + 8}
                  y={room.y + labelSize + 8}
                  fontSize={labelSize}
                  fontWeight="650"
                  fill="#35434a"
                  stroke="#fff"
                  strokeWidth={Math.max(3, labelSize * 0.42)}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                  pointerEvents="none"
                >
                  {room.name}
                </text>
              ))}
              {selectedRoom && <text x={selectedRoom.x + selectedRoom.width / 2} y={selectedRoom.y + selectedRoom.height / 2} textAnchor="middle" fontSize={labelSize} fill="#a82517" pointerEvents="none">{(selectedRoom.width * floor.metersPerUnit).toFixed(2)} × {(selectedRoom.height * floor.metersPerUnit).toFixed(2)} м</text>}
              {anchor && cursor && <g pointerEvents="none" data-testid="room-drawing-preview">
                <rect x={Math.min(anchor.x, cursor.x)} y={Math.min(anchor.y, cursor.y)} width={Math.abs(cursor.x - anchor.x)} height={Math.abs(cursor.y - anchor.y)} fill="#e5271314" stroke="#e52713" strokeWidth="2" strokeDasharray="8 5" />
                <text x={Math.min(anchor.x, cursor.x)} y={Math.max(18, Math.min(anchor.y, cursor.y) - 10)} fontSize={labelSize} fill="#a82517">{(Math.abs(cursor.x - anchor.x) * floor.metersPerUnit).toFixed(2)} × {(Math.abs(cursor.y - anchor.y) * floor.metersPerUnit).toFixed(2)} м</text>
              </g>}
              {anchor && <circle cx={anchor.x} cy={anchor.y} r="6" fill="#ef8b23" />}
            </svg>
          </div>
          <div className="plan-feedback plan-canvas-help">
            <p>{tool === 'select' ? 'Перетащите объект, чтобы переместить · угол выделенного блока меняет размер · Delete — удалить · Ctrl+D — копировать · тяните пустое место, чтобы двигать холст.' : 'Выберите точку на плане, чтобы поставить блок. Масштаб меняется колесом или кнопками над планом.'}</p>
          </div>
        </section>
        <aside className="plan-inspector">
          <h3>Свойства объекта</h3>
          {!item && (
            <p className="plan-help">
              Выберите объект на плане или в списке, чтобы изменить его. После создания комнат
              добавьте места, двери и соединяющие проходы.
            </p>
          )}
          {item && (
            <>
              <span className="plan-eyebrow">
                {selection?.kind === 'rooms'
                  ? 'ПОМЕЩЕНИЕ'
                  : selection?.kind === 'edges'
                    ? 'ПРОХОД'
                    : selection?.kind === 'places'
                      ? 'МЕСТО'
                      : selection?.kind === 'decorations'
                        ? 'ДЕКОРАЦИЯ'
                        : 'УЗЕЛ'}
              </span>
              {'name' in item && (
                <label>
                  Название объекта
                  <input
                    value={item.name}
                    maxLength={200}
                    onChange={(e) => patch({ name: e.target.value })}
                  />
                </label>
              )}
              {selectedNode && (
                <>
                  <label>
                    Название узла
                    <input
                      value={selectedNode.label}
                      onChange={(e) => patch({ label: e.target.value })}
                    />
                  </label>
                  <label>
                    Тип узла
                    <select
                      value={selectedNode.kind}
                      onChange={(e) => patch({ kind: e.target.value })}
                    >
                      <option value="walk">Обычный проход</option>
                      <option value="stairs">Лестница</option>
                      <option value="elevator">Лифт</option>
                    </select>
                  </label>
                </>
              )}
              {selectedPlace && (
                <>
                  <label>
                    Категория
                    <input
                      value={selectedPlace.category}
                      onChange={(e) => patch({ category: e.target.value })}
                    />
                  </label>
                  <label>
                    Описание
                    <textarea
                      value={selectedPlace.description}
                      maxLength={4000}
                      onChange={(e) => patch({ description: e.target.value })}
                    />
                  </label>
                </>
              )}
              {selectedDecoration && (
                <>
                  <label>
                    Тип декорации
                    <select value={selectedDecoration.kind} onChange={(e) => patch({ kind: e.target.value })}>
                      <option value="table">Стол</option><option value="chair">Стул</option><option value="sofa">Диван</option><option value="desk">Рабочий стол</option><option value="plant">Растение</option><option value="counter">Стойка</option><option value="shelf">Стеллаж</option>
                    </select>
                  </label>
                  <div className="plan-pair">
                    <label>Ширина<input type="number" min="8" value={selectedDecoration.width} onChange={(e) => patch({ width: Number(e.target.value) })} /></label>
                    <label>Высота<input type="number" min="8" value={selectedDecoration.height} onChange={(e) => patch({ height: Number(e.target.value) })} /></label>
                  </div>
                </>
              )}
              {'x' in item && (
                <>
                  <div className="plan-pair">
                    <label>
                      X
                      <input
                        type="number"
                        value={item.x}
                        onChange={(e) => move(Number(e.target.value), item.y)}
                      />
                    </label>
                    <label>
                      Y
                      <input
                        type="number"
                        value={item.y}
                        onChange={(e) => move(item.x, Number(e.target.value))}
                      />
                    </label>
                  </div>
                  <button onClick={() => switchTool('move')}>Переместить на плане</button>
                </>
              )}
              {selectedRoom && (
                <>
                  <div className="plan-room-metrics"><strong>{(selectedRoom.width * selectedRoom.height * floor.metersPerUnit ** 2).toFixed(2)} м²</strong><span>{(selectedRoom.width * floor.metersPerUnit).toFixed(2)} × {(selectedRoom.height * floor.metersPerUnit).toFixed(2)} м · по масштабу этажа</span></div>
                  <div className="plan-pair">
                    <label>
                      Ширина объекта
                      <input
                        type="number"
                        min="1"
                        value={selectedRoom.width}
                        onChange={(e) => patch({ width: Number(e.target.value) })}
                      />
                    </label>
                    <label>
                      Высота объекта
                      <input
                        type="number"
                        min="1"
                        value={selectedRoom.height}
                        onChange={(e) => patch({ height: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <label>
                    Тип помещения
                    <select
                      value={selectedRoom.kind}
                      onChange={(e) => patch({ kind: e.target.value })}
                    >
                      <option value="room">Комната со стенами</option>
                      <option value="corridor">Открытый коридор</option>
                    </select>
                  </label>
                </>
              )}
              {selectedEdge && (
                <>
                  <p className="plan-help">
                    {draft.nodes.find((n) => n.id === selectedEdge.fromId)?.label} →{' '}
                    {draft.nodes.find((n) => n.id === selectedEdge.toId)?.label}
                  </p>
                  {(['blocked', 'accessible', 'bidirectional'] as const).map((field, index) => (
                    <label className="plan-check" key={field}>
                      <input
                        type="checkbox"
                        checked={selectedEdge[field]}
                        onChange={(e) => patch({ [field]: e.target.checked })}
                      />
                      {['Проход закрыт', 'Без ступеней', 'В обе стороны'][index]}
                    </label>
                  ))}
                  {selectedEdge.kind !== 'walk' && (
                    <label>
                      Длина перехода между этажами, м
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={selectedEdge.distanceMeters ?? 6}
                        onChange={(e) => patch({ distanceMeters: Number(e.target.value) })}
                      />
                    </label>
                  )}
                </>
              )}
              <button className="plan-danger" onClick={remove}>
                Удалить объект
              </button>
              <p className="plan-help">
                Удаление узла убирает связанные места, проходы и панорамы. Действие можно отменить
                до сохранения.
              </p>
            </>
          )}
          <h3>Объекты этажа</h3>
          <label>Найти объект<input type="search" value={objectQuery} onChange={(event) => setObjectQuery(event.target.value)} placeholder="Название комнаты или точки" /></label>
          <div className="plan-object-filters" role="group" aria-label="Типы объектов этажа">
            {([
              ['all', 'Все', draft.rooms.filter((room) => room.floorId === floor.id).length + draft.places.filter((place) => place.floorId === floor.id).length + draft.nodes.filter((node) => node.floorId === floor.id && !draft.places.some((place) => place.nodeId === node.id)).length + draft.edges.filter((edge) => draft.nodes.some((node) => node.id === edge.fromId && node.floorId === floor.id)).length + (draft.decorations ?? []).filter((decoration) => decoration.floorId === floor.id).length],
              ['rooms', 'Комнаты', draft.rooms.filter((room) => room.floorId === floor.id).length],
              ['places', 'Места', draft.places.filter((place) => place.floorId === floor.id).length],
              ['routes', 'Сеть', draft.nodes.filter((node) => node.floorId === floor.id).length + draft.edges.filter((edge) => draft.nodes.some((node) => node.id === edge.fromId && node.floorId === floor.id)).length],
              ['decorations', 'Мебель', (draft.decorations ?? []).filter((decoration) => decoration.floorId === floor.id).length],
            ] as const).map(([value, label, count]) => <button key={value} aria-pressed={objectFilter === value} onClick={() => setObjectFilter(value)}>{label}<span>{count}</span></button>)}
          </div>
          <div className="plan-object-list">
            {(objectFilter === 'all' ? ['rooms', 'places', 'nodes', 'edges', 'decorations'] as const : objectFilter === 'routes' ? ['nodes', 'edges'] as const : [objectFilter] as const).map((kind) =>
              draft[kind]
                .filter((i) =>
                  'floorId' in i
                    ? i.floorId === floor.id
                    : draft.nodes.find((n) => n.id === i.fromId)?.floorId === floor.id ||
                      draft.nodes.find((n) => n.id === i.toId)?.floorId === floor.id,
                )
                .filter((i) => kind !== 'nodes' || objectFilter === 'routes' || !draft.places.some((place) => place.nodeId === i.id))
                .filter((i) => ('name' in i ? i.name : 'label' in i ? i.label : 'kind' in i ? i.kind : `${draft.nodes.find((n) => n.id === (i as Edge).fromId)?.label} ${draft.nodes.find((n) => n.id === (i as Edge).toId)?.label}`).toLocaleLowerCase('ru').includes(objectQuery.toLocaleLowerCase('ru')))
                .map((i) => (
                  <button
                    key={i.id}
                    aria-pressed={selection?.id === i.id}
                    onClick={() => {
                      setSelection({ kind, id: i.id });
                      switchTool('select');
                    }}
                  >
                    {'name' in i
                      ? i.name
                      : 'label' in i
                        ? i.label
                      : 'kind' in i
                        ? i.kind
                        : `${draft.nodes.find((n) => n.id === (i as Edge).fromId)?.label} → ${draft.nodes.find((n) => n.id === (i as Edge).toId)?.label}`}
                  </button>
                )),
            )}
          </div>
        </aside>
        </div>
        {view3d && <div className="plan-3d-shell is-open" data-testid="plan-editor-3d">
          <div className="plan-3d-toolbar">
            <div><strong>Объёмный обзор здания</strong><span>Все этажи и межэтажные связи в одной сцене</span></div>
            <p>Это рабочая 3D-схема конструктора: нажмите на место, чтобы перейти к его этажу и свойствам. Геометрия остаётся редактируемой в 2D-плане.</p>
          </div>
          <IsometricMap
            project={draft}
            details={true}
            activeFloorId={floor.id}
            selected={null}
            route={null}
            onSelect={(place) => { setFloorId(place.floorId); setSelection({ kind: 'places', id: place.id }); setView3d(false); }}
            onPanorama={() => setNotice('Панорамы открываются из основного просмотра после сохранения плана.')}
          />
        </div>}
      </div>}
    </div>
  );
}
