// A game session: the local, server-less analogue of Mistboard's event-sourced
// jieqi room. Canonical truth lives in memory; the board renders the masked
// projection so a human sitting at the same screen still plays under jieqi's
// hidden-identity rules.

import { jieqiStateToDealtFen, jieqiStateToPikafishFen, parseJieqiFen } from './jieqi-fen.js';
import {
  applyJieqiMove,
  createInitialJieqiState,
  createJieqiDeal,
  getJieqiLegalMoves,
  getJieqiPlayerView,
  jieqiHomeSquares,
  jieqiMaskedBoard,
  oppositeJieqiColor,
  type JieqiBoard,
  type JieqiColor,
  type JieqiDeal,
  type JieqiGameEndReason,
  type JieqiGameState,
  type JieqiGameStatus,
  type JieqiMove,
  type JieqiPieceRole,
  type JieqiPlayerView,
} from './variants-jieqi.js';

export type PlyRecord = {
  move: JieqiMove;
  mover: JieqiColor;
  /** The identity revealed by this move, when a face-down piece moved. */
  revealed: JieqiPieceRole | null;
  /** The piece this move captured, with full truth. */
  captured: { owner: JieqiColor; role: JieqiPieceRole; revealedAtCapture: boolean } | null;
  /** True when the opponent is in check after this move. */
  check: boolean;
  /** 1-based full-move number this ply belongs to. */
  moveNumber: number;
};

export type Adjudication = { winner: JieqiColor | null; reason: JieqiGameEndReason };

/** The deal as it stands on the initial position (home-square order). */
export function dealOf(state: JieqiGameState): JieqiDeal {
  const roles = (color: JieqiColor): JieqiPieceRole[] =>
    jieqiHomeSquares(color).map((sq) => state.board[sq]!.role);
  return { red: roles('red'), black: roles('black') };
}

export function isTerminal(status: JieqiGameStatus): boolean {
  return status.type !== 'playing';
}

export class JieqiSession {
  readonly id: string;
  private readonly initial: JieqiGameState;
  private readonly _positions: JieqiGameState[];
  private readonly _plies: PlyRecord[] = [];
  private _adjudication: Adjudication | null = null;

  constructor(
    gameId: string,
    options: { deal?: JieqiDeal; rng?: () => number; startState?: JieqiGameState } = {},
  ) {
    this.id = gameId;
    this.initial =
      options.startState ??
      createInitialJieqiState(gameId, options.deal ?? createJieqiDeal(options.rng ?? Math.random));
    this._positions = [this.initial];
  }

  /** Rebuild a session from a 6-field dealt FEN (the exact deal is pinned). */
  static fromDealtFen(fen: string, gameId = 'imported'): JieqiSession {
    const parsed = parseJieqiFen(fen);
    if (!parsed.ok) throw new Error(parsed.error);
    return JieqiSession.fromState(parsed.state, gameId);
  }

  static fromState(state: JieqiGameState, gameId = state.id): JieqiSession {
    return new JieqiSession(gameId, { startState: state });
  }

  get deal(): JieqiDeal {
    return dealOf(this.initial);
  }

  /** Position before ply 0 is index 0; after the last ply is index plies.length. */
  get positions(): readonly JieqiGameState[] {
    return this._positions;
  }

  get plies(): readonly PlyRecord[] {
    return this._plies;
  }

  get current(): JieqiGameState {
    return this._positions[this._positions.length - 1]!;
  }

  get startFen(): string {
    return jieqiStateToDealtFen(this.initial);
  }

  get startBoard(): JieqiBoard {
    return this.initial.board;
  }

  status(): JieqiGameStatus {
    if (this._adjudication) return { type: 'finished', ...this._adjudication };
    return this.current.status;
  }

  get finished(): boolean {
    return this.status().type !== 'playing';
  }

  get turn(): JieqiColor | null {
    const status = this.status();
    return status.type === 'playing' ? status.turn : null;
  }

  legalMoves(): JieqiMove[] {
    if (this._adjudication) return [];
    return getJieqiLegalMoves(this.current);
  }

  /** The public (masked) board both seats see. */
  maskedBoard() {
    return jieqiMaskedBoard(this.current);
  }

  /** A seat-scoped view: correct captured-pool redaction for the given color. */
  playerView(color: JieqiColor): JieqiPlayerView {
    return getJieqiPlayerView(this.current, color);
  }

  /**
   * The redacted 5-field Pikafish FEN the engine is allowed to observe for
   * `viewer` (a seat gets only what it may know; unset = an all-knowing
   * postgame reader).
   */
  fenFor(viewer?: JieqiColor): string {
    return jieqiStateToPikafishFen(this.current, viewer ? { viewer } : {});
  }

  /** The exact-deal FEN of the current position. */
  currentDealtFen(): string {
    return jieqiStateToDealtFen(this.current);
  }

  /** Play a legal move. Returns the resulting ply record, or null if illegal. */
  play(move: JieqiMove): PlyRecord | null {
    const status = this.status();
    if (status.type !== 'playing') return null;
    const before = this.current;
    const piece = before.board[move.from];
    const target = before.board[move.to];
    const next = applyJieqiMove(before, move);
    if (next === before) return null;

    const opponent = oppositeJieqiColor(status.turn);
    const afterView = getJieqiPlayerView(next, opponent);
    // `getJieqiPlayerView` only reports inCheck while the game is still live,
    // so a checking move that mates needs the finished status read directly.
    const check =
      next.status.type === 'playing'
        ? afterView.inCheck
        : next.status.type === 'finished' && next.status.reason === 'checkmate';
    const ply: PlyRecord = {
      move,
      mover: status.turn,
      revealed: piece?.faceDown ? piece.role : null,
      captured: target
        ? { owner: target.color, role: target.role, revealedAtCapture: !target.faceDown }
        : null,
      check,
      moveNumber: before.moveNumber,
    };
    this._positions.push(next);
    this._plies.push(ply);
    return ply;
  }

  /** Take back the last ply (clears any adjudication). */
  undo(): void {
    if (this._plies.length === 0 && !this._adjudication) return;
    this._adjudication = null;
    if (this._plies.length > 0) {
      this._plies.pop();
      this._positions.pop();
    }
  }

  resign(color: JieqiColor): void {
    if (this.finished) return;
    this._adjudication = { winner: oppositeJieqiColor(color), reason: 'resignation' };
  }

  abort(reason: JieqiGameEndReason = 'abandonment'): void {
    if (this.finished) return;
    this._adjudication = { winner: null, reason };
  }

  /** Replay a recorded game onto this session. Throws on the first illegal ply. */
  replay(moves: readonly JieqiMove[]): void {
    for (const move of moves) {
      if (!this.play(move)) {
        throw new Error(`illegal move in record: ${move.from}${move.to}`);
      }
    }
  }
}
