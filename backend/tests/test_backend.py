from __future__ import annotations

import math
import time
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.app import main
from backend.app.main import COOKIE_NAME, create_app
from backend.app.models import Edge, Floor, Node, Project, RouteRequest
from backend.app.routing import NoRouteError, UnknownNodeError, shortest_route
from backend.app.seed import demo_project
from backend.app.storage import RevisionConflict, Storage


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path / "space.db", "test-password")) as client:
        yield client


def login(client):
    response = client.post("/api/session", json={"password": "test-password"})
    assert response.status_code == 200
    return response


def graph(edges: list[dict], nodes: list[dict] | None = None) -> Project:
    return Project(title="test", revision=1,
                   floors=[Floor(id="f1", name="1 этаж", level=1, width=1000, height=700, metersPerUnit=1)],
                   nodes=[Node(**node) for node in nodes] if nodes is not None else [
                       Node(id=name, floorId="f1", x=10 + i * 10, y=50)
                       for i, name in enumerate("ABCD")],
                   edges=[Edge(**{"id": str(index), **edge}) for index, edge in enumerate(edges)])


def route(project, start="A", end="D", profile="shortest"):
    return shortest_route(project, RouteRequest(startId=start, endId=end, profile=profile))


def test_public_project_and_health(client):
    response = client.get("/api/projects/demo")
    assert response.status_code == 200
    project = response.json()
    assert len(project["floors"]) == 2
    assert project["panoramas"] == []
    assert project["revision"] == 1
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/api/session").json() == {"authenticated": False}


def test_renamed_place_is_used_in_route_instructions(client):
    login(client)
    project = client.get("/api/projects/demo").json()
    target = next(place for place in project["places"] if place["id"] == "orbit")
    target["name"] = "Новая переговорная"
    assert client.put("/api/projects/demo", json=project).status_code == 200
    response = client.post("/api/projects/demo/route", json={
        "startId": "f1-entrance", "endId": "f2-orbit", "profile": "shortest"
    })
    assert response.status_code == 200
    assert response.json()["steps"][-1] == "Вы на месте: Новая переговорная."


def test_built_frontend_deep_links_and_assets(tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    assets = dist / "assets"
    assets.mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Space Map</title>", encoding="utf-8")
    (assets / "app.js").write_text("console.log('ready');", encoding="utf-8")
    monkeypatch.setattr(main, "ROOT", tmp_path)
    with TestClient(create_app(tmp_path / "test.db", "test-password")) as client:
        for path in ["/", "/map/demo", "/editor/demo"]:
            response = client.get(path)
            assert response.status_code == 200
            assert "text/html" in response.headers["content-type"]
            assert "Space Map" in response.text
        assert client.get("/assets/app.js").text == "console.log('ready');"
        assert client.get("/api/projects/demo").status_code == 200
        assert client.get("/assets/missing.js").status_code == 404


def test_unauthorized_save(client):
    project = client.get("/api/projects/demo").json()
    assert client.put("/api/projects/demo", json=project).status_code == 401


def test_session_login_flags_rotation_and_logout(client):
    assert client.post("/api/session", json={"password": "wrong"}).status_code == 401
    response = login(client)
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie
    assert "max-age=43200" in cookie
    assert client.get("/api/session").json() == {"authenticated": True}
    old_cookie = client.cookies.get(COOKIE_NAME)
    login(client)
    assert client.cookies.get(COOKIE_NAME) != old_cookie
    assert client.delete("/api/session").json() == {"authenticated": False}
    assert client.get("/api/session").json() == {"authenticated": False}
    client.cookies.set(COOKIE_NAME, old_cookie)
    assert client.get("/api/session").json() == {"authenticated": False}


def test_cookie_tampering_and_expiration(client):
    login(client)
    original = client.cookies.get(COOKIE_NAME)
    client.cookies.clear()
    client.cookies.set(COOKIE_NAME, original[:-1] + ("0" if original[-1] != "0" else "1"))
    assert not client.get("/api/session").json()["authenticated"]
    client.cookies.clear()
    client.cookies.set(COOKIE_NAME, original)
    with client.app.state.storage.connect() as connection:
        connection.execute("UPDATE sessions SET expires_at=?", (time.time() - 1,))
    assert not client.get("/api/session").json()["authenticated"]


def test_persistence_and_revision_across_app_recreation(tmp_path):
    path = tmp_path / "persistent.db"
    with TestClient(create_app(path, "test-password")) as first:
        login(first)
        project = first.get("/api/projects/demo").json()
        project["places"][0]["name"] = "Новый главный вход"
        response = first.put("/api/projects/demo", json=project)
        assert response.status_code == 200
        assert response.json()["revision"] == 2
        cookie = first.cookies.get(COOKIE_NAME)
        assert first.put("/api/projects/demo", json=project).status_code == 409
    with TestClient(create_app(path, "test-password")) as second:
        assert second.get("/api/projects/demo").json()["revision"] == 1
        second.cookies.set(COOKIE_NAME, cookie)
        saved = second.get("/api/projects/demo").json()
        assert saved["places"][0]["name"] == "Новый главный вход"
        assert saved["revision"] == 2
        second.cookies.set(COOKIE_NAME, cookie)
        assert second.get("/api/session").json()["authenticated"]


def test_concurrent_writes_have_one_winner(tmp_path):
    storage = Storage(tmp_path / "race.db")
    project = storage.get_project()

    def write():
        try:
            return storage.save_project(project).revision
        except RevisionConflict:
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: write(), range(2)))
    assert results.count(2) == 1 and results.count("conflict") == 1
    assert storage.get_project().revision == 2


def test_generated_password_is_persisted(tmp_path, monkeypatch):
    monkeypatch.delenv("SPACE_ADMIN_PASSWORD", raising=False)
    create_app(tmp_path / "generated.db")
    password_file = tmp_path / "admin-password.txt"
    generated = password_file.read_text(encoding="utf-8")
    assert len(generated) >= 32
    with TestClient(create_app(tmp_path / "generated.db")) as client:
        assert client.post("/api/session", json={"password": generated}).status_code == 200
    assert password_file.read_text(encoding="utf-8") == generated


def test_environment_password_and_unicode(tmp_path, monkeypatch):
    monkeypatch.setenv("SPACE_ADMIN_PASSWORD", "секретный-пароль")
    with TestClient(create_app(tmp_path / "env.db")) as client:
        assert client.post("/api/session", json={"password": "секретный-пароль"}).status_code == 200
    assert not (tmp_path / "admin-password.txt").exists()


def test_https_cookie_and_password_change_revokes_existing_sessions(tmp_path):
    path = tmp_path / "secure.db"
    with TestClient(create_app(path, "test-password"), base_url="https://testserver") as first:
        response = login(first)
        assert "secure" in response.headers["set-cookie"].lower()
        cookie = first.cookies.get(COOKIE_NAME)
    with TestClient(create_app(path, "changed-password")) as second:
        second.cookies.set(COOKIE_NAME, cookie)
        assert not second.get("/api/session").json()["authenticated"]


def test_invalid_origin_is_rejected_without_server_error(client):
    assert client.post("/api/session", json={"password": "test-password"},
                       headers={"Origin": "http://[broken"}).status_code == 403


@pytest.mark.parametrize("method,path,body", [
    ("POST", "/api/session", {"password": "test-password"}),
    ("DELETE", "/api/session", None),
    ("PUT", "/api/projects/demo", "project"),
])
def test_mutating_requests_reject_cross_origin(client, method, path, body):
    login(client)
    if body == "project":
        body = client.get("/api/projects/demo").json()
    response = client.request(method, path, json=body, headers={"Origin": "https://attacker.example"})
    assert response.status_code == 403


def test_same_origin_login_and_cross_site_header(client):
    assert client.post("/api/session", json={"password": "test-password"},
                       headers={"Origin": "http://testserver"}).status_code == 200
    assert client.delete("/api/session", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403


def test_login_rate_limit(client):
    for _ in range(10):
        assert client.post("/api/session", json={"password": "wrong"}).status_code == 401
    assert client.post("/api/session", json={"password": "wrong"}).status_code == 429


@pytest.mark.parametrize("mutation", [
    lambda p: p["edges"][0].update(toId="missing"),
    lambda p: p["nodes"][0].update(floorId="missing"),
    lambda p: p["nodes"][0].update(x=1001),
    lambda p: p["rooms"][0].update(width=1001),
    lambda p: p["places"][0].update(nodeId="missing"),
    lambda p: p["places"][0].update(floorId="f2"),
    lambda p: p["nodes"].append(deepcopy(p["nodes"][0])),
    lambda p: p["edges"][0].update(distanceMeters=0),
    lambda p: p["edges"][0].update(distanceMeters=-1),
    lambda p: p["edges"][0].update(toId=p["edges"][0]["fromId"]),
    lambda p: p["edges"][-1].update(kind="walk"),
    lambda p: p["edges"][-1].update(distanceMeters=None),
    lambda p: p["edges"][-1].update(kind="stairs", accessible=False),
    lambda p: p["edges"][-2].update(accessible=True),
    lambda p: p["floors"][0].update(metersPerUnit=0),
    lambda p: p["floors"][1].update(level=1),
])
def test_invalid_graph_rejected_without_saving(client, mutation):
    login(client)
    project = client.get("/api/projects/demo").json()
    mutation(project)
    assert client.put("/api/projects/demo", json=project).status_code == 422
    assert client.get("/api/projects/demo").json()["revision"] == 1


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_nonfinite_distance_and_coordinates_rejected(value):
    with pytest.raises(ValidationError):
        Edge(id="bad", fromId="A", toId="B", distanceMeters=value)
    with pytest.raises(ValidationError):
        Node(id="bad", floorId="f1", x=value, y=0)


def test_zero_inferred_length_rejected():
    with pytest.raises(ValidationError):
        graph([{"fromId": "A", "toId": "B"}], nodes=[
            {"id": name, "floorId": "f1", "x": 10, "y": 10} for name in "AB"])


def test_dijkstra_weighted_detour_cycles_and_stale_queue_entries():
    project = graph([
        {"fromId": "A", "toId": "D", "distanceMeters": 100},
        {"fromId": "A", "toId": "B", "distanceMeters": 10},
        {"fromId": "A", "toId": "C", "distanceMeters": 2},
        {"fromId": "C", "toId": "B", "distanceMeters": 2},
        {"fromId": "B", "toId": "D", "distanceMeters": 2},
        {"fromId": "C", "toId": "D", "distanceMeters": 20},
    ])
    result = route(project)
    assert [node.id for node in result.nodes] == ["A", "C", "B", "D"]
    assert result.distanceMeters == 6
    assert result.edgeIds == ["2", "3", "4"]


def test_directed_edges_are_not_traversed_backwards():
    project = graph([{"fromId": "A", "toId": "B", "bidirectional": False}])
    assert route(project, "A", "B").distanceMeters == 10
    with pytest.raises(NoRouteError):
        route(project, "B", "A")


def test_same_node_unknown_and_disconnected():
    project = graph([])
    result = route(project, "A", "A")
    assert result.distanceMeters == 0 and result.durationSeconds == 0 and result.edgeIds == []
    assert [node.id for node in result.nodes] == ["A"]
    with pytest.raises(NoRouteError):
        route(project)
    with pytest.raises(UnknownNodeError):
        route(project, "missing", "D")


def test_blocked_edge_and_accessible_filter():
    project = graph([
        {"fromId": "A", "toId": "D", "distanceMeters": 1, "blocked": True},
        {"fromId": "A", "toId": "B", "distanceMeters": 2, "accessible": False},
        {"fromId": "B", "toId": "D", "distanceMeters": 2},
        {"fromId": "A", "toId": "C", "distanceMeters": 10},
        {"fromId": "C", "toId": "D", "distanceMeters": 10},
    ])
    assert route(project).distanceMeters == 4
    assert route(project, profile="accessible").distanceMeters == 20


def test_demo_same_floor_route_follows_corridor_and_doors():
    project = demo_project()
    result = route(project, "f1-reception", "f1-meridian")
    assert [node.id for node in result.nodes][1] == "f1-reception-door"
    assert [node.id for node in result.nodes][-2] == "f1-meridian-door"
    assert all(node.y == 350 for node in result.nodes[2:-2])
    assert result.distanceMeters == pytest.approx((105 + 520 + 105) * 0.08)
    assert len(result.nodes) == len(result.edgeIds) + 1


def test_demo_cross_floor_shortest_stairs_accessible_elevator():
    project = demo_project()
    shortest = route(project, "f1-entrance", "f2-orbit")
    accessible = route(project, "f1-entrance", "f2-orbit", "accessible")
    assert "stairs-f1-f2" in shortest.edgeIds
    assert "elevator-f1-f2" in accessible.edgeIds
    assert "stairs-f1-f2" not in accessible.edgeIds
    assert accessible.distanceMeters > shortest.distanceMeters
    assert any("на лифте" in step for step in accessible.steps)
    downstairs = route(project, "f2-orbit", "f1-entrance", "accessible")
    assert any("Спуститесь" in step for step in downstairs.steps)
    data = project.model_dump()
    next(edge for edge in data["edges"] if edge["id"] == "elevator-f1-f2")["blocked"] = True
    with pytest.raises(NoRouteError):
        route(Project.model_validate(data), "f1-entrance", "f2-orbit", "accessible")


def test_route_api_errors_and_real_recalculation(client):
    args = {"startId": "f1-entrance", "endId": "f2-orbit", "profile": "accessible"}
    response = client.post("/api/projects/demo/route", json=args)
    assert response.status_code == 200
    assert "elevator-f1-f2" in response.json()["edgeIds"]
    assert client.post("/api/projects/demo/route", json={**args, "endId": "unknown"}).status_code == 422
    assert client.post("/api/projects/demo/route", json={**args, "profile": "flying"}).status_code == 422
    login(client)
    project = client.get("/api/projects/demo").json()
    next(edge for edge in project["edges"] if edge["id"] == "elevator-f1-f2")["blocked"] = True
    assert client.put("/api/projects/demo", json=project).status_code == 200
    assert client.post("/api/projects/demo/route", json=args).status_code == 404
