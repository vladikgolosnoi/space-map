"""Versioned API models and building integrity checks."""
from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from .geometry import crosses_room_wall


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Floor(Model):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=100)
    level: int
    width: float = Field(gt=0, le=100_000)
    height: float = Field(gt=0, le=100_000)
    metersPerUnit: float = Field(gt=0, le=100)
    backgroundAssetId: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")


class Room(Model):
    id: str = Field(min_length=1, max_length=100)
    floorId: str
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["room", "corridor"] = "room"
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class Node(Model):
    id: str = Field(min_length=1, max_length=100)
    floorId: str
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    label: str = Field(default="", max_length=200)
    kind: Literal["walk", "stairs", "elevator"] = "walk"


class Edge(Model):
    id: str = Field(min_length=1, max_length=100)
    fromId: str
    toId: str
    kind: Literal["walk", "stairs", "elevator"] = "walk"
    accessible: bool = True
    blocked: bool = False
    bidirectional: bool = True
    distanceMeters: float | None = Field(default=None, gt=0, le=1_000_000_000)


class Place(Model):
    id: str = Field(min_length=1, max_length=100)
    floorId: str
    nodeId: str
    name: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=4000)
    x: float = Field(ge=0)
    y: float = Field(ge=0)


class Decoration(Model):
    id: str = Field(min_length=1, max_length=100)
    floorId: str
    roomId: str | None = None
    kind: Literal["table", "chair", "sofa", "desk", "plant", "counter", "shelf"]
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)
    rotation: float = Field(default=0, ge=-360, le=360)


class Hotspot(Model):
    id: str = Field(min_length=1, max_length=100)
    yaw: float = Field(ge=-180, le=180)
    pitch: float = Field(ge=-90, le=90)
    text: str = Field(min_length=1, max_length=500)
    kind: Literal["info", "scene"] = "info"
    placeId: str | None = None
    targetPanoramaId: str | None = None

    @model_validator(mode="after")
    def validate_target(self) -> Hotspot:
        if self.kind == "scene" and (not self.targetPanoramaId or self.placeId):
            raise ValueError("Scene hotspot needs a panorama target, without a place target")
        if self.kind == "info" and self.targetPanoramaId:
            raise ValueError("Information hotspot cannot target another panorama")
        return self


class Panorama(Model):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=200)
    floorId: str
    nodeId: str
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    yawOffset: float = Field(default=0, ge=-180, le=180)
    assetId: str = Field(pattern=r"^[a-f0-9]{32}$")
    thumbnailId: str = Field(pattern=r"^[a-f0-9]{32}$")
    projection: Literal["equirectangular"] = "equirectangular"
    haov: float = Field(gt=0, le=360)
    vaov: float = Field(gt=0, le=180)
    vOffset: float = Field(ge=-90, le=90)
    width: int = Field(gt=0, le=8192)
    height: int = Field(gt=0, le=4096)
    source: Literal["stitched", "imported"]
    hotspots: list[Hotspot] = Field(default_factory=list, max_length=300)

    @model_validator(mode="after")
    def validate_view(self) -> Panorama:
        if abs(self.vOffset) + self.vaov / 2 > 90.01:
            raise ValueError("Vertical panorama bounds extend beyond the poles")
        if self.width * self.height > 32_000_000:
            raise ValueError("Panorama exceeds 32 megapixels")
        if len({hotspot.id for hotspot in self.hotspots}) != len(self.hotspots):
            raise ValueError("Duplicate hotspot IDs")
        for hotspot in self.hotspots:
            if abs(hotspot.yaw) > self.haov / 2 + 0.01 or abs(hotspot.pitch - self.vOffset) > self.vaov / 2 + 0.01:
                raise ValueError("Hotspot is outside the photographed panorama bounds")
        return self


class Project(Model):
    id: str = Field(default="demo", min_length=1, max_length=80, pattern=r"^[a-z0-9][a-z0-9-]*$")
    slug: str = Field(default="demo", min_length=1, max_length=80, pattern=r"^[a-z0-9][a-z0-9-]*$")
    title: str = Field(min_length=1, max_length=200)
    revision: int = Field(ge=1)
    floors: list[Floor] = Field(min_length=1, max_length=100)
    rooms: list[Room] = Field(default_factory=list, max_length=2000)
    nodes: list[Node] = Field(default_factory=list, max_length=10000)
    edges: list[Edge] = Field(default_factory=list, max_length=50000)
    places: list[Place] = Field(default_factory=list, max_length=5000)
    decorations: list[Decoration] = Field(default_factory=list, max_length=20000)
    panoramas: list[Panorama] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def validate_building(self) -> Project:
        for name in ("floors", "rooms", "nodes", "edges", "places", "decorations", "panoramas"):
            items = getattr(self, name)
            if len({item.id for item in items}) != len(items):
                raise ValueError(f"Duplicate IDs in {name}")
        floors = {floor.id: floor for floor in self.floors}
        if len({f.level for f in self.floors}) != len(self.floors):
            raise ValueError("Floor levels must be unique")
        nodes = {node.id: node for node in self.nodes}
        for item in [*self.rooms, *self.nodes, *self.places, *self.decorations, *self.panoramas]:
            floor = floors.get(item.floorId)
            if floor is None:
                raise ValueError(f"Unknown floor for {item.id}")
            right = item.x + (item.width if isinstance(item, Room) else 0)
            bottom = item.y + (item.height if isinstance(item, Room) else 0)
            if right > floor.width or bottom > floor.height:
                raise ValueError(f"Coordinates outside floor for {item.id}")
        for place in self.places:
            if place.nodeId not in nodes:
                raise ValueError(f"Unknown node for place {place.id}")
            if nodes[place.nodeId].floorId != place.floorId:
                raise ValueError(f"Place and node must be on the same floor: {place.id}")
        room_ids = {room.id for room in self.rooms}
        for decoration in self.decorations:
            if decoration.roomId is not None and decoration.roomId not in room_ids:
                raise ValueError(f"Unknown room for decoration {decoration.id}")
        panorama_ids = {panorama.id for panorama in self.panoramas}
        place_ids = {place.id for place in self.places}
        for panorama in self.panoramas:
            if panorama.nodeId not in nodes or nodes[panorama.nodeId].floorId != panorama.floorId:
                raise ValueError(f"Panorama needs a node on the same floor: {panorama.id}")
            for hotspot in panorama.hotspots:
                if hotspot.placeId is not None and hotspot.placeId not in place_ids:
                    raise ValueError(f"Unknown place for hotspot: {hotspot.id}")
                if hotspot.targetPanoramaId is not None and (hotspot.targetPanoramaId not in panorama_ids or hotspot.targetPanoramaId == panorama.id):
                    raise ValueError(f"Unknown or self-referencing panorama target: {hotspot.id}")
        for edge in self.edges:
            if edge.fromId not in nodes or edge.toId not in nodes:
                raise ValueError(f"Unknown endpoint for edge {edge.id}")
            start, end = nodes[edge.fromId], nodes[edge.toId]
            if start.id == end.id:
                raise ValueError(f"Self-loop is not a navigable edge: {edge.id}")
            if start.floorId != end.floorId:
                if edge.kind == "walk":
                    raise ValueError(f"Cross-floor edge needs stairs or elevator: {edge.id}")
                if start.kind != edge.kind or end.kind != edge.kind:
                    raise ValueError(f"Cross-floor endpoints must match connector kind: {edge.id}")
                if edge.distanceMeters is None:
                    raise ValueError(f"Cross-floor distance is required: {edge.id}")
            elif edge.distanceMeters is None:
                length = math.hypot(start.x - end.x, start.y - end.y)
                if length <= 0:
                    raise ValueError(f"Edge must have positive length: {edge.id}")
            if edge.kind == "stairs" and edge.accessible:
                raise ValueError(f"Stairs cannot be an accessible edge: {edge.id}")
            if start.floorId == end.floorId:
                for room in self.rooms:
                    if room.kind == "room" and room.floorId == start.floorId and crosses_room_wall(start, end, room):
                        raise ValueError(f"Проход пересекает стену помещения «{room.name}». Поставьте узел двери на границе и соедините путь через него.")
        return self


class RouteRequest(Model):
    startId: str
    endId: str
    profile: Literal["shortest", "accessible"] = "shortest"


class RouteResult(Model):
    nodes: list[Node]
    edgeIds: list[str]
    distanceMeters: float
    durationSeconds: int
    steps: list[str]


class SessionRequest(Model):
    password: str = Field(min_length=1, max_length=1024)


class PublishRequest(Model):
    revision: int = Field(ge=1)


class AccountRegisterRequest(Model):
    email: str = Field(min_length=3, max_length=254)
    name: str = Field(min_length=1, max_length=100)
    organization: str = Field(default="", max_length=160)
    password: str = Field(min_length=12, max_length=1024)


class AccountLoginRequest(Model):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=1024)


class SpaceCreateRequest(Model):
    title: str = Field(min_length=1, max_length=200)
    organizationId: str | None = Field(default=None, min_length=8, max_length=80)


class OrganizationInviteRequest(Model):
    organizationId: str = Field(min_length=8, max_length=80)
    email: str = Field(min_length=3, max_length=254)
    role: str = Field(pattern=r"^(admin|editor|viewer)$")


class InviteAcceptRequest(Model):
    token: str = Field(min_length=32, max_length=128)


class MemberRoleRequest(Model):
    role: str = Field(pattern=r"^(admin|editor|viewer)$")


class ViewRequest(Model):
    visitorId: str = Field(pattern=r"^[a-f0-9]{32}$")
