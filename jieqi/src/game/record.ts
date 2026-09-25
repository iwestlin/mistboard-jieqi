// Game record (棋谱) build / parse / serialize. JSON is the publication format
// because jieqi has no notation standard: a "PGN" of coordinate pairs would be
// JSON wearing a hat (the same call Mistboard's export table makes). The exact
// deal is pinned by the 6-field dealt FEN, so a record replays losslessly.

import {
  jieqiMoveToPikafishUci,
  pikafishUciToJieqiMove,
  type JieqiColor,
  type JieqiGameEndReason,
  type JieqiMove,
  type JieqiPieceRole,
} from './index.js';
import { JieqiSession, type PlyRecord } from './session.js';

export const RECORD_SCHEMA_VERSION = 1;

export type RecordPlayer = { name: string; kind: 'human' | 'engine' };

export type RecordPly = {
  ply: number;
  move: string;
  from: string;
  to: string;
  revealed: JieqiPieceRole | null;
  captured: { owner: JieqiColor; role: JieqiPieceRole; revealedAtCapture: boolean } | null;
  check: boolean;
};

export type RecordPositionAnalysis = {
  ply: number;
  fen: string;
  best: string | null;
  score_cp: number | null;
  mate: number | null;
  depth: number;
  pv: string[];
};

export type RecordMoveReview = {
  ply: number;
  judgment: 'blunder' | 'mistake' | 'inaccuracy' | null;
  played_best: boolean;
  best: string | null;
  win_before: number;
  win_after: number;
  accuracy: number;
};

export type GameRecord = {
  schema_version: number;
  application: string;
  variant: 'jieqi';
  game_id: string;
  created_at: string;
  mode: 'hvh' | 'hvai';
  players: { red: RecordPlayer; black: RecordPlayer };
  result: 'red-wins' | 'black-wins' | 'draw' | '*';
  termination: JieqiGameEndReason | 'playing';
  start_fen: string;
  final_fen: string;
  plies: RecordPly[];
  analysis?: {
    depth: number;
    engine: 'PikaJieQi';
    positions: RecordPositionAnalysis[];
    moves: RecordMoveReview[];
    accuracy: { red: number; black: number };
  };
};

export type GameRecordMeta = {
  mode: 'hvh' | 'hvai';
  players: { red: RecordPlayer; black: RecordPlayer };
  gameId: string;
};

export type RecordAnalysisLike = {
  depth: number;
  positions: {
    index: number;
    fen: string;
    best: string | null;
    scoreCp: number | null;
    mate: number | null;
    depth: number;
    lines: { pvUci: string[] }[];
  }[];
  moves: {
    ply: number;
    judgment: 'blunder' | 'mistake' | 'inaccuracy' | null;
    playedBest: boolean;
    bestUci: string | null;
    winBefore: number;
    winAfter: number;
    accuracy: number;
  }[];
  accuracy: { red: number; black: number };
};

function resultOf(session: JieqiSession): GameRecord['result'] {
  const status = session.status();
  if (status.type === 'playing') return '*';
  if (status.type === 'aborted') return '*';
  if (status.winner === 'red') return 'red-wins';
  if (status.winner === 'black') return 'black-wins';
  return 'draw';
}

function terminationOf(session: JieqiSession): GameRecord['termination'] {
  const status = session.status();
  if (status.type === 'playing') return 'playing';
  if (status.type === 'aborted') return 'abandonment';
  return status.reason;
}

function plyToRecord(ply: PlyRecord, index: number): RecordPly {
  return {
    ply: index,
    move: jieqiMoveToPikafishUci(ply.move),
    from: ply.move.from,
    to: ply.move.to,
    revealed: ply.revealed,
    captured: ply.captured,
    check: ply.check,
  };
}

export function buildRecord(
  session: JieqiSession,
  meta: GameRecordMeta,
  analysis?: RecordAnalysisLike,
): GameRecord {
  const record: GameRecord = {
    schema_version: RECORD_SCHEMA_VERSION,
    application: 'jieqi',
    variant: 'jieqi',
    game_id: meta.gameId,
    created_at: new Date().toISOString(),
    mode: meta.mode,
    players: meta.players,
    result: resultOf(session),
    termination: terminationOf(session),
    start_fen: session.startFen,
    final_fen: session.currentDealtFen(),
    plies: session.plies.map((ply, i) => plyToRecord(ply, i + 1)),
  };
  if (analysis) {
    record.analysis = {
      depth: analysis.depth,
      engine: 'PikaJieQi',
      positions: analysis.positions.map((p) => ({
        ply: p.index,
        fen: p.fen,
        best: p.best,
        score_cp: p.scoreCp,
        mate: p.mate,
        depth: p.depth,
        pv: p.lines[0]?.pvUci ?? [],
      })),
      moves: analysis.moves.map((m) => ({
        ply: m.ply,
        judgment: m.judgment,
        played_best: m.playedBest,
        best: m.bestUci,
        win_before: Math.round(m.winBefore * 10) / 10,
        win_after: Math.round(m.winAfter * 10) / 10,
        accuracy: Math.round(m.accuracy * 10) / 10,
      })),
      accuracy: {
        red: Math.round(analysis.accuracy.red * 10) / 10,
        black: Math.round(analysis.accuracy.black * 10) / 10,
      },
    };
  }
  return record;
}

/** Human-readable move list, the "score sheet" half of the export. */
export function recordToText(record: GameRecord): string {
  const lines: string[] = [];
  lines.push(`[Event "Jieqi"]`);
  lines.push(`[Site "jieqi (standalone)"]`);
  lines.push(`[Date "${record.created_at.slice(0, 10)}"]`);
  lines.push(`[Variant "Jieqi"]`);
  lines.push(`[Mode "${record.mode}"]`);
  lines.push(`[Red "${record.players.red.name}"]`);
  lines.push(`[Black "${record.players.black.name}"]`);
  lines.push(`[Result "${record.result}"]`);
  lines.push(`[Termination "${record.termination}"]`);
  lines.push(`[StartFen "${record.start_fen}"]`);
  if (record.analysis) {
    lines.push(`[AnalysisDepth "${record.analysis.depth}"]`);
    lines.push(
      `[Accuracy "${record.analysis.accuracy.red.toFixed(1)} / ${record.analysis.accuracy.black.toFixed(1)}"]`,
    );
  }
  lines.push('');
  const reviewByPly = new Map((record.analysis?.moves ?? []).map((m) => [m.ply, m]));
  for (let i = 0; i < record.plies.length; i += 2) {
    const white = record.plies[i]!;
    const black = record.plies[i + 1];
    const number = Math.floor(i / 2) + 1;
    const cell = (ply: RecordPly | undefined): string => {
      if (!ply) return '';
      const review = reviewByPly.get(ply.ply);
      const mark = review?.judgment ? ` ${GLYPH[review.judgment]}` : review?.played_best ? ' ★' : '';
      return `${ply.move}${mark}`;
    };
    lines.push(`${number}. ${cell(white)} ${cell(black)}`.trimEnd());
  }
  lines.push('');
  return lines.join('\n');
}

const GLYPH: Record<'blunder' | 'mistake' | 'inaccuracy', string> = {
  blunder: '??',
  mistake: '?',
  inaccuracy: '?!',
};

export type ParsedRecord = {
  record: GameRecord;
  moves: JieqiMove[];
};

/** Parse + validate a record. Throws with a readable message when invalid. */
export function parseRecord(text: string): ParsedRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a JSON game record.');
  }
  const record = raw as Partial<GameRecord>;
  if (record.variant !== 'jieqi') throw new Error('Record is not a jieqi game.');
  if (typeof record.start_fen !== 'string') throw new Error('Record has no start_fen.');
  if (!Array.isArray(record.plies)) throw new Error('Record has no plies array.');
  const moves: JieqiMove[] = record.plies.map((ply) => {
    const move = pikafishUciToJieqiMove(String(ply.move ?? ''));
    if (!move) throw new Error(`Unreadable move "${ply.move}".`);
    return move;
  });
  return { record: record as GameRecord, moves };
}

export function recordFilename(record: GameRecord): string {
  const stamp = record.created_at.replace(/[:.]/g, '-');
  return `jieqi-${record.game_id}-${stamp}.json`;
}

/** Trigger a browser download of `text` as `filename`. */
export function download(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Everything a replay view needs, from a freshly built session. */
export function sessionFromRecord(parsed: ParsedRecord): JieqiSession {
  const session = JieqiSession.fromDealtFen(parsed.record.start_fen, parsed.record.game_id);
  session.replay(parsed.moves);
  return session;
}
