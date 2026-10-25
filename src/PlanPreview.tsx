import { useState } from 'react';
import MapCanvas from './MapCanvas';
import PlacePreview from './PlacePreview';
import PanoramaViewer from './PanoramaViewer';
import type { Project, Route } from './types';
import { shortestRoute } from './routing';

export default function PlanPreview({ project, validationError = '' }: { project: Project; validationError?: string }) {
  const [floorId, setFloorId] = useState(project.floors[0].id);
  const [placeId, setPlaceId] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [start, setStart] = useState(project.places[0]?.nodeId ?? '');
  const [end, setEnd] = useState(project.places.at(-1)?.nodeId ?? '');
  const [accessible, setAccessible] = useState(false);
  const [route, setRoute] = useState<Route | null>(null);
  const [error, setError] = useState('');
  const floor = project.floors.find((f) => f.id === floorId) ?? project.floors[0];
  const selected = project.places.find((p) => p.id === placeId) ?? null;
  const scene = project.panoramas.find((p) => p.id === sceneId);
  return <div className="plan-preview-shell">
    <aside className="plan-preview-info">
      <span className="plan-eyebrow">ПРЕДПРОСМОТР ЧЕРНОВИКА</span>
      <h2>{project.title}</h2>
      <p className="plan-help">Проверьте оформление, этажи и карточки мест перед сохранением. Этот просмотр не публикует изменения.</p>
      <form onSubmit={(event) => {
        event.preventDefault(); setError(''); setRoute(null);
        try {
          if (validationError) throw new Error(validationError);
          if (project.floors.some((f) => !Number.isFinite(f.metersPerUnit) || f.metersPerUnit <= 0) ||
              project.edges.some((e) => e.distanceMeters != null && (!Number.isFinite(e.distanceMeters) || e.distanceMeters <= 0))) {
            throw new Error('Масштаб этажей и длины переходов должны быть положительными числами');
          }
          const result = shortestRoute(project, start, end, accessible); setRoute(result); setFloorId(result.nodes[0].floorId);
        }
        catch (err) { setError(err instanceof Error ? err.message : 'Не удалось построить маршрут'); }
      }}>
        <h3>Проверка маршрута</h3>
        <label>Начальная точка<select value={start} onChange={(event) => { setStart(event.target.value); setRoute(null); }}>{project.places.map((p) => <option key={p.id} value={p.nodeId}>{p.name}</option>)}</select></label>
        <label>Конечная точка<select value={end} onChange={(event) => { setEnd(event.target.value); setRoute(null); }}>{project.places.map((p) => <option key={p.id} value={p.nodeId}>{p.name}</option>)}</select></label>
        <label className="plan-check"><input type="checkbox" checked={accessible} onChange={(event) => { setAccessible(event.target.checked); setRoute(null); }} />Без лестниц</label>
        <button className="plan-primary" disabled={!start || !end}>Проверить маршрут</button>
        {error && <p role="alert">{error}. Вернитесь в конструктор и проверьте соединения точек.</p>}
        {route && <ol className="route-steps" data-testid="draft-route-result">{route.steps.map((step, i) => <li key={i}><span>{i + 1}</span><p>{step}</p></li>)}</ol>}
      </form>
      {selected ? <><PlacePreview project={project} place={selected} /><h3>{selected.name}</h3><p>{selected.description}</p></> : <p className="plan-help">Нажмите на место на карте. Переключатель «Объём» покажет этажи вместе.</p>}
    </aside>
    <MapCanvas project={project} floor={floor} selected={selected} route={route} onFloor={setFloorId} onSelect={(place) => { setPlaceId(place.id); setFloorId(place.floorId); }} onPanorama={setSceneId} />
    {scene && <PanoramaViewer project={project} panorama={scene} editable={false} onClose={() => setSceneId(null)} onScene={setSceneId} onViewChange={() => {}} onSave={async () => {}} />}
  </div>;
}
