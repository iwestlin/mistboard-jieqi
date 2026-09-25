// Xiangqi board geometry, extracted verbatim from Mistboard's
// `packages/game/src/variants-xiangqi.ts` (AGPL-3.0-or-later). Only the
// coordinate system and the starting arrangement are kept: the jieqi kernel
// needs those, and none of the standard-xiangqi variant machinery.

export type XiangqiColor = 'red' | 'black';

export type XiangqiPieceRole =
  | 'general'
  | 'advisor'
  | 'elephant'
  | 'horse'
  | 'chariot'
  | 'cannon'
  | 'soldier';

export type XiangqiPiece = {
  color: XiangqiColor;
  role: XiangqiPieceRole;
};

// File 0..8, rank 1..10. Stored as plain numbers; constrain via helpers.
export type XiangqiCoord = { file: number; rank: number };

// Algebraic square names: file a..i left-to-right, rank 1 (red back rank) to
// 10 (black back rank).
export type XiangqiSquare = string;

export type XiangqiBoard = Partial<Record<XiangqiSquare, XiangqiPiece>>;

const FILE_CHARS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] as const;

export function squareOf(file: number, rank: number): XiangqiSquare {
  if (file < 0 || file > 8 || rank < 1 || rank > 10) {
    throw new RangeError(`xiangqi coord out of range: file=${file} rank=${rank}`);
  }
  return `${FILE_CHARS[file]}${rank}` as XiangqiSquare;
}

export function coordOf(square: XiangqiSquare): XiangqiCoord {
  const file = FILE_CHARS.indexOf(square[0] as (typeof FILE_CHARS)[number]);
  const rank = Number(square.slice(1));
  if (file < 0 || !Number.isInteger(rank) || rank < 1 || rank > 10) {
    throw new RangeError(`invalid xiangqi square: ${square}`);
  }
  return { file, rank };
}

export function inBounds(file: number, rank: number): boolean {
  return file >= 0 && file <= 8 && rank >= 1 && rank <= 10;
}

// Palace = 3x3 box at the back of each side.
//   Red palace: files d..f (3..5), ranks 1..3
//   Black palace: files d..f (3..5), ranks 8..10
export function inPalace(color: XiangqiColor, file: number, rank: number): boolean {
  if (file < 3 || file > 5) return false;
  return color === 'red' ? rank <= 3 : rank >= 8;
}

// "Own half" = side of the river belonging to `color`.
//   Red: ranks 1..5
//   Black: ranks 6..10
export function inOwnHalf(color: XiangqiColor, rank: number): boolean {
  return color === 'red' ? rank <= 5 : rank >= 6;
}

export function hasCrossedRiver(color: XiangqiColor, rank: number): boolean {
  return !inOwnHalf(color, rank);
}

export function oppositeColor(color: XiangqiColor): XiangqiColor {
  return color === 'red' ? 'black' : 'red';
}

export function createInitialXiangqiBoard(): XiangqiBoard {
  const board: XiangqiBoard = {};
  const backRank: XiangqiPieceRole[] = [
    'chariot',
    'horse',
    'elephant',
    'advisor',
    'general',
    'advisor',
    'elephant',
    'horse',
    'chariot',
  ];
  for (let f = 0; f < 9; f++) {
    board[squareOf(f, 1)] = { color: 'red', role: backRank[f]! };
    board[squareOf(f, 10)] = { color: 'black', role: backRank[f]! };
  }
  // Cannons
  board[squareOf(1, 3)] = { color: 'red', role: 'cannon' };
  board[squareOf(7, 3)] = { color: 'red', role: 'cannon' };
  board[squareOf(1, 8)] = { color: 'black', role: 'cannon' };
  board[squareOf(7, 8)] = { color: 'black', role: 'cannon' };
  // Soldiers (a, c, e, g, i files)
  for (const f of [0, 2, 4, 6, 8]) {
    board[squareOf(f, 4)] = { color: 'red', role: 'soldier' };
    board[squareOf(f, 7)] = { color: 'black', role: 'soldier' };
  }
  return board;
}
