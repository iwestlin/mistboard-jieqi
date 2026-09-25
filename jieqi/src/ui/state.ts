import { JieqiSession, type JieqiColor } from '../game/index.js';
import type { GameRecordMeta } from '../game/record.js';
import type { GameAnalysis } from '../engine/analysis.js';

export type AppState = {
  session: JieqiSession;
  meta: GameRecordMeta;
  analysis: GameAnalysis | null;
  /** Board perspective shared across views. */
  perspective: JieqiColor;
};

export function newGameState(overrides: Partial<GameRecordMeta> = {}): AppState {
  const meta: GameRecordMeta = {
    mode: 'hvai',
    players: {
      red: { name: 'You', kind: 'human' },
      black: { name: 'PikaJieQi', kind: 'engine' },
    },
    gameId: randomId(),
    ...overrides,
  };
  return {
    session: new JieqiSession(meta.gameId),
    meta,
    analysis: null,
    perspective: 'red',
  };
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function navigate(hash: string): void {
  if (window.location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = hash;
}
