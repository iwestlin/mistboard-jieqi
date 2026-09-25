// Whole-game review: run PikaJieQi on every position of a game and grade the
// moves that were played. This is the postgame surface, so the engine is fed
// the UNREDACTED dealt FEN (both reveal pools exact) -- exactly what Mistboard's
// review board does once a game is over.

import {
  jieqiMoveToPikafishUci,
  jieqiStateToPikafishFen,
  pikafishUciToJieqiMove,
  type JieqiColor,
  type JieqiGameState,
  type JieqiMove,
} from '../game/index.js';
import { engine, type EngineLine } from './ceval.js';
import {
  accuracyPercent,
  gameAccuracy,
  moveJudgment,
  winPercent,
  type MoveJudgment,
} from './eval.js';

export type PositionAnalysis = {
  /** Index into the game's positions (0 = start, plies.length = final). */
  index: number;
  fen: string;
  /** Pikafish UCI of the engine's top choice, or null if none. */
  best: string | null;
  bestMove: JieqiMove | null;
  /** Side-to-move POV score, centipawns. Null when `mate` is set. */
  scoreCp: number | null;
  mate: number | null;
  depth: number;
  lines: EngineLine[];
};

export type MoveReview = {
  /** 1-based ply. */
  ply: number;
  move: JieqiMove;
  mover: JieqiColor;
  playedUci: string;
  /** The engine's recommendation from the position before the move. */
  bestMove: JieqiMove | null;
  bestUci: string | null;
  playedBest: boolean;
  /** Mover-POV win% before and after the move. */
  winBefore: number;
  winAfter: number;
  judgment: MoveJudgment;
  accuracy: number;
};

export type GameAnalysis = {
  depth: number;
  /** One entry per position, so plies.length + 1 entries. */
  positions: PositionAnalysis[];
  /** One entry per ply. */
  moves: MoveReview[];
  /** Whole-game accuracy per side. */
  accuracy: { red: number; black: number };
  /** Red-POV centipawn eval per position (clamped for the graph). Null = mate. */
  graph: { cp: number; mate: number | null }[];
};

export type AnalyzeOptions = {
  depth?: number;
  /** Per-position time budget in ms; overrides `depth` when set. */
  movetime?: number;
  multiPv?: number;
  onProgress?: (done: number, total: number, latest: PositionAnalysis) => void;
  signal?: AbortSignal;
};

/** Side-to-move POV score of a position, from the engine's top line. */
export function analysisScore(a: PositionAnalysis): { cp: number | null; mate: number | null } {
  const top = a.lines[0];
  if (!top) return { cp: a.scoreCp, mate: a.mate };
  return { cp: top.scoreCp, mate: top.mate };
}

/** Analyze a single position (used for hints and quick per-move checks). */
export async function analyzePosition(
  state: JieqiGameState,
  index: number,
  opts: AnalyzeOptions = {},
): Promise<PositionAnalysis> {
  const fen = jieqiStateToPikafishFen(state);
  const result = await engine.evaluate({
    fen,
    depth: opts.depth ?? 12,
    ...(opts.movetime && opts.movetime > 0 ? { movetime: opts.movetime } : {}),
    multiPv: opts.multiPv ?? 1,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  return {
    index,
    fen,
    best: result.best,
    bestMove: result.best ? pikafishUciToJieqiMove(result.best) : null,
    scoreCp: result.lines[0]?.scoreCp ?? null,
    mate: result.lines[0]?.mate ?? null,
    depth: result.depth,
    lines: result.lines,
  };
}

/**
 * Analyze every position in order and grade the moves played. The final
 * position is analyzed too: it is what the last move is graded against.
 */
export async function analyzeGame(
  positions: readonly JieqiGameState[],
  opts: AnalyzeOptions = {},
): Promise<GameAnalysis> {
  const depth = opts.depth ?? 12;
  const multiPv = opts.multiPv ?? 2;
  const movetime = opts.movetime;
  const analyses: PositionAnalysis[] = [];

  for (let i = 0; i < positions.length; i += 1) {
    if (opts.signal?.aborted) break;
    const analysis = await analyzePosition(positions[i]!, i, {
      depth,
      ...(movetime ? { movetime } : {}),
      multiPv,
      signal: opts.signal,
    });
    analyses.push(analysis);
    opts.onProgress?.(analyses.length, positions.length, analysis);
  }

  return buildGameAnalysis(positions, analyses, depth);
}

/** Assemble move reviews + accuracy from whatever positions were analyzed. */
export function buildGameAnalysis(
  positions: readonly JieqiGameState[],
  analyses: readonly PositionAnalysis[],
  depth: number,
): GameAnalysis {
  const byIndex = new Map(analyses.map((a) => [a.index, a]));
  const moves: MoveReview[] = [];
  const winPercents: number[] = [];

  for (let i = 0; i < positions.length; i += 1) {
    const a = byIndex.get(i);
    if (!a) continue;
    const { cp, mate } = analysisScore(a);
    const sidePov = winPercent(cp, mate);
    const before = positions[i]!;
    const mover: JieqiColor = before.status.type === 'playing' ? before.status.turn : 'red';
    // winPercents is RED POV: position i has `mover` to move.
    winPercents[i] = mover === 'red' ? sidePov : 100 - sidePov;
  }

  for (let i = 0; i < positions.length - 1; i += 1) {
    const a = byIndex.get(i);
    const b = byIndex.get(i + 1);
    const before = positions[i]!;
    const after = positions[i + 1]!;
    const mover: JieqiColor = before.status.type === 'playing' ? before.status.turn : 'red';
    const afterSide = b ? analysisScore(b) : null;

    const scoreA = a ? analysisScore(a) : null;
    const winBefore = scoreA ? winPercent(scoreA.cp, scoreA.mate) : 50;
    // `after` is from the OPPONENT's POV, so invert it back to the mover's.
    const winAfter = afterSide ? 100 - winPercent(afterSide.cp, afterSide.mate) : winBefore;

    const played = after.lastMove ?? null;
    const playedUci = played ? jieqiMoveToPikafishUci(played) : '';
    const bestUci = a?.best ?? null;

    moves.push({
      ply: i + 1,
      move: played ?? { from: 'a1', to: 'a1' },
      mover,
      playedUci,
      bestUci,
      bestMove: a?.bestMove ?? null,
      playedBest: Boolean(bestUci && playedUci && bestUci === playedUci),
      winBefore,
      winAfter,
      judgment: moveJudgment(winBefore, winAfter),
      accuracy: accuracyPercent(winBefore, winAfter),
    });
  }

  // Fill any gaps so accuracy math sees a complete curve.
  const curve: number[] = [];
  for (let i = 0; i < positions.length; i += 1) curve.push(winPercents[i] ?? 50);
  const accuracy = positions.length > 1 ? gameAccuracy(curve) : { first: 100, second: 100 };

  const graph = positions.map((state, i) => {
    const a = byIndex.get(i);
    const score = a ? analysisScore(a) : { cp: null, mate: null };
    const mover: JieqiColor = state.status.type === 'playing' ? state.status.turn : 'red';
    const redCp = score.cp == null ? null : mover === 'red' ? score.cp : -score.cp;
    const redMate = score.mate == null ? null : mover === 'red' ? score.mate : -score.mate;
    return { cp: redCp == null ? 0 : Math.max(-1000, Math.min(1000, redCp)), mate: redMate };
  });

  return {
    depth,
    positions: [...analyses].sort((x, y) => x.index - y.index),
    moves,
    accuracy: { red: accuracy.first, black: accuracy.second },
    graph,
  };
}
