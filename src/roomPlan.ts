export interface RoomPlanWall {
  id: string;
  start: [number, number];
  end: [number, number];
  confidence: 'low' | 'medium' | 'high';
}

export interface RoomPlanOpening {
  id: string;
  kind: 'door' | 'opening' | 'window';
  center: [number, number];
  width: number;
  confidence: 'low' | 'medium' | 'high';
}

export interface RoomPlanObject {
  id: string;
  category: string;
  center: [number, number];
  size: [number, number, number];
  confidence: 'low' | 'medium' | 'high';
}

export interface RoomPlanRoom {
  id: string;
  name: string;
  story?: number;
  height?: number;
  walls: RoomPlanWall[];
  openings: RoomPlanOpening[];
  objects?: RoomPlanObject[];
}

export interface RoomPlanScan {
  format: 'space-map-roomplan';
  version: 1;
  unit: 'm';
  source?: string;
  capturedAt?: string;
  rooms: RoomPlanRoom[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function finitePair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((part) => typeof part === 'number' && Number.isFinite(part) && Math.abs(part) <= 1000)
  );
}

function confidence(value: unknown): value is RoomPlanWall['confidence'] {
  return value === 'low' || value === 'medium' || value === 'high';
}

export async function readRoomPlan(file: File): Promise<RoomPlanScan> {
  if (file.size > 5 * 1024 * 1024) throw new Error('Файл скана должен быть меньше 5 МБ.');
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error('Не удалось прочитать JSON скана.');
  }
  if (!isObject(raw) || raw.format !== 'space-map-roomplan' || raw.version !== 1 || raw.unit !== 'm')
    throw new Error('Нужен экспорт Space Map RoomPlan v1 с размерами в метрах.');
  if (!Array.isArray(raw.rooms) || raw.rooms.length < 1 || raw.rooms.length > 100)
    throw new Error('В файле должно быть от 1 до 100 помещений.');
  let wallCount = 0;
  let openingCount = 0;
  let objectCount = 0;
  const roomIds = new Set<string>();
  const rooms: RoomPlanRoom[] = raw.rooms.map((entry, index) => {
    if (!isObject(entry) || typeof entry.id !== 'string' || entry.id.length > 128 || typeof entry.name !== 'string' || entry.name.length > 200)
      throw new Error(`Помещение ${index + 1}: некорректный идентификатор или название.`);
    if (roomIds.has(entry.id)) throw new Error(`Помещение ${index + 1}: повторяется идентификатор.`);
    roomIds.add(entry.id);
    if (!Array.isArray(entry.walls) || entry.walls.length < 1 || entry.walls.length > 500)
      throw new Error(`Помещение «${entry.name}»: список стен пуст или слишком велик.`);
    const walls = entry.walls.map((item, wallIndex) => {
      if (
        !isObject(item) ||
        typeof item.id !== 'string' ||
        !finitePair(item.start) ||
        !finitePair(item.end) ||
        !confidence(item.confidence) ||
        Math.hypot(item.end[0] - item.start[0], item.end[1] - item.start[1]) < 0.05
      )
        throw new Error(`Помещение «${entry.name}»: стена ${wallIndex + 1} имеет неверные данные.`);
      return {
        id: item.id,
        start: item.start,
        end: item.end,
        confidence: item.confidence,
      };
    });
    const openings = (entry.openings === undefined ? [] : entry.openings);
    if (!Array.isArray(openings) || openings.length > 2000)
      throw new Error(`Помещение «${entry.name}»: список проёмов имеет неверный формат.`);
    const parsedOpenings = openings.map((item, openingIndex) => {
      if (
        !isObject(item) ||
        typeof item.id !== 'string' ||
        !['door', 'opening', 'window'].includes(String(item.kind)) ||
        !finitePair(item.center) ||
        typeof item.width !== 'number' ||
        !Number.isFinite(item.width) ||
        item.width <= 0 ||
        item.width > 20 ||
        !confidence(item.confidence)
      )
        throw new Error(`Помещение «${entry.name}»: проём ${openingIndex + 1} имеет неверные данные.`);
      return {
        id: item.id,
        kind: item.kind as RoomPlanOpening['kind'],
        center: item.center,
        width: item.width,
        confidence: item.confidence,
      };
    });
    const objects = entry.objects === undefined ? [] : entry.objects;
    if (!Array.isArray(objects) || objects.length > 2000)
      throw new Error(`Помещение «${entry.name}»: список предметов имеет неверный формат.`);
    const parsedObjects = objects.map((item, objectIndex): RoomPlanObject => {
      if (
        !isObject(item) ||
        typeof item.id !== 'string' || item.id.length > 128 ||
        typeof item.category !== 'string' || item.category.length > 100 ||
        !finitePair(item.center) || !confidence(item.confidence) ||
        !Array.isArray(item.size) || item.size.length !== 3 ||
        !item.size.every((part) => typeof part === 'number' && Number.isFinite(part) && part > 0 && part <= 100)
      ) throw new Error(`Помещение «${entry.name}»: предмет ${objectIndex + 1} имеет неверные данные.`);
      return {
        id: item.id,
        category: item.category,
        center: item.center,
        size: item.size as [number, number, number],
        confidence: item.confidence,
      };
    });
    if (entry.story !== undefined && (!Number.isInteger(entry.story) || Math.abs(entry.story as number) > 100))
      throw new Error(`Помещение «${entry.name}»: номер этажа некорректен.`);
    if (entry.height !== undefined && (typeof entry.height !== 'number' || !Number.isFinite(entry.height) || entry.height < 0 || entry.height > 20))
      throw new Error(`Помещение «${entry.name}»: высота некорректна.`);
    wallCount += walls.length;
    openingCount += parsedOpenings.length;
    objectCount += parsedObjects.length;
    return {
      id: entry.id,
      name: entry.name.slice(0, 100),
      ...(entry.story === undefined ? {} : { story: entry.story as number }),
      ...(entry.height === undefined ? {} : { height: entry.height as number }),
      walls,
      openings: parsedOpenings,
      objects: parsedObjects,
    };
  });
  if (wallCount > 2000 || openingCount > 2000 || objectCount > 5000)
    throw new Error('Скан содержит слишком много геометрии.');
  return {
    format: 'space-map-roomplan', version: 1, unit: 'm',
    ...(typeof raw.source === 'string' ? { source: raw.source.slice(0, 100) } : {}),
    ...(typeof raw.capturedAt === 'string' ? { capturedAt: raw.capturedAt.slice(0, 80) } : {}),
    rooms,
  };
}

export function roomPlanBounds(scan: RoomPlanScan) {
  const points = scan.rooms.flatMap((room) => [
    ...room.walls.flatMap((wall) => [wall.start, wall.end]),
    ...room.openings.map((opening) => opening.center),
    ...(room.objects ?? []).flatMap((object) => {
      const [x, y] = object.center;
      return [[x - object.size[0] / 2, y - object.size[2] / 2] as [number, number],
        [x + object.size[0] / 2, y + object.size[2] / 2] as [number, number]];
    }),
  ]);
  const left = Math.min(...points.map(([x]) => x));
  const right = Math.max(...points.map(([x]) => x));
  const top = Math.min(...points.map(([, y]) => y));
  const bottom = Math.max(...points.map(([, y]) => y));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export async function renderRoomPlan(scan: RoomPlanScan, floorWidth: number, floorHeight: number) {
  const bounds = roomPlanBounds(scan);
  if (bounds.width < 0.5 || bounds.height < 0.5)
    throw new Error('Скан слишком узкий для предпросмотра. Проверьте ориентацию и размеры.');
  const maxSide = 1600;
  const imageScale = maxSide / Math.max(floorWidth, floorHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(320, Math.round(floorWidth * imageScale));
  canvas.height = Math.max(320, Math.round(floorHeight * imageScale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Браузер не смог подготовить изображение скана.');
  context.fillStyle = '#f7fafb';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const fit = Math.min((floorWidth * 0.8) / bounds.width, (floorHeight * 0.8) / bounds.height);
  const dx = (floorWidth - bounds.width * fit) / 2 - bounds.left * fit;
  const dy = (floorHeight - bounds.height * fit) / 2 - bounds.top * fit;
  const px = (x: number) => (dx + x * fit) * imageScale;
  const py = (y: number) => (dy + y * fit) * imageScale;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const room of scan.rooms) {
    for (const wall of room.walls) {
      context.globalAlpha = wall.confidence === 'high' ? 0.95 : wall.confidence === 'medium' ? 0.72 : 0.48;
      context.strokeStyle = wall.confidence === 'low' ? '#bd7c35' : '#233d53';
      context.lineWidth = wall.confidence === 'low' ? 5 : 8;
      context.beginPath();
      context.moveTo(px(wall.start[0]), py(wall.start[1]));
      context.lineTo(px(wall.end[0]), py(wall.end[1]));
      context.stroke();
    }
    for (const opening of room.openings) {
      const centerX = px(opening.center[0]);
      const centerY = py(opening.center[1]);
      const radius = Math.max(6, Math.min(18, opening.width * fit * imageScale * 0.45));
      context.globalAlpha = opening.confidence === 'high' ? 1 : opening.confidence === 'medium' ? 0.75 : 0.5;
      context.fillStyle = opening.kind === 'window' ? '#2d83a0' : '#df8a27';
      context.beginPath();
      context.arc(centerX, centerY, radius, 0, Math.PI * 2);
      context.fill();
    }
    for (const object of room.objects ?? []) {
      const centerX = px(object.center[0]);
      const centerY = py(object.center[1]);
      const width = Math.max(9, Math.min(70, object.size[0] * fit * imageScale));
      const height = Math.max(7, Math.min(60, object.size[2] * fit * imageScale));
      context.globalAlpha = object.confidence === 'high' ? 0.76 : object.confidence === 'medium' ? 0.55 : 0.35;
      context.fillStyle = '#5c7caa';
      context.strokeStyle = '#314d70';
      context.lineWidth = 2;
      context.fillRect(centerX - width / 2, centerY - height / 2, width, height);
      context.strokeRect(centerX - width / 2, centerY - height / 2, width, height);
    }
  }
  context.globalAlpha = 1;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error('Не удалось создать изображение подложки.');
  return new File([blob], 'roomplan-scan-preview.jpg', { type: 'image/jpeg' });
}
