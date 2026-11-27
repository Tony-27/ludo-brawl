import asyncio

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from starlette.websockets import WebSocketDisconnect

from app.db.models import MatchParticipant, MatchResult
from app.main import create_app
from app.rooms.service import RoomService, Timings
from app.settings import Settings


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def service(clock):
    return RoomService(Timings(bot_delay=1, turn_timeout=30, room_idle_ttl=3600), clock=clock)


@pytest.fixture
def app(service, tmp_path):
    settings = Settings(database_url=f"sqlite+aiosqlite:///{tmp_path / 'test.db'}", static_dir=tmp_path / "none")
    return create_app(settings, room_service=service, run_ticker=False)


@pytest.fixture
def client(app):
    with TestClient(app) as c:
        yield c


def guest(client, name="Alice"):
    r = client.post("/api/guests", json={"name": name})
    assert r.status_code == 201, r.text
    g = r.json()
    g["headers"] = {"Authorization": f"Bearer {g['token']}"}
    return g


def test_guest_lifecycle(client):
    g = guest(client)
    assert client.get("/api/me", headers=g["headers"]).json()["name"] == "Alice"
    assert client.patch("/api/me", headers=g["headers"], json={"name": "Alicia"}).json()["name"] == "Alicia"
    assert client.get("/api/me").status_code == 401
    assert client.post("/api/guests", json={"name": "  "}).json()["error"] == "Please enter a name."


def test_catalog(client):
    maps = {m["id"] for m in client.get("/api/maps").json()}
    assert {"classic_arena", "emerald_wilds"} <= maps
    data = client.get("/api/maps/emerald_wilds").json()
    assert data["routes"]["red"] and data["nodes"]
    assert client.get("/api/maps/nope").status_code == 404
    heroes = {h["id"]: h for h in client.get("/api/heroes").json()}
    assert heroes["samurai"]["selectable"] and heroes["samurai"]["abilities"][0]["id"] == "katana_slash"
    assert not heroes["dragon_rider"]["selectable"]


def test_lobby_flow(client):
    host, bob = guest(client), guest(client, "Bob")
    room = client.post("/api/rooms", headers=host["headers"], json={}).json()
    code = room["code"]
    assert room["mapId"] == "emerald_wilds" and room["hostId"] == host["id"]

    room = client.post(f"/api/rooms/{code}/join", headers=bob["headers"]).json()
    assert [p["color"] for p in room["players"]] == ["red", "yellow"]

    r = client.post(
        f"/api/rooms/{code}/loadout", headers=bob["headers"], json={"hero": "grand_wizard", "skin": "wizard_frost"}
    )
    bob_seat = next(p for p in r.json()["players"] if p["id"] == bob["id"])
    assert bob_seat["hero"] == "grand_wizard" and bob_seat["skin"] == "wizard_frost"
    assert (
        client.post(f"/api/rooms/{code}/loadout", headers=bob["headers"], json={"hero": "dragon_rider"}).status_code
        == 400
    )
    assert (
        client.post(f"/api/rooms/{code}/loadout", headers=bob["headers"], json={"skin": "samurai_oni"}).status_code
        == 400
    )

    assert (
        client.post(f"/api/rooms/{code}/map", headers=bob["headers"], json={"mapId": "classic_arena"}).status_code
        == 403
    )
    assert (
        client.post(f"/api/rooms/{code}/map", headers=host["headers"], json={"mapId": "classic_arena"}).json()["mapId"]
        == "classic_arena"
    )

    client.post(f"/api/rooms/{code}/bots", headers=host["headers"], json={"hero": "samurai"})
    client.post(f"/api/rooms/{code}/bots", headers=host["headers"], json={})
    assert client.post(f"/api/rooms/{code}/bots", headers=host["headers"], json={}).status_code == 409

    assert client.post(f"/api/rooms/{code}/start", headers=bob["headers"]).status_code == 403
    room = client.post(f"/api/rooms/{code}/start", headers=host["headers"]).json()
    assert room["state"] == "playing" and room["match"]["current"] == "red"
    assert room["match"]["teams"]["yellow"]["hero"] == "grand_wizard"
    assert "token" not in str(client.get(f"/api/rooms/{code}").json())


def test_websocket_game_events_and_resync(client, service, clock):
    host, bob = guest(client), guest(client, "Bob")
    code = client.post("/api/rooms", headers=host["headers"], json={"mapId": "classic_arena"}).json()["code"]
    client.post(f"/api/rooms/{code}/join", headers=bob["headers"])
    client.post(f"/api/rooms/{code}/start", headers=host["headers"])

    with client.websocket_connect(f"/api/rooms/{code}/ws?token={host['token']}") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["you"] == host["id"] and hello["protocol"] == 1
        ws.receive_json()  # presence snapshot

        ws.send_json({"type": "roll"})
        msg = ws.receive_json()
        assert msg["type"] == "events" and msg["events"][0]["type"] == "rolled"
        seq = msg["seq"]

        ws.send_json({"type": "cast", "ability": "katana_slash", "target": {"piece": 0}})
        err = ws.receive_json()
        assert err["type"] == "error"

        ws.send_json({"type": "nonsense"})
        assert ws.receive_json()["message"] == "Malformed message."

        ws.send_json({"type": "resync"})
        snap = ws.receive_json()
        assert snap["type"] == "snapshot" and snap["room"]["seq"] == seq

    # Bad token: the socket is closed with a 4401 code.
    with client.websocket_connect(f"/api/rooms/{code}/ws?token=bad") as ws:
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 4401


def test_bots_finish_a_match_and_it_is_saved(client, service, clock, app):
    host = guest(client)
    code = client.post("/api/rooms", headers=host["headers"], json={"mapId": "classic_arena"}).json()["code"]
    client.post(f"/api/rooms/{code}/bots", headers=host["headers"], json={"hero": "grand_wizard"})
    client.post(f"/api/rooms/{code}/start", headers=host["headers"])
    room = service.get(code)
    for _ in range(20000):
        if room.state == "finished":
            break
        clock.now += 31  # bots act; the idle host gets auto-played
        client.portal.call(service.tick)  # tick on the app's event loop, as in production
    assert room.state == "finished"

    async def count():
        async with app.state.db.sessions() as s:
            await asyncio.gather(*app.state.background)
            return await s.scalar(select(func.count(MatchResult.id))), await s.scalar(
                select(func.count(MatchParticipant.id))
            )

    matches, participants = client.portal.call(count)
    assert matches == 1 and participants == 2

    lobby = client.post(f"/api/rooms/{code}/rematch", headers=host["headers"]).json()
    assert lobby["state"] == "lobby" and lobby["match"] is None


def test_leaving_mid_game_hands_seat_to_a_bot(client, service):
    host, bob = guest(client), guest(client, "Bob")
    code = client.post("/api/rooms", headers=host["headers"], json={}).json()["code"]
    client.post(f"/api/rooms/{code}/join", headers=bob["headers"])
    client.post(f"/api/rooms/{code}/start", headers=host["headers"])
    assert client.post(f"/api/rooms/{code}/leave", headers=host["headers"]).status_code == 204
    room = client.get(f"/api/rooms/{code}").json()
    assert room["hostId"] == bob["id"]
    assert any(p["isBot"] and p["name"] == "Alice (bot)" for p in room["players"])
    assert client.post(f"/api/rooms/{code}/start", headers=host["headers"]).status_code == 403


def test_idle_rooms_expire(client, service, clock):
    host = guest(client)
    code = client.post("/api/rooms", headers=host["headers"], json={}).json()["code"]
    clock.now += 3601
    service.tick()
    assert client.get(f"/api/rooms/{code}").status_code == 404
