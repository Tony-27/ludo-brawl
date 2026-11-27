# Ludo Brawl 🎲

Online multiplayer Ludo for 2–4 players. Open the site, **create a room** or **join one with a code**, fill empty seats with friends or bots, and play.

- **Backend:** Python 3.11+, FastAPI, WebSockets (`backend/`)
- **Frontend:** Angular 22 + TypeScript, signals, standalone components (`frontend/`)

## Running it locally

You need Python 3.11+ and Node.js 20+.

**1. Backend** (http://localhost:8000)

```bash
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn ludobrawl.api:app --reload --port 8000
```

**2. Frontend** (http://localhost:4200, proxies `/api` and the WebSocket to :8000)

```bash
cd frontend
npm install
npm start
```

Open http://localhost:4200 in two browser windows (or one normal + one private window) to play against yourself, or add bots from the lobby.

### Single-server mode

`npm run build` in `frontend/` puts the app in `frontend/dist/frontend/browser`. If that folder exists, the backend serves it too, so `uvicorn ludobrawl.api:app --port 8000` alone gives you the whole game at http://localhost:8000. Set `LUDO_STATIC_DIR` to serve a build from somewhere else.

### Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `LUDO_BOT_DELAY` | `0.9` | Seconds a bot waits before each action |
| `LUDO_TURN_TIMEOUT` | `30` | Seconds before an idle human's turn is auto-played |
| `LUDO_ROOM_TTL` | `7200` | Seconds of inactivity before a room is deleted |
| `LUDO_CORS_ORIGINS` | `http://localhost:4200` | Comma-separated origins allowed to call the API |
| `LUDO_STATIC_DIR` | `frontend/dist/frontend/browser` | Built frontend to serve |

Tip: `LUDO_BOT_DELAY=0.05 LUDO_TURN_TIMEOUT=0.3` makes a game play itself to the end in about a minute, which is handy for testing the end-of-game screens.

### Tests

```bash
cd backend
pytest
```

## How the game works

| Rule | Detail |
| --- | --- |
| Leaving base | Roll a **6** to bring a piece onto your start square. |
| Movement | Clockwise around the 52-square track, then up your own 5-square home column. You need the exact roll to reach the centre. |
| Knockouts | Landing on an opponent sends their piece back to base. Start squares and ★ squares are **safe**. |
| Extra rolls | Rolling a 6, knocking someone out, or getting a piece home gives another roll. **Three 6s in a row** forfeits the turn. |
| Winning | First to get all four pieces home wins. Play continues for the remaining places until one player is left. |
| No choice? | If every legal move is equivalent (e.g. only one piece can move), it is played automatically. |
| AFK | If a human doesn't act within 30 s, the bot plays that action for them. |
| Leaving mid-game | A bot takes over the seat so the game can continue. If the host leaves, the next human becomes host. |

## Architecture

```
backend/ludobrawl/
  game.py    Pure rules engine (no I/O, dice values are passed in) — easy to test
  bots.py    Greedy move picker used by bots and for AFK players
  rooms.py   Rooms, players, lobby actions, turn timer, idle-room cleanup
  api.py     FastAPI: REST endpoints for actions, WebSocket for live updates

frontend/src/app/
  core/      API client, RoomStore (session + WebSocket + actions), toasts, models
  pages/     Home (create / join), Lobby, Room (switches lobby ↔ game)
  game/      Board (SVG + step-by-step move animation), Dice, GameView
```

**Flow:** clients send actions over REST with an `X-Player-Token` header (issued when you create/join a room and kept in `localStorage`, so refreshing the page puts you back in your seat). Every state change is pushed to everyone in the room over `GET /api/rooms/{code}/ws` as a full snapshot. A background task ticks every 200 ms to let bots act and auto-play idle humans.

### API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/rooms` | `{name}` → `{room, playerId, token}` |
| `POST` | `/api/rooms/{code}/join` | `{name}` → `{room, playerId, token}` |
| `GET` | `/api/rooms/{code}` | Public room snapshot |
| `POST` | `/api/rooms/{code}/bots` | Host, lobby only |
| `DELETE` | `/api/rooms/{code}/players/{id}` | Host kicks a player/bot, lobby only |
| `POST` | `/api/rooms/{code}/color` | `{color}` — pick a free seat |
| `POST` | `/api/rooms/{code}/start` | Host, needs ≥ 2 players |
| `POST` | `/api/rooms/{code}/roll` | Your turn |
| `POST` | `/api/rooms/{code}/move` | `{piece: 0-3}` |
| `POST` | `/api/rooms/{code}/rematch` | Host, after a game ends |
| `POST` | `/api/rooms/{code}/leave` | |
| `WS` | `/api/rooms/{code}/ws?token=…` | Live snapshots |

Errors come back as `{"error": "human readable message"}` with a 4xx status.

### Limitations

Rooms live in memory, so restarting the server ends all games, and it runs as a single process. Moving the room state to Redis would be the next step for multi-instance hosting.
