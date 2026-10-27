from io import BytesIO
import sqlite3
import hashlib
import time

from fastapi.testclient import TestClient
from PIL import Image

from backend.app.main import create_app
from backend.app.storage import Storage


def account(tmp_path, email="owner@example.com", password="long-enough-password"):
    client = TestClient(create_app(tmp_path / "accounts.db", "demo-admin-password"))
    response = client.post("/api/auth/register", json={"name": "Owner", "email": email, "password": password})
    assert response.status_code == 201
    return client


def test_registration_private_space_publish_and_unique_views(tmp_path):
    owner = account(tmp_path)
    assert owner.get("/api/auth/session").json()["user"]["email"] == "owner@example.com"
    created = owner.post("/api/spaces", json={"title": "Моя мастерская"})
    assert created.status_code == 201
    project = created.json()
    slug = project["slug"]
    assert owner.get(f"/api/spaces/{slug}?view=draft").json()["title"] == "Моя мастерская"

    stranger = TestClient(owner.app)
    assert stranger.get(f"/api/spaces/{slug}").status_code == 404
    assert stranger.put(f"/api/spaces/{slug}", json=project).status_code == 401
    assert stranger.post(f"/api/spaces/{slug}/publish", json={"revision": 1}).status_code == 401

    project["rooms"].append({"id": "room-one", "floorId": "floor-1", "name": "Лаборатория",
                             "kind": "room", "x": 10, "y": 20, "width": 180, "height": 120})
    saved = owner.put(f"/api/spaces/{slug}", json=project)
    assert saved.status_code == 200 and saved.json()["revision"] == 2
    assert owner.put(f"/api/spaces/{slug}", json=project).status_code == 409
    assert owner.post(f"/api/spaces/{slug}/publish", json={"revision": 1}).status_code == 409
    assert owner.post(f"/api/spaces/{slug}/publish", json={"revision": 2}).status_code == 200
    assert stranger.get(f"/api/spaces/{slug}").json()["rooms"][0]["name"] == "Лаборатория"

    visit = {"visitorId": "a" * 32}
    assert stranger.post(f"/api/spaces/{slug}/view", json=visit).status_code == 204
    assert stranger.post(f"/api/spaces/{slug}/view", json=visit).status_code == 204
    summary = owner.get("/api/account").json()["spaces"][0]
    assert summary["views"] == 1
    assert summary["organizationId"] == owner.get("/api/account").json()["organizations"][0]["id"]


def test_accounts_are_isolated_and_duplicate_email_is_rejected(tmp_path):
    owner = account(tmp_path)
    project = owner.post("/api/spaces", json={"title": "Private"}).json()
    duplicate = owner.post("/api/auth/register", json={
        "name": "Second", "email": "OWNER@example.com", "password": "long-enough-password"
    })
    assert duplicate.status_code == 409

    second = TestClient(owner.app)
    response = second.post("/api/auth/register", json={
        "name": "Other", "email": "other@example.com", "password": "different-long-password"
    })
    assert response.status_code == 201
    assert second.get(f"/api/spaces/{project['slug']}").status_code == 404
    assert second.put(f"/api/spaces/{project['slug']}", json=project).status_code == 404
    assert second.get("/api/account").json()["spaces"] == []


def test_signup_requires_long_password_and_mutations_require_same_origin(tmp_path):
    client = TestClient(create_app(tmp_path / "accounts.db", "demo-admin-password"))
    assert client.post("/api/auth/register", json={
        "name": "Owner", "email": "owner@example.com", "password": "short"
    }).status_code == 422
    blocked = client.post("/api/auth/register", json={
        "name": "Owner", "email": "owner@example.com", "password": "long-enough-password"
    }, headers={"origin": "https://attacker.example"})
    assert blocked.status_code == 403


def test_space_media_is_private_owner_scoped_and_public_after_publish(tmp_path):
    owner = account(tmp_path)
    stranger = account(tmp_path, "stranger@example.com", "another-long-password")
    project = owner.post("/api/spaces", json={"title": "Media boundary"}).json()
    buffer = BytesIO()
    Image.new("RGB", (96, 64), "white").save(buffer, format="PNG")
    image = buffer.getvalue()
    response = owner.post(f"/api/plan-import?space={project['slug']}", files={"file": ("plan.png", image, "image/png")})
    assert response.status_code == 201
    asset_id = response.json()["assetId"]
    assert owner.get(f"/api/assets/{asset_id}").status_code == 200
    assert stranger.get(f"/api/assets/{asset_id}").status_code == 404
    organizer = TestClient(owner.app)
    assert organizer.post("/api/session", json={"password": "demo-admin-password"}).status_code == 200
    assert organizer.get(f"/api/assets/{asset_id}").status_code == 404
    assert stranger.post(f"/api/plan-import?space={project['slug']}", files={"file": ("plan.png", image, "image/png")}).status_code == 401

    project["floors"][0]["backgroundAssetId"] = asset_id
    saved = owner.put(f"/api/spaces/{project['slug']}", json=project)
    assert saved.status_code == 200
    assert saved.json()["revision"] == 2
    assert owner.post(f"/api/spaces/{project['slug']}/publish", json={"revision": 2}).status_code == 200
    assert TestClient(owner.app).get(f"/api/assets/{asset_id}").status_code == 200

    sphere = BytesIO()
    Image.new("RGB", (128, 64), "#526b72").save(sphere, format="PNG")
    panorama_response = owner.post(
        f"/api/panorama-import?space={project['slug']}",
        data={"haov": "360", "vaov": "180", "vOffset": "0"},
        files={"file": ("panorama.png", sphere.getvalue(), "image/png")},
    )
    assert panorama_response.status_code == 201
    panorama_asset = panorama_response.json()
    assert stranger.get(f"/api/assets/{panorama_asset['assetId']}").status_code == 404
    project = owner.get(f"/api/spaces/{project['slug']}?view=draft").json()
    project["nodes"].append({"id": "panorama-node", "floorId": "floor-1", "x": 200, "y": 200, "label": "Панорама", "kind": "walk"})
    project["panoramas"].append({
        **{key: value for key, value in panorama_asset.items() if key != "warnings"}, "id": "panorama-one", "name": "Вход", "floorId": "floor-1",
        "nodeId": "panorama-node", "x": 200, "y": 200, "yawOffset": 0, "hotspots": [],
    })
    saved_panorama = owner.put(f"/api/spaces/{project['slug']}", json=project)
    assert saved_panorama.status_code == 200, saved_panorama.text
    assert owner.post(f"/api/spaces/{project['slug']}/publish", json={"revision": saved_panorama.json()["revision"]}).status_code == 200
    assert stranger.get(f"/api/assets/{panorama_asset['assetId']}").status_code == 200
    assert stranger.get(f"/api/assets/{panorama_asset['thumbnailId']}").status_code == 200

    unrelated = stranger.post("/api/spaces", json={"title": "Other tenant"}).json()
    unrelated["floors"][0]["backgroundAssetId"] = asset_id
    rejected = stranger.put(f"/api/spaces/{unrelated['slug']}", json=unrelated)
    assert rejected.status_code == 422
    assert "не принадлежит" in rejected.json()["detail"]


def test_legacy_demo_endpoint_rejects_non_demo_documents(tmp_path):
    client = account(tmp_path)
    project = client.post("/api/spaces", json={"title": "Do not overwrite demo"}).json()
    client.post("/api/session", json={"password": "demo-admin-password"})
    response = client.put("/api/projects/demo", json=project)
    assert response.status_code == 422
    assert client.get("/api/projects/demo?view=published").json()["slug"] == "demo"


def test_account_login_rotates_a_private_session_and_rejects_wrong_password(tmp_path):
    client = account(tmp_path)
    old_token = client.cookies.get("space_account")
    assert client.post("/api/auth/login", json={
        "email": "owner@example.com", "password": "wrong-password"
    }).status_code == 401
    response = client.post("/api/auth/login", json={
        "email": " OWNER@EXAMPLE.COM ", "password": "long-enough-password"
    })
    assert response.status_code == 200
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie and "max-age=43200" in cookie
    assert client.cookies.get("space_account") != old_token
    assert client.get("/api/auth/session").json()["authenticated"]
    client.cookies.set("space_account", old_token)
    assert not client.get("/api/auth/session").json()["authenticated"]


def test_login_throttle_is_persistent_across_app_restart_and_clears_after_success(tmp_path):
    db_path = tmp_path / "rate-limit.db"
    first = TestClient(create_app(db_path, "demo-admin-password"))
    assert first.post("/api/auth/register", json={
        "name": "Owner", "email": "owner@example.com", "password": "long-enough-password"
    }).status_code == 201
    for _ in range(10):
        response = first.post("/api/auth/login", json={"email": "owner@example.com", "password": "wrong-password"})
        assert response.status_code == 401

    restarted = TestClient(create_app(db_path, "demo-admin-password"))
    locked = restarted.post("/api/auth/login", json={"email": "owner@example.com", "password": "long-enough-password"})
    assert locked.status_code == 429
    storage = restarted.app.state.storage
    with storage.connect() as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 8
        row = connection.execute("SELECT bucket_id,attempts FROM auth_attempts").fetchone()
        assert row and row[1] == 10 and row[0] != "testclient"
        connection.execute("UPDATE auth_attempts SET window_started=?", (time.time() - 61,))

    assert restarted.post("/api/auth/login", json={
        "email": "owner@example.com", "password": "long-enough-password"
    }).status_code == 200
    assert restarted.post("/api/auth/login", json={
        "email": "owner@example.com", "password": "wrong-password"
    }).status_code == 401
    with storage.connect() as connection:
        assert connection.execute("SELECT attempts FROM auth_attempts").fetchone()[0] == 1


def test_team_invite_roles_scope_private_maps_and_media(tmp_path):
    owner = account(tmp_path)
    owner_data = owner.get("/api/account").json()
    org = owner_data["organizations"][0]
    project = owner.post("/api/spaces", json={"title": "Team-only map", "organizationId": org["id"]}).json()

    invite = owner.post("/api/organizations/invites", json={
        "organizationId": org["id"], "email": "editor@example.com", "role": "editor"
    })
    assert invite.status_code == 201
    token = invite.json()["token"]
    assert owner.post("/api/organizations/invites/accept", json={"token": token}).status_code == 403

    editor = TestClient(owner.app)
    assert editor.post("/api/auth/register", json={
        "name": "Editor", "email": "editor@example.com", "password": "editor-long-password"
    }).status_code == 201
    assert editor.post("/api/organizations/invites/accept", json={"token": token}).status_code == 200
    assert editor.get(f"/api/spaces/{project['slug']}?view=draft").status_code == 200
    draft = editor.get(f"/api/spaces/{project['slug']}?view=draft").json()
    draft["title"] = "Edited by team member"
    saved = editor.put(f"/api/spaces/{project['slug']}", json=draft)
    assert saved.status_code == 200
    editor_id = editor.get("/api/auth/session").json()["user"]["id"]
    assert owner.patch(f"/api/organizations/{org['id']}/members/{editor_id}", json={"role": "viewer"}).status_code == 200
    downgraded = editor.get(f"/api/spaces/{project['slug']}?view=draft").json()
    assert editor.put(f"/api/spaces/{project['slug']}", json=downgraded).status_code == 404
    assert owner.patch(f"/api/organizations/{org['id']}/members/{editor_id}", json={"role": "editor"}).status_code == 200
    assert editor.get(f"/api/spaces/{project['slug']}?view=draft").status_code == 200
    assert editor.post(f"/api/spaces/{project['slug']}/publish", json={"revision": 2}).status_code == 404
    assert owner.post(f"/api/spaces/{project['slug']}/publish", json={"revision": 2}).status_code == 200

    viewer_invite = owner.post("/api/organizations/invites", json={
        "organizationId": org["id"], "email": "viewer@example.com", "role": "viewer"
    }).json()
    viewer = TestClient(owner.app)
    assert viewer.post("/api/auth/register", json={
        "name": "Viewer", "email": "viewer@example.com", "password": "viewer-long-password"
    }).status_code == 201
    assert viewer.post("/api/organizations/invites/accept", json={"token": viewer_invite["token"]}).status_code == 200
    assert viewer.get(f"/api/spaces/{project['slug']}?view=draft").status_code == 200
    shared = viewer.get("/api/account").json()["spaces"]
    assert next(space for space in shared if space["slug"] == project["slug"])["role"] == "viewer"
    draft = viewer.get(f"/api/spaces/{project['slug']}?view=draft").json()
    assert viewer.put(f"/api/spaces/{project['slug']}", json=draft).status_code == 404
    assert viewer.post("/api/organizations/invites", json={
        "organizationId": org["id"], "email": "blocked@example.com", "role": "viewer"
    }).status_code == 403

    assert owner.delete(f"/api/organizations/{org['id']}/members/{viewer.get('/api/auth/session').json()['user']['id']}").status_code == 204
    assert viewer.get(f"/api/spaces/{project['slug']}?view=draft").status_code == 401
    assert viewer.get(f"/api/spaces/{project['slug']}").status_code == 200  # Published link remains public.


def test_team_owner_can_revoke_pending_invite_and_member_cannot_list_or_revoke(tmp_path):
    owner = account(tmp_path)
    org = owner.get("/api/account").json()["organizations"][0]
    owner_invite = owner.post("/api/organizations/invites", json={
        "organizationId": org["id"], "email": "pending@example.com", "role": "viewer"
    }).json()
    listed = owner.get(f"/api/organizations/{org['id']}/invites")
    assert listed.status_code == 200
    listed_invite = listed.json()["invites"][0]
    assert len(listed.json()["invites"]) == 1
    assert listed_invite["id"] == owner_invite["id"]
    assert listed_invite["email"] == "pending@example.com"
    assert listed_invite["role"] == "viewer"
    assert listed_invite["expiresAt"] > listed_invite["createdAt"]
    assert owner_invite["id"] != owner_invite["token"]

    member_invite = owner.post("/api/organizations/invites", json={
        "organizationId": org["id"], "email": "member@example.com", "role": "viewer"
    }).json()
    member = account(tmp_path, "member@example.com", "member-long-password")
    assert member.post("/api/organizations/invites/accept", json={"token": member_invite["token"]}).status_code == 200
    assert member.get(f"/api/organizations/{org['id']}/invites").status_code == 404
    assert member.delete(f"/api/organizations/{org['id']}/invites/{owner_invite['id']}").status_code == 403

    assert owner.delete(f"/api/organizations/{org['id']}/invites/{owner_invite['id']}").status_code == 204
    assert owner.get(f"/api/organizations/{org['id']}/invites").json()["invites"] == []
    assert member.post("/api/organizations/invites/accept", json={"token": owner_invite["token"]}).status_code == 404
    assert owner.delete(f"/api/organizations/{org['id']}/invites/{owner_invite['id']}").status_code == 404


def test_existing_invite_schema_migrates_pending_rows_without_losing_tokens(tmp_path):
    db_path = tmp_path / "legacy-invites.db"
    token_hash = hashlib.sha256(b"legacy-secret-token").hexdigest()
    with sqlite3.connect(db_path) as connection:
        connection.execute("""CREATE TABLE organization_invites (
            token_hash TEXT PRIMARY KEY, organization_id TEXT NOT NULL, email TEXT NOT NULL,
            role TEXT NOT NULL, invited_by TEXT NOT NULL, expires_at REAL NOT NULL, created_at REAL NOT NULL
        )""")
        connection.execute("INSERT INTO organization_invites VALUES (?,?,?,?,?,?,?)",
                           (token_hash, "org-legacy", "pending@example.com", "viewer", "legacy", 4_000_000_000, 1))

    storage = Storage(db_path)
    assert storage.create_user("legacy", "legacy@example.com", "Legacy owner", "unused")
    invites = storage.list_invites("org-legacy", "legacy")
    assert len(invites) == 1
    assert invites[0]["id"] == hashlib.sha256(token_hash.encode("ascii")).hexdigest()[:24]
    storage.revoke_invite("org-legacy", "legacy", invites[0]["id"])
    with storage.connect() as connection:
        assert connection.execute("SELECT COUNT(*) FROM organization_invites").fetchone()[0] == 0
