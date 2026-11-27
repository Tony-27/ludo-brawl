import { Color } from '../core/models';

/**
 * Board geometry on a 15x15 grid. Must match backend/ludobrawl/game.py:
 * 52 shared squares numbered clockwise from red's start, progress -1 = yard,
 * 0..50 = track, 51..55 = home column, 56 = finished.
 */
export type Cell = readonly [col: number, row: number];

export const YARD = -1;
export const FINISH = 56;

export const START_SQUARE: Record<Color, number> = { red: 0, green: 13, yellow: 26, blue: 39 };

// prettier-ignore
export const TRACK: readonly Cell[] = [
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
  [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0],
  [7, 0],
  [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6],
  [14, 7],
  [14, 8], [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
  [8, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14],
  [7, 14],
  [6, 14], [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  [0, 7],
  [0, 6],
];

export const SAFE_SQUARES = new Set(Object.values(START_SQUARE).flatMap((s) => [s, (s + 8) % 52]));

export const HOME_COLUMN: Record<Color, readonly Cell[]> = {
  red: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  green: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  yellow: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
  blue: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
};

/** Top-left corner of each 6x6 yard. */
export const YARD_ORIGIN: Record<Color, Cell> = { red: [0, 0], green: [9, 0], yellow: [9, 9], blue: [0, 9] };

/** Where finished pieces rest: inside the colour's triangle in the centre. */
const FINISH_SPOT: Record<Color, readonly [number, number]> = {
  red: [6.55, 7.5],
  green: [7.5, 6.55],
  yellow: [8.45, 7.5],
  blue: [7.5, 8.45],
};

const YARD_SLOTS: readonly [number, number][] = [
  [2, 2],
  [4, 2],
  [2, 4],
  [4, 4],
];

/** Centre point (in grid units) of a piece. */
export function piecePoint(color: Color, progress: number, piece: number): [number, number] {
  if (progress === YARD) {
    const [ox, oy] = YARD_ORIGIN[color];
    const [sx, sy] = YARD_SLOTS[piece];
    return [ox + sx, oy + sy];
  }
  if (progress >= FINISH) return [...FINISH_SPOT[color]];
  const cell = progress <= 50 ? TRACK[(START_SQUARE[color] + progress) % 52] : HOME_COLUMN[color][progress - 51];
  return [cell[0] + 0.5, cell[1] + 0.5];
}

export function trackColorAt(index: number): Color | null {
  const entry = Object.entries(START_SQUARE).find(([, s]) => s === index);
  return entry ? (entry[0] as Color) : null;
}
