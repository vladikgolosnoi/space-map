import type { Place, Project } from './types';
import { roomAppearance } from './mapAppearance';

export default function PlacePreview({ project, place }: { project: Project; place: Place }) {
  const floor = project.floors.find((item) => item.id === place.floorId);
  if (!floor) return null;
  const rooms = project.rooms.filter((room) => room.floorId === place.floorId);
  const left = Math.min(place.x, ...rooms.map((room) => room.x)) - 35;
  const top = Math.min(place.y, ...rooms.map((room) => room.y)) - 35;
  const right = Math.max(place.x, ...rooms.map((room) => room.x + room.width)) + 35;
  const bottom = Math.max(place.y, ...rooms.map((room) => room.y + room.height)) + 35;
  const { fill, ink, Icon } = roomAppearance(place.name, place.category);
  return (
    <div className="place-preview" style={{ backgroundColor: fill }}>
      <div className="place-preview-heading"><span><Icon size={16} /> На плане</span><strong>{floor.name}</strong></div>
      <svg viewBox={`${left} ${top} ${Math.max(right - left, 100)} ${Math.max(bottom - top, 100)}`} role="img" aria-label={`Расположение: ${place.name}, ${floor.name}`}>
        {rooms.map((room) => {
          const selected = room.kind === 'room' && place.x > room.x && place.x < room.x + room.width && place.y > room.y && place.y < room.y + room.height;
          return <rect key={room.id} x={room.x} y={room.y} width={room.width} height={room.height} rx="5" fill={selected ? ink : '#fff'} fillOpacity={selected ? .85 : .5} stroke={selected ? ink : '#fff'} strokeWidth="5" />;
        })}
        <circle cx={place.x} cy={place.y} r="24" fill={ink} stroke="white" strokeWidth="8" />
        <circle cx={place.x} cy={place.y} r="6" fill="white" />
      </svg>
      <span className="place-preview-caption">Выбранное место на схеме этажа</span>
    </div>
  );
}
