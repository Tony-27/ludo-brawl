import pytest
from fastapi.testclient import TestClient

from ludobrawl.api import create_app
from ludobrawl.rooms import RoomManager, Settings


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def manager(clock):
    return RoomManager(Settings(bot_delay=1, turn_timeout=30, room_idle_ttl=3600), clock=clock)


@pytest.fixture
def client(manager, tmp_path):
    with TestClient(create_app(manager, run_ticker=False, static_dir=tmp_path / "none")) as c:
        yield c


def hdr(session):
    return {"X-Player-Token": session["token"]}


def create(client, name="Alice"):
    r = client.post("/api/rooms", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def test_create_and_join_room(client):
    host = create(client)
    code = host["room"]["code"]
    assert len(code) == 5 and host["room"]["state"] == "lobby"

    guest = client.post(f"/api/rooms/{code.lower()}/join", json={"name": "Bob"}).json()
    assert [p["name"] for p in guest["room"]["players"]] == ["Alice", "Bob"]
    # Second player gets the opposite corner.
    assert [p["color"] for p in guest["room"]["players"]] == ["red", "yellow"]
    # Tokens never leak into public views.
    assert "token" not in str(client.get(f"/api/rooms/{code}").json())


def test_validation_errors(client):
    assert client.post("/api/rooms", json={"name": "   "}).status_code == 400
    assert client.post("/api/rooms/ZZZZZ/join", json={"name": "Bob"}).status_code == 404
    host = create(client)
    code = host["room"]["code"]
    r = client.post(f"/api/rooms/{code}/join", json={"name": "alice"})
    assert r.status_code == 409 and "name" in r.json()["error"]
    assert client.post(f"/api/rooms/{code}/start", headers=hdr(host)).status_code == 400  # alone
    assert client.post(f"/api/rooms/{code}/start", headers={"X-Player-Token": "nope"}).status_code == 403


def test_only_host_can_start_and_room_caps_at_four(client):
    host = create(client)
    code = host["room"]["code"]
    guest = client.post(f"/api/rooms/{code}/join", json={"name": "Bob"}).json()
    assert client.post(f"/api/rooms/{code}/start", headers=hdr(guest)).status_code == 403
    client.post(f"/api/rooms/{code}/bots", headers=hdr(host))
    client.post(f"/api/rooms/{code}/bots", headers=hdr(host))
    assert client.post(f"/api/rooms/{code}/bots", headers=hdr(host)).status_code == 409
    assert client.post(f"/api/rooms/{code}/join", json={"name": "Eve"}).status_code == 409


def test_color_change(client):
    host = create(client)
    code = host["room"]["code"]
    r = client.post(f"/api/rooms/{code}/color", headers=hdr(host), json={"color": "blue"})
    assert r.json()["players"][0]["color"] == "blue"
    client.post(f"/api/rooms/{code}/join", json={"name": "Bob"})
    room = client.get(f"/api/rooms/{code}").json()
    assert room["players"][1]["color"] == "red"
    r = client.post(f"/api/rooms/{code}/color", headers=hdr(host), json={"color": "red"})
    assert r.status_code == 409


def test_turns_enforced_and_bots_play_on_tick(client, manager, clock):
    host = create(client)
    code = host["room"]["code"]
    client.post(f"/api/rooms/{code}/bots", headers=hdr(host))
    room = client.post(f"/api/rooms/{code}/start", headers=hdr(host)).json()
    assert room["state"] == "playing" and room["game"]["current"] == "red"
    assert room["game"]["turnTimeLeftMs"] == 30000

    r = client.post(f"/api/rooms/{code}/roll", headers=hdr(host)).json()
    assert r["game"]["lastRoll"] in range(1, 7)

    # Drive the game: humans roll/move, bots act when the clock advances.
    for _ in range(5000):
        room = client.get(f"/api/rooms/{code}").json()
        if room["state"] == "finished":
            break
        g = room["game"]
        if g["current"] == "red":
            if g["phase"] == "roll":
                client.post(f"/api/rooms/{code}/roll", headers=hdr(host))
            else:
                client.post(f"/api/rooms/{code}/move", headers=hdr(host), json={"piece": g["legalPieces"][0]})
        else:
            assert client.post(f"/api/rooms/{code}/roll", headers=hdr(host)).status_code == 409
            clock.now += 1
            manager.tick()
    assert room["state"] == "finished" and len(room["game"]["ranking"]) == 2

    lobby = client.post(f"/api/rooms/{code}/rematch", headers=hdr(host)).json()
    assert lobby["state"] == "lobby" and len(lobby["players"]) == 2


def test_idle_human_is_auto_played(client, manager, clock):
    host = create(client)
    code = host["room"]["code"]
    client.post(f"/api/rooms/{code}/join", json={"name": "Bob"})
    client.post(f"/api/rooms/{code}/start", headers=hdr(host))
    v = client.get(f"/api/rooms/{code}").json()["version"]
    clock.now += 29
    manager.tick()
    assert client.get(f"/api/rooms/{code}").json()["version"] == v
    clock.now += 2
    manager.tick()
    assert client.get(f"/api/rooms/{code}").json()["game"]["lastRoll"] is not None


def test_leaving_mid_game_hands_seat_to_bot_and_moves_host(client):
    host = create(client)
    code = host["room"]["code"]
    bob = client.post(f"/api/rooms/{code}/join", json={"name": "Bob"}).json()
    client.post(f"/api/rooms/{code}/start", headers=hdr(host))
    assert client.post(f"/api/rooms/{code}/leave", headers=hdr(host)).status_code == 204
    room = client.get(f"/api/rooms/{code}").json()
    assert room["hostId"] == bob["playerId"]
    assert room["players"][0]["isBot"] and room["players"][0]["name"] == "Alice (bot)"
    # The old token no longer works.
    assert client.post(f"/api/rooms/{code}/roll", headers=hdr(host)).status_code == 403


def test_room_deleted_when_last_human_leaves(client):
    host = create(client)
    code = host["room"]["code"]
    client.post(f"/api/rooms/{code}/leave", headers=hdr(host))
    assert client.get(f"/api/rooms/{code}").status_code == 404


def test_idle_rooms_expire(client, manager, clock):
    code = create(client)["room"]["code"]
    clock.now += 3601
    manager.tick()
    assert client.get(f"/api/rooms/{code}").status_code == 404


def test_websocket_pushes_updates_and_tracks_presence(client):
    host = create(client)
    code = host["room"]["code"]
    with client.websocket_connect(f"/api/rooms/{code}/ws?token={host['token']}") as ws:
        first = ws.receive_json()
        assert first["code"] == code
        presence = ws.receive_json()  # we just came online
        assert presence["players"][0]["connected"] is True
        client.post(f"/api/rooms/{code}/join", json={"name": "Bob"})
        update = ws.receive_json()
        assert [p["name"] for p in update["players"]] == ["Alice", "Bob"]


def test_websocket_rejects_bad_token(client):
    code = create(client)["room"]["code"]
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as e:
        with client.websocket_connect(f"/api/rooms/{code}/ws?token=bad") as ws:
            ws.receive_json()
    assert e.value.code == 4403
