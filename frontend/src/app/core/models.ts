export type Color = 'red' | 'green' | 'yellow' | 'blue';
export type RoomState = 'lobby' | 'playing' | 'finished';
export type Phase = 'roll' | 'move' | 'over';

export interface PlayerView {
  id: string;
  name: string;
  color: Color;
  isBot: boolean;
  connected: boolean;
}

export interface MoveView {
  color: Color;
  piece: number;
  start: number;
  end: number;
  captures: { color: Color; piece: number }[];
}

export interface GameView {
  turnOrder: Color[];
  current: Color;
  phase: Phase;
  lastRoll: number | null;
  rollSeq: number;
  legalPieces: number[];
  pieces: Partial<Record<Color, number[]>>;
  ranking: Color[];
  turnTimeLeftMs: number | null;
  lastMove: MoveView | null;
}

export interface LogEntry {
  id: number;
  text: string;
  color: Color | null;
}

export interface RoomView {
  code: string;
  state: RoomState;
  hostId: string;
  version: number;
  colors: Color[];
  players: PlayerView[];
  game: GameView | null;
  log: LogEntry[];
}

export interface Session {
  code: string;
  playerId: string;
  token: string;
}

export interface SessionResponse extends Session {
  room: RoomView;
}

export const COLOR_LABEL: Record<Color, string> = {
  red: 'Red',
  green: 'Green',
  yellow: 'Yellow',
  blue: 'Blue',
};
