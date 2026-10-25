import type { Edge, Project, Route } from './types';

// Dijkstra over explicit edges. Queue ties follow the server's node-ID ordering.
export function shortestRoute(
  project: Project,
  startId: string,
  endId: string,
  accessible: boolean,
): Route {
  const nodes = new Map(project.nodes.map((n) => [n.id, n]));
  const floors = new Map(project.floors.map((f) => [f.id, f]));
  if (!nodes.has(startId) || !nodes.has(endId))
    throw new Error('Начальная или конечная точка не найдена');
  const length = (edge: Edge) => {
    const a = nodes.get(edge.fromId)!,
      b = nodes.get(edge.toId)!;
    return (
      edge.distanceMeters ?? Math.hypot(a.x - b.x, a.y - b.y) * floors.get(a.floorId)!.metersPerUnit
    );
  };
  const adjacency = new Map(
    project.nodes.map((n) => [n.id, [] as { to: string; edge: Edge; distance: number }[]]),
  );
  for (const edge of project.edges) {
    if (edge.blocked || (accessible && (!edge.accessible || edge.kind === 'stairs'))) continue;
    const distance = length(edge);
    adjacency.get(edge.fromId)!.push({ to: edge.toId, edge, distance });
    if (edge.bidirectional) adjacency.get(edge.toId)!.push({ to: edge.fromId, edge, distance });
  }
  const distances = new Map([[startId, 0]]);
  const previous = new Map<string, { from: string; edge: Edge }>();
  const queue = [{ id: startId, cost: 0 }];
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const { id, cost } = queue.shift()!;
    if (cost !== distances.get(id)) continue;
    if (id === endId) break;
    for (const { to, edge, distance } of adjacency.get(id)!) {
      const candidate = cost + distance;
      if (candidate < (distances.get(to) ?? Infinity)) {
        distances.set(to, candidate);
        previous.set(to, { from: id, edge });
        queue.push({ id: to, cost: candidate });
      }
    }
  }
  const total = distances.get(endId);
  if (total === undefined)
    throw new Error('Прохода по выбранным условиям нет. Измените точки или режим маршрута.');
  const path = [endId],
    edges: Edge[] = [];
  while (path[path.length - 1] !== startId) {
    const item = previous.get(path[path.length - 1])!;
    path.push(item.from);
    edges.push(item.edge);
  }
  path.reverse();
  edges.reverse();
  const routeNodes = path.map((id) => nodes.get(id)!);
  if (!edges.length)
    return {
      nodes: routeNodes,
      edgeIds: [],
      distanceMeters: 0,
      durationSeconds: 0,
      steps: ['Вы уже в точке назначения.'],
    };
  const names = new Map(project.places.map((p) => [p.nodeId, p.name]));
  const steps = [
    `Начните маршрут: ${names.get(startId) || nodes.get(startId)!.label || 'выбранная точка'}. `,
  ];
  // Match Python's ties-to-even whole-metre instruction rounding.
  const round = (n: number) => (n % 1 === 0.5 ? 2 * Math.round(n / 2) : Math.round(n));
  let walk = 0,
    delay = 0;
  const flush = () => {
    if (walk) steps.push(`Пройдите по отмеченному пути ${round(walk)} м.`);
    walk = 0;
  };
  edges.forEach((edge, index) => {
    const a = routeNodes[index],
      b = routeNodes[index + 1];
    if (a.floorId === b.floorId) {
      walk += length(edge);
      return;
    }
    flush();
    const destination = floors.get(b.floorId)!;
    const direction =
      destination.level > floors.get(a.floorId)!.level ? 'Поднимитесь' : 'Спуститесь';
    steps.push(
      `${direction} ${edge.kind === 'elevator' ? 'на лифте' : 'по лестнице'}: ${destination.name}.`,
    );
    delay += edge.kind === 'elevator' ? 25 : 10;
  });
  flush();
  steps.push(`Вы на месте: ${names.get(endId) || nodes.get(endId)!.label || 'точка назначения'}.`);
  return {
    nodes: routeNodes,
    edgeIds: edges.map((e) => e.id),
    distanceMeters: Number(total.toFixed(2)),
    durationSeconds: Math.ceil(total / (accessible ? 1 : 1.3) + delay),
    steps,
  };
}
