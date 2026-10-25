"""Rectangular room boundaries require a graph vertex at every doorway."""
def crosses_room_wall(start, end, room) -> bool:
    enter, leave = 0.0, 1.0
    for origin, delta, low, high in (
        (start.x, end.x - start.x, room.x, room.x + room.width),
        (start.y, end.y - start.y, room.y, room.y + room.height),
    ):
        if abs(delta) < 1e-9:
            if origin <= low + 1e-7 or origin >= high - 1e-7:
                return False  # No interior intersection, including travel along a wall.
        else:
            a, b = sorted(((low - origin) / delta, (high - origin) / delta))
            enter, leave = max(enter, a), min(leave, b)
    if leave - enter <= 1e-7:
        return False
    return enter > 1e-7 or leave < 1 - 1e-7
