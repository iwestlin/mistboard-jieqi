// Jieqi piece vocabulary. Glyph shapes come from Mistboard's generated
// `xiangqi-glyph-paths.ts` (Noto Sans CJK SC Bold, OFL 1.1), so the pieces need
// no CJK font on the host. Red and black use the traditional character forms.

import type { JieqiColor, JieqiPieceRole } from '../game/index.js';
import { XIANGQI_GLYPH_PATHS } from './glyph-paths.js';

export const ROLE_GLYPH: Record<JieqiColor, Record<JieqiPieceRole, string>> = {
  red: {
    general: '帥',
    advisor: '仕',
    elephant: '相',
    horse: '傌',
    chariot: '俥',
    cannon: '炮',
    soldier: '兵',
  },
  black: {
    general: '將',
    advisor: '士',
    elephant: '象',
    horse: '馬',
    chariot: '車',
    cannon: '砲',
    soldier: '卒',
  },
};

/** English label, for the move list and for readers who do not read Chinese. */
export const ROLE_NAME: Record<JieqiPieceRole, string> = {
  general: 'General',
  advisor: 'Advisor',
  elephant: 'Elephant',
  horse: 'Horse',
  chariot: 'Chariot',
  cannon: 'Cannon',
  soldier: 'Soldier',
};

export function glyphPath(color: JieqiColor, role: JieqiPieceRole): string | undefined {
  return XIANGQI_GLYPH_PATHS[ROLE_GLYPH[color][role]];
}
