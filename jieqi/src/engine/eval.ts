// Postgame analysis math, ported from Mistboard's
// `packages/game/src/analysis.ts` (AGPL-3.0-or-later): centipawn eval -> win
// probability -> per-move judgment + accuracy, using the lichess/lila formulas.

export type MoveJudgment = 'blunder' | 'mistake' | 'inaccuracy' | null;

const WIN_PCT_CLAMP_CP = 1000;
const WIN_PCT_K = 0.00368208;

/**
 * Centipawns / mate (from one side's POV) -> that side's win probability in
 * [0, 100]. A mate maps through lila's mate->cp ladder rather than jumping to
 * certainty, so swings between mate distances still register.
 */
export function winPercent(cp: number | null, mate: number | null): number {
  if (mate != null) {
    const mateCp = (21 - Math.min(10, Math.abs(mate))) * 100;
    return logisticWinPercent(mate > 0 ? mateCp : -mateCp);
  }
  if (cp == null) return 50;
  return logisticWinPercent(Math.max(-WIN_PCT_CLAMP_CP, Math.min(WIN_PCT_CLAMP_CP, cp)));
}

function logisticWinPercent(cp: number): number {
  const chances = 2 / (1 + Math.exp(-WIN_PCT_K * cp)) - 1;
  return 50 + 50 * chances;
}

/** lila's per-move accuracy; a move that does not drop win% scores 100. */
export function accuracyPercent(winBefore: number, winAfter: number): number {
  if (winAfter >= winBefore) return 100;
  const drop = winBefore - winAfter;
  const raw = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669 + 1;
  return Math.max(0, Math.min(100, raw));
}

/** Judge a move by how many win% points the mover gave up (lila's 5/10/15). */
export function moveJudgment(winBefore: number, winAfter: number): MoveJudgment {
  const drop = winBefore - winAfter;
  if (drop >= 15) return 'blunder';
  if (drop >= 10) return 'mistake';
  if (drop >= 5) return 'inaccuracy';
  return null;
}

/** Signed cp for a `+M3` / `-M2` style score, from the mover's POV. */
export function scoreText(cp: number | null, mate: number | null, pov: 1 | -1 = 1): string {
  if (mate != null) return `${mate * pov > 0 ? '+' : '-'}M${Math.abs(mate)}`;
  if (cp == null) return '–';
  const pawns = (cp * pov) / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

/**
 * lila's whole-game accuracy: each move's accuracy is weighted by local win%
 * volatility so forced sequences count less, and the side's score is the mean
 * of the volatility-weighted mean and the harmonic mean (so one blunder hurts).
 *
 * `winPercents` is the first mover's POV win% of every position 0..N in order
 * (one more entry than there are moves). Returns 0 for a side with no moves.
 */
export function gameAccuracy(winPercents: readonly number[]): { first: number; second: number } {
  const moves = winPercents.length - 1;
  if (moves < 1) return { first: 0, second: 0 };

  const windowSize = Math.max(2, Math.min(8, Math.floor(moves / 10)));
  const windows: number[][] = [];
  const padCount = Math.min(windowSize, winPercents.length) - 2;
  const firstWindow = winPercents.slice(0, windowSize);
  for (let i = 0; i < padCount; i += 1) windows.push(firstWindow);
  if (winPercents.length <= windowSize) {
    windows.push([...winPercents]);
  } else {
    for (let i = 0; i + windowSize <= winPercents.length; i += 1) {
      windows.push(winPercents.slice(i, i + windowSize));
    }
  }
  const weights = windows.map((window) => Math.max(0.5, Math.min(12, stdev(window))));

  const samples: Record<'first' | 'second', { accuracy: number; weight: number }[]> = {
    first: [],
    second: [],
  };
  for (let i = 0; i < moves; i += 1) {
    const mover: 'first' | 'second' = i % 2 === 0 ? 'first' : 'second';
    const weight = weights[i] ?? 1;
    const prev = winPercents[i]!;
    const next = winPercents[i + 1]!;
    const before = mover === 'first' ? prev : 100 - prev;
    const after = mover === 'first' ? next : 100 - next;
    samples[mover].push({ accuracy: accuracyPercent(before, after), weight });
  }

  const side = (key: 'first' | 'second'): number => {
    const list = samples[key];
    if (list.length === 0) return 100;
    const weightSum = list.reduce((sum, s) => sum + s.weight, 0);
    const weighted =
      weightSum > 0
        ? list.reduce((sum, s) => sum + s.accuracy * s.weight, 0) / weightSum
        : list.reduce((sum, s) => sum + s.accuracy, 0) / list.length;
    const invSum = list.reduce((sum, s) => sum + 1 / s.accuracy, 0);
    const harmonic = list.length / invSum;
    return (weighted + harmonic) / 2;
  };

  return { first: side('first'), second: side('second') };
}

function stdev(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
