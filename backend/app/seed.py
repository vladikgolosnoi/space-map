"""Fictional building, explicitly authored walkways and vertical connectors."""
from .models import Edge, Floor, Node, Place, Project, Room


def demo_project() -> Project:
    floors = [Floor(id=f"f{level}", name=f"{level} этаж", level=level, width=1000,
                    height=700, metersPerUnit=0.08) for level in (1, 2)]
    rooms: list[Room] = []
    nodes: list[Node] = []
    edges: list[Edge] = []
    places: list[Place] = []

    def room(room_id: str, floor_id: str, name: str, x: float, y: float,
             width: float, height: float, kind: str = "room") -> None:
        rooms.append(Room(id=room_id, floorId=floor_id, name=name, kind=kind,
                          x=x, y=y, width=width, height=height))

    def node(node_id: str, floor_id: str, x: float, y: float,
             label: str = "", kind: str = "walk") -> None:
        nodes.append(Node(id=node_id, floorId=floor_id, x=x, y=y, label=label, kind=kind))

    def edge(edge_id: str, a: str, b: str, **kwargs) -> None:
        edges.append(Edge(id=edge_id, fromId=a, toId=b, **kwargs))

    for floor in floors:
        prefix = floor.id
        room(f"{prefix}-corridor", prefix, "Галерея", 120, 310, 760, 90, "corridor")
        previous = None
        for suffix, x in [("entrance", 170), ("west", 205), ("cafe-junction", 430),
                          ("center", 500), ("stairs", 700), ("east", 725), ("elevator", 820)]:
            kind = suffix if suffix in ("stairs", "elevator") else "walk"
            label = {"entrance": "Вход" if prefix == "f1" else "Западная галерея",
                     "stairs": "Лестница", "elevator": "Лифт"}.get(suffix, "Галерея")
            current = f"{prefix}-{suffix}"
            node(current, prefix, x, 350, label, kind)
            if previous:
                edge(f"{previous}--{current}", previous, current)
            previous = current
        places.append(Place(id=f"elevator-{floor.level}", floorId=prefix,
                            nodeId=f"{prefix}-elevator", name=f"Лифт · {floor.level} этаж",
                            category="Лифт", description="Межэтажный доступный переход",
                            x=820, y=350))

    room("r-reception", "f1", "Ресепшен", 120, 180, 170, 130)
    room("r-cafe", "f1", "Кафе «Пульс»", 310, 180, 240, 130)
    room("r-meridian", "f1", "Зал «Меридиан»", 570, 180, 310, 130)
    room("r-lounge", "f1", "Лаунж", 120, 400, 290, 160)
    room("r-workshop", "f1", "Мастерская", 440, 400, 440, 160)
    room("r-studio", "f2", "Студия", 120, 180, 170, 130)
    room("r-coworking", "f2", "Коворкинг", 310, 180, 240, 130)
    room("r-orbit", "f2", "Переговорная «Орбита»", 570, 180, 310, 130)
    room("r-library", "f2", "Медиатека", 120, 400, 290, 160)
    room("r-terrace", "f2", "Зона отдыха", 440, 400, 440, 160)
    for place_id, floor_id, name, category, x, junction, description in [
        ("reception", "f1", "Ресепшен", "Сервис", 205, "west", "Информация и встреча гостей"),
        ("cafe", "f1", "Кафе «Пульс»", "Кафе", 430, "cafe-junction", "Кофе и место для короткой встречи"),
        ("meridian", "f1", "Зал «Меридиан»", "Зал", 725, "east", "Главный конференц-зал демонстрационного центра"),
        ("coworking", "f2", "Коворкинг", "Коворкинг", 430, "cafe-junction", "Открытое рабочее пространство"),
        ("orbit", "f2", "Переговорная «Орбита»", "Переговорная", 725, "east", "Тихая переговорная на втором этаже"),
    ]:
        point_id = f"{floor_id}-{place_id}"
        door_id = f"{point_id}-door"
        node(point_id, floor_id, x, 245, name)
        node(door_id, floor_id, x, 310, "Вход в помещение")
        edge(f"{point_id}--door", point_id, door_id)
        edge(f"{point_id}--corridor", door_id, f"{floor_id}-{junction}")
        places.append(Place(id=place_id, floorId=floor_id, nodeId=point_id,
                            name=name, category=category, description=description, x=x, y=245))
    places.insert(0, Place(id="entrance", floorId="f1", nodeId="f1-entrance", name="Главный вход",
                           category="Вход", description="Начальная точка знакомства со зданием",
                           x=170, y=350))
    edge("stairs-f1-f2", "f1-stairs", "f2-stairs", kind="stairs", accessible=False, distanceMeters=6)
    edge("elevator-f1-f2", "f1-elevator", "f2-elevator", kind="elevator", distanceMeters=7)
    return Project(title="Конгресс-центр «Атлас»", revision=1, floors=floors,
                   rooms=rooms, nodes=nodes, edges=edges, places=places, panoramas=[])
