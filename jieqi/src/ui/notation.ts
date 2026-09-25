// Move labels for the move list, engine panel, and exports. Storage uses
// Pikafish UCI (0-indexed ranks, as the engine speaks); display uses platform
// algebraic squares (rank 1..10) and the piece's character.

import {
  pikafishUciToJieqiMove,
  type JieqiColor,
  type JieqiMove,
  type JieqiPieceRole,
  type PlyRecord,
} from '../game/index.js';
import { ROLE_GLYPH, ROLE_NAME } from './pieces.js';

export function coordLabel(move: JieqiMove): string {
  return `${move.from}-${move.to}`;
}

/** Pikafish UCI -> display label, e.g. "e7e6" -> "e8-e7". */
export function uciLabel(uci: string): string {
  const move = pikafishUciToJieqiMove(uci);
  return move ? coordLabel(move) : uci;
}

/** Pikafish PV -> display labels. The PV's later moves are not legal-checked. */
export function pvLabels(pv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < pv.length; i += 2) {
    out.push(uciLabel(`${pv[i]}${pv[i + 1]}`));
  }
  return out;
}

export function roleGlyph(color: JieqiColor, role: JieqiPieceRole): string {
  return ROLE_GLYPH[color][role];
}

export function roleLabel(role: JieqiPieceRole): string {
  return ROLE_NAME[role];
}

/** "俥 h3-e3", with 揭/吃 annotations for a reveal or capture. */
export function plyLabel(ply: PlyRecord): string {
  const glyph = roleGlyph(ply.mover, ply.captured?.role ?? ply.revealed ?? 'soldier');
  const tags: string[] = [];
  if (ply.revealed) tags.push(`揭 ${ROLE_NAME[ply.revealed]}`);
  if (ply.captured) tags.push(`吃 ${ROLE_NAME[ply.captured.role]}`);
  if (ply.check) tags.push('将军');
  const suffix = tags.length ? `  (${tags.join(' · ')})` : '';
  return `${glyph} ${coordLabel(ply.move)}${suffix}`;
}
