# Ludo Brawl ⚔️🎲

A fantasy 3D board brawler built on Ludo: pick a hero, roll, race through the wilds, cast spells and smash rivals back to camp. 2–4 players online, bots for empty seats.

**Put it online:** see [docs/DEPLOY.md](docs/DEPLOY.md) (VPS + domain, Caddy HTTPS, Postgres backups, one-command deploys).

- **Server:** Python 3.12+, FastAPI, WebSockets, SQLAlchemy 2 + Alembic, Postgres (SQLite for local dev) — `backend/`
- **Client:** Angular 22 + TypeScript (shell, lobby, HUD) and **Babylon.js** (3D game) — `frontend/`

## Quick start

You need Python 3.12+ and Node.js 22+. Two terminals:

**Server** (http://localhost:8000)

```powershell
cd backend
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

**Client** (http://localhost:4200, proxies `/api` + WebSocket to :8000)

```powershell
cd frontend
npm install
npm start
```

**Everything in one container with Postgres:** `docker compose up --build` → http://localhost:8000 (another port: `$env:PORT=8080; docker compose up --build`)

**Single-server mode:** `npm run build` in `frontend/`; the server then serves the built client at http://localhost:8000.

## Gameplay

| | |
|---|---|
| Heroes | Seven heroes, each with **3 spells**: a cheap *basic*, a *utility* and a once-per-match *ultimate*. **Samurai** (Quick Draw, Katana Slash, Thousand Cuts), **Viking** (Charge, Cleave, Berserker Rage), **Grand Wizard** (Zap, Blink, Meteor), **Knight** (Shield Wall, Shield Bash, Rally), **Ranger** (Piercing Arrow, Snare Trap, Rain of Arrows), **Druid** (Entangling Roots, Wild Growth, Overgrowth), **Dragon Rider** (Dive, Fire Breath, Inferno). Full text in the lobby or `backend/app/game/heroes.py`. |
| Skins | Cosmetic only (heroes carry the abilities). Every hero has a default and a rarer skin. |
| Mana | Max 6. +1 per turn, +1 on rolling a 1, +2 when knocked out, +1 when knocked back, +2 for stopping on a shrine. **One spell per turn**: before rolling, before moving, or in the short window right after moving (then the turn ends; `Enter` ends it early). Line spells (Katana Slash, Cleave, Piercing Arrow, Fire Breath) only light up when an enemy is in their tiles; every greyed-out spell says why. |
| Base rules | 3 heroes per player. Roll a 6 to leave camp. Land on an enemy to send it back to camp. Start, ✦ and home-path tiles are safe from attacks and spells. 6 / knockout / reaching the temple = extra roll; three 6s lose the turn. Exact roll to finish. |
| Tiles | **Pits** (and Meteor craters) send you back to camp; **slides** carry you forward or back; **portals** jump you ahead; **currents** drift you at the start of your turn; **crumbling bridges** collapse after a few crossings and rebuild later; **ice** slides you to solid ground; **thin ice** cracks, then breaks; **hot springs** give mana and cure roots; **Forge Anvils** empower your next spell (+2 knockback); **conveyors** push you 2 tiles, forwards or backwards depending on the round. Any way you land on a tile counts, so a knockback can push someone into a pit. |
| Routes | Big maps split into **three routes of different lengths** every quarter (short and risky, medium, long and safe). When a move enters a fork, route cards show each route's length and features; the routes merge again at a chokepoint. |
| Map events | Fire at the start of a round, announced one round ahead: **eruptions** blast the Lava Bridges every 3 rounds; **avalanches** sweep Frost Glacier's cliff path every 4 rounds; **frozen lakes** thaw (shortcut closed, anyone on it falls in) and freeze again; **conveyors** flip every round. |
| Maps | **Emerald Wilds** (standard), **Molten Forge** (Lava Bridge / Forge Tunnel / Outer Ridge, eruptions), **Frost Glacier** (Snowfield Trail / Frozen Lake / Hot Springs, avalanches) and **Classic Arena**. |
| Flow | Idle humans are auto-played after 30 s (the after-move cast window closes after 12 s); leaving mid-game hands your seat to a bot. |
| Practice | The host can make a room a practice room: choose your next roll and refill mana / reset your ultimate any time. Practice games are not recorded. |

**Controls:** `Space` roll · `Q` `W` `E` spells · `Enter` end turn · `Esc` cancel · `1` `2` `3` camera to hero 1/2/3 (or pick a route card) · `4` your camp · `5` whole map · `Tab` cycle your heroes · `?` help. The camera frames whatever you're choosing between; hero cards (bottom left) select or find each of your heroes.

### Balancing

`python scripts/balance.py --games 200` (in `backend/`) makes bots play many matches and prints win rate and average placement per hero, spell usage per match, match length and route picks per map. Add `--routes --map molten_forge` to pit a bot that prefers each route against normal bots (a fair route wins about 25% in 4-player games). Bots are decent, not perfect, so read it as trends next to your own play-testing.

## Architecture

```
backend/app/
  game/board.py        Board graph loaded from map JSON: routes, regions with branches of any length, events
  game/maps/*.json     Maps — generated by scripts/build_maps.py
  game/rules.py        Authoritative rules engine; pure, seeded, emits domain events
  game/events.py       Event models (moved, captured, abilityCast, knockedBack, ...)
  game/heroes.py       Hero / ability / skin catalogue (data)
  game/spells.py       Generic spell effects (dash, line, radius, strike, blink, meteor, trap, shield, rally, swap)
  game/bots.py         Bot AI (moves + spell casting)
  rooms/service.py     Rooms, seats, hero/skin/map choice, turn timer, bots — behind a RoomStore (Redis-ready)
  realtime/            WebSocket hub + wire protocol (pydantic → JSON Schema → TypeScript)
  api/                 REST: guests, catalog (maps, heroes), rooms
  db/                  Guests + match history (SQLAlchemy), migrations/ (Alembic)

frontend/src/app/
  engine/              Babylon.js game engine — no Angular inside
    game-scene.ts        Entry point: Angular feeds it server messages, it renders & reports clicks
    world/               Terrain, rivers, rock-tile trail, shrines, temple, camps, forests, birds, clouds
    actors/              Animated heroes (glTF, blended clips, skins, team colours), 3D dice
    camera/director.ts   Overview / follow / cinematic camera with free-look hand-back
    presentation/        EventPlayer: turns server events into choreographed beats
    vfx/ post/           Particles, slashes, lightning, impacts, combat text; bloom, AO, DOF, tone mapping
    assets/catalog.ts    Which model/props/tint/animations each skin uses (swap art here)
  core/                API client, guest identity, room store (WebSocket), generated protocol.ts
  pages/ game/         Home, lobby (heroes, skins, map), full-screen game + HUD
  audio/               Procedural music + SFX (Web Audio)
```

**Protocol:** lobby actions over REST; in-game commands (`roll`, `move`, `cast`, `endTurn`) over the room WebSocket. Every piece's tile and every move's path are sent as node ids, so the client never re-implements route rules. The server answers with `events` (ordered, with a sequence number) plus the resulting room state; clients animate the events, then adopt the state. `hello`/`snapshot` messages resync after (re)connecting. After changing `backend/app/realtime/protocol.py` or events, run `python scripts/gen_protocol.py` (backend) then `npm run gen:protocol` (frontend). CI fails if they're out of date.

**Content is data:** new maps are a function in `scripts/build_maps.py`; new heroes/abilities go in `game/heroes.py` (+ an effect handler in `rules.py`), and their look in `engine/assets/catalog.ts`.

### Configuration (env, prefix `LUDO_`)

| Variable | Default | |
|---|---|---|
| `LUDO_DATABASE_URL` | `sqlite+aiosqlite:///./ludobrawl.db` | e.g. `postgresql+asyncpg://ludo:ludo@localhost:5432/ludo` |
| `LUDO_DB_AUTO_CREATE` | `true` | Create tables on start (dev). Use `alembic upgrade head` in production. |
| `LUDO_BOT_DELAY` / `LUDO_TURN_TIMEOUT` / `LUDO_ACT_TIMEOUT` | `1.1` / `30` / `12` | Seconds. `0.05` / `0.3` lets a game play itself for testing. |
| `LUDO_CORS_ORIGINS` | `["http://localhost:4200"]` | |
| `LUDO_STATIC_DIR` | `frontend/dist/frontend/browser` | Built client to serve. |

Client dev flags (browser console): `localStorage['ludo-brawl:debug']='1'` exposes `ludoDebug` (the GameScene; `ludoDebug.scene.debugLayer` for the inspector). Graphics quality is in the in-game settings (⚙).

### Tests

```powershell
cd backend
.venv\Scripts\python.exe -m pytest
.venv\Scripts\python.exe -m ruff check .
```

## Art

Placeholder art is CC0 from [KayKit](https://kaylousberg.com) (Adventurers + Medieval Hexagon packs) — see `frontend/public/assets/CREDITS.md`. Everything is referenced from `engine/assets/catalog.ts`, so custom heroes, skins and environments drop in without engine changes.

## Roadmap

Accounts (upgrade guests in place), new start screen + main menu, room browser → levels, prestige, ranked & leaderboards → currency & cosmetic shop → more maps → mobile quality preset.
