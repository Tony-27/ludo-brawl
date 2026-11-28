/* Generated from backend/app/realtime/protocol.py by npm run gen:protocol. Do not edit. */

export type ClientMessage =
  RollCommand | MoveCommand | CastCommand | EndTurnCommand | PracticeCommand | PingCommand | ResyncCommand;
export type GameEvent =
  | TurnStarted
  | ManaChanged
  | Rolled
  | TurnPassed
  | Moved
  | Captured
  | AbilityCast
  | KnockedBack
  | Teleported
  | Swapped
  | Fell
  | Slid
  | Portaled
  | Drifted
  | TileChanged
  | Blocked
  | StatusChanged
  | Empowered
  | MapEvent
  | PieceFinished
  | PlayerFinished
  | GameOver;
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "Color".
 */
export type Color = "red" | "green" | "yellow" | "blue";
export type ServerMessage = HelloMessage | SnapshotMessage | EventsMessage | ErrorMessage | PongMessage;

/**
 * Ludo Brawl wire protocol v2. Generated - do not edit.
 */
export interface Protocol {
  client: ClientMessage;
  event: GameEvent;
  guest: GuestSession;
  room: RoomView;
  server: ServerMessage;
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "RollCommand".
 */
export interface RollCommand {
  type: "roll";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "MoveCommand".
 */
export interface MoveCommand {
  lane: number | null;
  piece: number;
  type: "move";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "CastCommand".
 */
export interface CastCommand {
  ability: string;
  target: {
    [k: string]: unknown;
  };
  type: "cast";
}
/**
 * Skip the after-move cast window.
 *
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "EndTurnCommand".
 */
export interface EndTurnCommand {
  type: "endTurn";
}
/**
 * Practice rooms only: force the next roll and/or set your mana.
 *
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "PracticeCommand".
 */
export interface PracticeCommand {
  dice: number | null;
  mana: number | null;
  type: "practice";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "PingCommand".
 */
export interface PingCommand {
  type: "ping";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "ResyncCommand".
 */
export interface ResyncCommand {
  type: "resync";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "TurnStarted".
 */
export interface TurnStarted {
  color: Color;
  turn: number;
  type: "turnStarted";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "ManaChanged".
 */
export interface ManaChanged {
  color: Color;
  delta: number;
  mana: number;
  reason:
    | "turn"
    | "rolledOne"
    | "shrine"
    | "knockedOut"
    | "knockedBack"
    | "cast"
    | "passive"
    | "burned"
    | "practice"
    | "spring";
  type: "manaChanged";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "Rolled".
 */
export interface Rolled {
  color: Color;
  type: "rolled";
  value: number;
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "TurnPassed".
 */
export interface TurnPassed {
  color: Color;
  reason: "noMoves" | "threeSixes";
  type: "turnPassed";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "Moved".
 */
export interface Moved {
  color: Color;
  from: number;
  path: string[];
  piece: number;
  to: number;
  type: "moved";
  via: "roll" | "dash" | "rally";
}
/**
 * A piece was landed on and sent back to its camp.
 *
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "Captured".
 */
export interface Captured {
  at: number;
  byColor: Color;
  byPiece: number;
  color: Color;
  piece: number;
  type: "captured";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "AbilityCast".
 */
export interface AbilityCast {
  ability: string;
  color: Color;
  hero: string;
  piece: number | null;
  targetColor: Color | null;
  targetPiece: number | null;
  tiles: string[];
  type: "abilityCast";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "KnockedBack".
 */
export interface KnockedBack {
  ability: string;
  byColor: Color | null;
  color: Color;
  from: number;
  path: string[];
  piece: number;
  to: number;
  type: "knockedBack";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "Teleported".
 */
export interface Teleported {
  color: Color;
  from: number;
  path: string[];
  piece: number;
  to: number;
  type: "teleported";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "Swapped".
 */
export interface Swapped {
  color: Color;
  otherColor: Color;
  otherPiece: number;
  otherTile: string;
  otherTo: number;
  piece: number;
  tile: string;
  to: number;
  type: "swapped";
}
/**
 * Fell into a pit or crater: back to camp.
 *
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "Fell".
 */
export interface Fell {
  at: number;
  color: Color;
  piece: number;
  tile: string;
  type: "fell";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "Slid".
 */
export interface Slid {
  color: Color;
  from: number;
  path: string[];
  piece: number;
  to: number;
  type: "slid";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "Portaled".
 */
export interface Portaled {
  color: Color;
  from: number;
  path: string[];
  piece: number;
  to: number;
  type: "portaled";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "Drifted".
 */
export interface Drifted {
  color: Color;
  from: number;
  path: string[];
  piece: number;
  to: number;
  type: "drifted";
}
/**
 * A tile gained or lost a temporary effect (or a bridge broke for good).
 *
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "TileChanged".
 */
export interface TileChanged {
  effect: "broken" | "cracked" | "crater" | "fire" | "trap" | "none";
  owner: Color | null;
  tile: string;
  turns: number | null;
  type: "tileChanged";
}
/**
 * An attack or fall hit a piece that was protected.
 *
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "Blocked".
 */
export interface Blocked {
  color: Color;
  piece: number;
  reason: "safeTile" | "shield";
  type: "blocked";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "StatusChanged".
 */
export interface StatusChanged {
  active: boolean;
  color: Color;
  piece: number;
  status: "shield" | "rooted";
  type: "statusChanged";
}
/**
 * A team visited a Forge Anvil: its next spell hits harder.
 *
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "Empowered".
 */
export interface Empowered {
  active: boolean;
  color: Color;
  type: "empowered";
}
/**
 * A timed map event: announced (warning), happening (strike) or a conveyor flip.
 *
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "MapEvent".
 */
export interface MapEvent {
  event: "eruption" | "avalanche" | "thaw" | "freeze" | "conveyor";
  stage: "warning" | "strike" | "flip";
  tiles: string[];
  type: "mapEvent";
  value: number | null;
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "PieceFinished".
 */
export interface PieceFinished {
  color: Color;
  piece: number;
  type: "pieceFinished";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "PlayerFinished".
 */
export interface PlayerFinished {
  color: Color;
  place: number;
  type: "playerFinished";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "GameOver".
 */
export interface GameOver {
  ranking: Color[];
  type: "gameOver";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "GuestSession".
 */
export interface GuestSession {
  id: string;
  name: string;
  token: string;
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "RoomView".
 */
export interface RoomView {
  code: string;
  hostId: string;
  mapId: string;
  match: MatchView | null;
  players: PlayerView[];
  practice: boolean;
  seq: number;
  state: "lobby" | "playing" | "finished";
  version: number;
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "MatchView".
 */
export interface MatchView {
  castTargets: {
    [k: string]: {
      [k: string]: unknown;
    }[];
  };
  castUsed: boolean;
  conveyor: number;
  current: Color;
  lastRoll: number | null;
  legalPieces: number[];
  mapId: string;
  moveOptions: MoveOptionView[];
  phase: "roll" | "move" | "act" | "over";
  ranking: Color[];
  round: number;
  teams: {
    [k: string]: TeamView;
  };
  tiles: {
    [k: string]: TileView;
  };
  turn: number;
  turnOrder: Color[];
  turnTimeLeftMs: number | null;
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "MoveOptionView".
 */
export interface MoveOptionView {
  lane: number | null;
  path: string[];
  piece: number;
  route: RouteView | null;
  tile: string;
  to: number;
}
/**
 * The branch a move enters (route preview at a fork).
 *
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "RouteView".
 */
export interface RouteView {
  length: number;
  name: string;
  region: string;
  shortest: number;
  tag: string;
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "TeamView".
 */
export interface TeamView {
  empowered: boolean;
  finish: number;
  finished: boolean[];
  hero: string;
  mana: number;
  maxMana: number;
  pieces: number[];
  remaining: number[];
  statuses: string[][];
  tiles: (string | null)[];
  ultUsed: boolean;
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "TileView".
 */
export interface TileView {
  effect: "broken" | "cracked" | "crater" | "fire" | "trap" | "warning" | "water";
  owner: Color | null;
  turns: number | null;
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "PlayerView".
 */
export interface PlayerView {
  color: Color;
  connected: boolean;
  hero: string;
  id: string;
  isBot: boolean;
  name: string;
  skin: string;
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "HelloMessage".
 */
export interface HelloMessage {
  protocol: number;
  room: RoomView;
  type: "hello";
  you: string;
}
/**
 * Full state; sent on connect, on resync and for lobby changes.
 *
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "SnapshotMessage".
 */
export interface SnapshotMessage {
  room: RoomView;
  type: "snapshot";
}
/**
 * Ordered game events followed by the resulting state.
 *
 * Clients animate `events` in order, then adopt `room` as the truth.
 *
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "EventsMessage".
 */
export interface EventsMessage {
  events: (
    | TurnStarted
    | ManaChanged
    | Rolled
    | TurnPassed
    | Moved
    | Captured
    | AbilityCast
    | KnockedBack
    | Teleported
    | Swapped
    | Fell
    | Slid
    | Portaled
    | Drifted
    | TileChanged
    | Blocked
    | StatusChanged
    | Empowered
    | MapEvent
    | PieceFinished
    | PlayerFinished
    | GameOver
  )[];
  room: RoomView;
  seq: number;
  type: "events";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "ErrorMessage".
 */
export interface ErrorMessage {
  message: string;
  type: "error";
}
/**
 * This interface was referenced by `Protocol`'s JSON-Schema
 * via the `definition` "PongMessage".
 */
export interface PongMessage {
  type: "pong";
}
