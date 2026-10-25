import { Armchair, BriefcaseBusiness, Coffee, DoorOpen, ArrowUpDown, Info, Presentation } from 'lucide-react';
import type { Decoration, Place, Room } from './types';
import { demoInterior, interiorColors } from './demoInterior';

// Visual categories describe a room's purpose; they never affect route accessibility.
export function roomAppearance(name: string, category = '') {
  const text = `${name} ${category}`.toLocaleLowerCase('ru');
  if (/кафе|кофе/.test(text)) return { fill: '#f4e9dc', ink: '#936638', Icon: Coffee };
  if (/зал|переговор|студия/.test(text)) return { fill: '#e7eaf6', ink: '#626b9a', Icon: Presentation };
  if (/коворкинг|мастерск|медиатек/.test(text)) return { fill: '#e3eeeb', ink: '#46786c', Icon: BriefcaseBusiness };
  if (/лаунж|отдых/.test(text)) return { fill: '#edf0df', ink: '#75804c', Icon: Armchair };
  if (/лифт/.test(text)) return { fill: '#e7ecef', ink: '#536974', Icon: ArrowUpDown };
  if (/вход/.test(text)) return { fill: '#e7ecef', ink: '#536974', Icon: DoorOpen };
  return { fill: '#edf0f2', ink: '#617582', Icon: Info };
}

export function placeInRoom(room: Room, places: Place[]) {
  return places.find((place) => place.floorId === room.floorId &&
    place.x > room.x && place.x < room.x + room.width &&
    place.y > room.y && place.y < room.y + room.height);
}

export function PlaceGlyph({ place, active }: { place: Place; active: boolean }) {
  const { Icon, ink } = roomAppearance(place.name, place.category);
  return <Icon x={-8} y={-8} width={16} height={16} stroke={active ? '#fff' : ink} strokeWidth={1.8} />;
}

export function PlanFurniture({ room }: { room: Room }) {
  if (!demoInterior(room).length) return null;
  return <g className="room-interior" pointerEvents="none" aria-hidden="true">
    {demoInterior(room).map((shape, index) => <g key={index}>
      <rect x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.round ? Math.min(shape.width, shape.height) / 2 : 2}
        fill={interiorColors[shape.kind]} stroke={shape.kind === 'plant' ? '#63856a' : '#8e9da5'} strokeWidth=".8" />
      {shape.kind === 'shelf' && [1, 2, 3].map((i) => <path key={i} d={`M${shape.x + i * shape.width / 4} ${shape.y + 2}v${Math.max(0, shape.height - 4)}`} stroke="#fff8e8" strokeWidth="1.5" />)}
      {shape.kind === 'plant' && <path d={`M${shape.x + shape.width / 2} ${shape.y + 2}v${Math.max(0, shape.height - 4)}`} stroke="#d9e6d7" />}
    </g>)}
  </g>;
}

export function PlanDecorations({ items }: { items: Decoration[] }) {
  if (!items.length) return null;
  return <g className="room-interior" aria-hidden="true" pointerEvents="none">
    {items.map((item) => <g key={item.id} transform={`rotate(${item.rotation ?? 0} ${item.x + item.width / 2} ${item.y + item.height / 2})`}>
      {item.kind === 'plant' ? <circle cx={item.x + item.width / 2} cy={item.y + item.height / 2} r={Math.min(item.width, item.height) / 2} fill={interiorColors.plant} stroke="#63856a" strokeWidth="1.2" /> : <rect x={item.x} y={item.y} width={item.width} height={item.height} rx={item.kind === 'sofa' ? 6 : 2} fill={{ table: interiorColors.table, chair: interiorColors.seat, sofa: '#8a718f', desk: '#8d9ca3', counter: interiorColors.counter, shelf: interiorColors.shelf }[item.kind]} stroke="#71838c" strokeWidth="1.2" />}
    </g>)}
  </g>;
}
