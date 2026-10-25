"""Dijkstra on explicit indoor graph edges, never inferred straight lines."""
from __future__ import annotations

import heapq
import math

from .models import Edge, Project, RouteRequest, RouteResult


class UnknownNodeError(ValueError):
    pass


class NoRouteError(ValueError):
    pass


def shortest_route(project: Project, request: RouteRequest) -> RouteResult:
    nodes = {node.id: node for node in project.nodes}
    floors = {floor.id: floor for floor in project.floors}
    if request.startId not in nodes or request.endId not in nodes:
        raise UnknownNodeError("Начальная или конечная точка не найдена")

    def distance(edge: Edge) -> float:
        if edge.distanceMeters is not None:
            return edge.distanceMeters
        a, b = nodes[edge.fromId], nodes[edge.toId]
        return math.hypot(a.x - b.x, a.y - b.y) * floors[a.floorId].metersPerUnit

    adjacency: dict[str, list[tuple[str, Edge, float]]] = {node_id: [] for node_id in nodes}
    for edge in project.edges:
        if edge.blocked:
            continue
        if request.profile == "accessible" and (not edge.accessible or edge.kind == "stairs"):
            continue
        length = distance(edge)
        adjacency[edge.fromId].append((edge.toId, edge, length))
        if edge.bidirectional:
            adjacency[edge.toId].append((edge.fromId, edge, length))

    distances = {request.startId: 0.0}
    previous: dict[str, tuple[str, Edge]] = {}
    queue = [(0.0, request.startId)]
    while queue:
        cost, node_id = heapq.heappop(queue)
        if cost != distances[node_id]:
            continue
        if node_id == request.endId:
            break
        for next_id, edge, length in adjacency[node_id]:
            candidate = cost + length
            if candidate < distances.get(next_id, math.inf):
                distances[next_id] = candidate
                previous[next_id] = (node_id, edge)
                heapq.heappush(queue, (candidate, next_id))

    if request.endId not in distances:
        raise NoRouteError("Доступного пути нет. Проверьте закрытые проходы и выбранный профиль.")
    path = [request.endId]
    edges: list[Edge] = []
    while path[-1] != request.startId:
        predecessor, edge = previous[path[-1]]
        path.append(predecessor)
        edges.append(edge)
    path.reverse()
    edges.reverse()
    route_nodes = [nodes[node_id] for node_id in path]
    place_names = {place.nodeId: place.name for place in project.places}
    total = distances[request.endId]
    if not edges:
        return RouteResult(nodes=route_nodes, edgeIds=[], distanceMeters=0, durationSeconds=0,
                           steps=["Вы уже в точке назначения."])

    steps = [f"Начните маршрут: {place_names.get(route_nodes[0].id) or route_nodes[0].label or 'выбранная точка'}. "]
    walk_distance = 0.0
    transition_delay = 0
    for index, edge in enumerate(edges):
        start, end = route_nodes[index], route_nodes[index + 1]
        if start.floorId == end.floorId:
            walk_distance += distance(edge)
            continue
        if walk_distance:
            steps.append(f"Пройдите по отмеченному пути {round(walk_distance)} м.")
            walk_distance = 0
        up = floors[end.floorId].level > floors[start.floorId].level
        direction = "Поднимитесь" if up else "Спуститесь"
        connector = "на лифте" if edge.kind == "elevator" else "по лестнице"
        steps.append(f"{direction} {connector}: {floors[end.floorId].name}.")
        transition_delay += 25 if edge.kind == "elevator" else 10
    if walk_distance:
        steps.append(f"Пройдите по отмеченному пути {round(walk_distance)} м.")
    steps.append(f"Вы на месте: {place_names.get(route_nodes[-1].id) or route_nodes[-1].label or 'точка назначения'}.")
    speed = 1.0 if request.profile == "accessible" else 1.3
    return RouteResult(nodes=route_nodes, edgeIds=[edge.id for edge in edges],
                       distanceMeters=round(total, 2),
                       durationSeconds=math.ceil(total / speed + transition_delay), steps=steps)
