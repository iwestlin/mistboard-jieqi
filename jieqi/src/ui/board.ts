// Self-contained SVG renderer + interaction layer for the 9x10 jieqi board.
//
// Fueled by jieqi's masking rule: `board[Square]` is either `{color, role,
// faceDown:false}` or `{color, faceDown:true}`. There is no fog and no flip
// move: a face-down piece is selected and moved like any piece and reveals when
// it moves. Pieces sit on intersections (xiangqi convention).

import type {
  JieqiColor,
  JieqiMove,
  JieqiPieceRole,
  JieqiPlayerBoard,
  JieqiSquare,
} from '../game/index.js';
import { glyphPath, ROLE_GLYPH } from './pieces.js';

const FILES = 9;
const RANKS = 10;
const CELL = 72;
const MARGIN = 42;
const RIVER = 16;
const PIECE_R = 30;
const VIEW_W = MARGIN * 2 + (FILES - 1) * CELL;
const VIEW_H = MARGIN * 2 + (RANKS - 1) * CELL + RIVER;

const RED = '#b3372b';
const BLACK = '#2b3947';
const PIECE_FACE = '#f4e3c1';

export type BoardArrow = {
  from: JieqiSquare;
  to: JieqiSquare;
  kind?: 'best' | 'pv';
};

export type BoardMarker = {
  square: JieqiSquare;
  text: string;
  tone?: 'good' | 'bad' | 'neutral';
};

export type BoardView = {
  board: JieqiPlayerBoard;
  legalMoves: readonly JieqiMove[];
  lastMove?: JieqiMove | null;
};

export type BoardRender = {
  view: BoardView | null;
  perspective: JieqiColor;
  /** Whose turn it is; null when the game is over. */
  sideToMove: JieqiColor | null;
  /** True when the viewer may move the side to move. */
  interactive: boolean;
  arrows?: readonly BoardArrow[];
  markers?: readonly BoardMarker[];
  checkSquare?: JieqiSquare | null;
};

export type BoardHandlers = {
  onMove: (move: JieqiMove) => void;
  onSelect?: (square: JieqiSquare | null) => void;
};

function fileOf(square: JieqiSquare): number {
  return square.charCodeAt(0) - 97;
}

function rankOf(square: JieqiSquare): number {
  return Number(square.slice(1));
}

function squareAt(file: number, rank: number): JieqiSquare {
  return `${String.fromCharCode(97 + file)}${rank}`;
}

/** Board coordinate -> viewBox point, honouring the perspective. */
function point(file: number, rank: number, perspective: JieqiColor): { x: number; y: number } {
  const f = perspective === 'red' ? file : FILES - 1 - file;
  const r = perspective === 'red' ? rank : RANKS + 1 - rank;
  const row = RANKS - r;
  return {
    x: MARGIN + f * CELL,
    y: MARGIN + row * CELL + (row >= 5 ? RIVER : 0),
  };
}

/** ViewBox point -> nearest intersection, honouring the perspective. */
function nearestSquare(x: number, y: number, perspective: JieqiColor): JieqiSquare | null {
  let bestRow = 0;
  let bestDist = Infinity;
  for (let row = 0; row < RANKS; row += 1) {
    const cy = MARGIN + row * CELL + (row >= 5 ? RIVER : 0);
    const dist = Math.abs(y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      bestRow = row;
    }
  }
  const f = Math.round((x - MARGIN) / CELL);
  if (f < 0 || f > FILES - 1 || bestDist > CELL * 0.62) return null;
  const file = perspective === 'red' ? f : FILES - 1 - f;
  const rank = perspective === 'red' ? RANKS - bestRow : RANKS + 1 - (RANKS - bestRow);
  if (rank < 1 || rank > RANKS) return null;
  return squareAt(file, rank);
}

function gridSvg(perspective: JieqiColor): string {
  const parts: string[] = [];
  const corner = (file: number, rank: number) => point(file, rank, perspective);
  // Horizontal lines: every rank, full width.
  for (let rank = 1; rank <= RANKS; rank += 1) {
    const a = corner(0, rank);
    const b = corner(FILES - 1, rank);
    parts.push(`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" />`);
  }
  // Vertical lines: the outer two run the full height; the inner seven break at
  // the river.
  for (let file = 0; file < FILES; file += 1) {
    const top = corner(file, RANKS);
    const bottom = corner(file, 1);
    if (file === 0 || file === FILES - 1) {
      parts.push(`<line x1="${top.x}" y1="${top.y}" x2="${bottom.x}" y2="${bottom.y}" />`);
      continue;
    }
    const upperEnd = corner(file, 6);
    const lowerStart = corner(file, 5);
    parts.push(`<line x1="${top.x}" y1="${top.y}" x2="${upperEnd.x}" y2="${upperEnd.y}" />`);
    parts.push(
      `<line x1="${lowerStart.x}" y1="${lowerStart.y}" x2="${bottom.x}" y2="${bottom.y}" />`,
    );
  }
  // Palaces.
  for (const color of ['red', 'black'] as const) {
    const rankBack = color === 'red' ? 1 : RANKS;
    const rankFront = color === 'red' ? 3 : RANKS - 2;
    const c1 = corner(3, rankBack);
    const c2 = corner(5, rankFront);
    const c3 = corner(5, rankBack);
    const c4 = corner(3, rankFront);
    parts.push(`<line x1="${c1.x}" y1="${c1.y}" x2="${c2.x}" y2="${c2.y}" />`);
    parts.push(`<line x1="${c3.x}" y1="${c3.y}" x2="${c4.x}" y2="${c4.y}" />`);
  }
  return `<g class="board-grid">${parts.join('')}</g>`;
}

function riverSvg(perspective: JieqiColor): string {
  const rowTop = point(0, 6, perspective);
  const rowBottom = point(0, 5, perspective);
  const cy = (rowTop.y + rowBottom.y) / 2;
  const left = MARGIN + CELL * 0.6;
  const right = VIEW_W - MARGIN - CELL * 0.6;
  return (
    `<g class="board-river" aria-hidden="true">` +
    `<text x="${left}" y="${cy}" text-anchor="start" dominant-baseline="central">楚 河</text>` +
    `<text x="${right}" y="${cy}" text-anchor="end" dominant-baseline="central">漢 界</text>` +
    `</g>`
  );
}

function glyphSvg(color: JieqiColor, role: JieqiPieceRole, cx: number, cy: number): string {
  const d = glyphPath(color, role);
  const scale = (PIECE_R * 2 * 0.92) / 100;
  const fill = color === 'red' ? RED : BLACK;
  if (!d) {
    // Fallback if a glyph path is missing: draw the character as text.
    return `<text class="piece-glyph-text" x="${cx}" y="${cy}" fill="${fill}">${ROLE_GLYPH[color][role]}</text>`;
  }
  return (
    `<g transform="translate(${cx} ${cy}) scale(${scale}) translate(-50 -50)" ` +
    `fill="${fill}"><path d="${d}" /></g>`
  );
}

function pieceSvg(
  color: JieqiColor,
  entry: { role?: JieqiPieceRole; faceDown: boolean },
  cx: number,
  cy: number,
): string {
  const stroke = color === 'red' ? RED : BLACK;
  if (entry.faceDown) {
    return (
      `<g class="piece piece--dark piece--${color}">` +
      `<circle cx="${cx}" cy="${cy}" r="${PIECE_R}" fill="${stroke}" stroke="#00000033" stroke-width="1.5" />` +
      `<circle cx="${cx}" cy="${cy}" r="${PIECE_R - 5}" fill="none" stroke="#ffffff88" stroke-width="2" />` +
      `<circle cx="${cx}" cy="${cy}" r="${PIECE_R - 13}" fill="none" stroke="#ffffff55" stroke-width="1" />` +
      `</g>`
    );
  }
  return (
    `<g class="piece piece--up piece--${color}">` +
    `<circle cx="${cx}" cy="${cy}" r="${PIECE_R}" fill="${PIECE_FACE}" stroke="${stroke}" stroke-width="2.5" />` +
    `<circle cx="${cx}" cy="${cy}" r="${PIECE_R - 4.5}" fill="none" stroke="${stroke}" stroke-width="1" opacity="0.55" />` +
    glyphSvg(color, entry.role!, cx, cy) +
    `</g>`
  );
}

function arrowSvg(a: BoardArrow, perspective: JieqiColor): string {
  const from = point(fileOf(a.from), rankOf(a.from), perspective);
  const to = point(fileOf(a.to), rankOf(a.to), perspective);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const start = { x: from.x + ux * (PIECE_R * 0.9), y: from.y + uy * (PIECE_R * 0.9) };
  const tip = { x: to.x - ux * 6, y: to.y - uy * 6 };
  const base = { x: tip.x - ux * 18, y: tip.y - uy * 18 };
  const perp = { x: -uy, y: ux };
  const head = [
    `${tip.x},${tip.y}`,
    `${base.x + perp.x * 10},${base.y + perp.y * 10}`,
    `${base.x - perp.x * 10},${base.y - perp.y * 10}`,
  ].join(' ');
  return (
    `<g class="board-arrow board-arrow--${a.kind ?? 'pv'}">` +
    `<line x1="${start.x}" y1="${start.y}" x2="${base.x}" y2="${base.y}" />` +
    `<polygon points="${head}" />` +
    `</g>`
  );
}

function markerSvg(marker: BoardMarker, perspective: JieqiColor): string {
  const { x, y } = point(fileOf(marker.square), rankOf(marker.square), perspective);
  const tone = marker.tone ?? 'neutral';
  return (
    `<g class="board-marker board-marker--${tone}">` +
    `<circle cx="${x + PIECE_R - 4}" cy="${y - PIECE_R + 4}" r="12" />` +
    `<text x="${x + PIECE_R - 4}" y="${y - PIECE_R + 4}">${marker.text}</text>` +
    `</g>`
  );
}

export class JieqiBoard {
  private selected: JieqiSquare | null = null;
  private current: BoardRender | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly handlers: BoardHandlers,
  ) {
    this.host.addEventListener('click', this.onClick);
  }

  render(next: BoardRender): void {
    this.current = next;
    if (!next.view) {
      this.host.replaceChildren();
      return;
    }
    this.host.innerHTML = this.svg(next);
  }

  clearSelection(): void {
    this.selected = null;
    if (this.current) this.render(this.current);
  }

  get selection(): JieqiSquare | null {
    return this.selected;
  }

  private legalTargets(): Map<string, JieqiMove> {
    const map = new Map<string, JieqiMove>();
    const view = this.current?.view;
    if (!view) return map;
    for (const move of view.legalMoves) {
      if (!this.selected || move.from !== this.selected) continue;
      map.set(move.to, move);
    }
    return map;
  }

  private svg(state: BoardRender): string {
    const { perspective, view } = state;
    if (!view) return '';
    const targets = this.legalTargets();
    const layers: string[] = [];
    layers.push(`<rect class="board-bed" x="0" y="0" width="${VIEW_W}" height="${VIEW_H}" rx="14" />`);
    layers.push(riverSvg(perspective));
    layers.push(gridSvg(perspective));

    // Origin of the last move sits under the pieces; the piece has already left it.
    const last = view.lastMove;
    if (last) {
      const { x, y } = point(fileOf(last.from), rankOf(last.from), perspective);
      layers.push(`<circle class="board-lastmove-from" cx="${x}" cy="${y}" r="${PIECE_R}" />`);
    }
    if (state.checkSquare) {
      const { x, y } = point(fileOf(state.checkSquare), rankOf(state.checkSquare), perspective);
      layers.push(`<circle class="board-check" cx="${x}" cy="${y}" r="${PIECE_R + 6}" />`);
    }

    // Click targets: every intersection, so an empty destination is clickable.
    const targets2: string[] = [];
    for (let rank = 1; rank <= RANKS; rank += 1) {
      for (let file = 0; file < FILES; file += 1) {
        const square = squareAt(file, rank);
        const { x, y } = point(file, rank, perspective);
        targets2.push(
          `<circle class="board-hit" data-square="${square}" cx="${x}" cy="${y}" r="${CELL * 0.44}" />`,
        );
      }
    }
    layers.push(`<g class="board-hits">${targets2.join('')}</g>`);

    // Legal-move hints.
    for (const [to] of targets) {
      const occupied = Boolean(view.board[to]);
      const { x, y } = point(fileOf(to), rankOf(to), perspective);
      layers.push(
        occupied
          ? `<circle class="board-capture" cx="${x}" cy="${y}" r="${PIECE_R + 2}" />`
          : `<circle class="board-dot" cx="${x}" cy="${y}" r="9" />`,
      );
    }

    // Pieces.
    for (const [square, entry] of Object.entries(view.board)) {
      if (!entry) continue;
      const { x, y } = point(fileOf(square), rankOf(square), perspective);
      const classes =
        `piece-slot` +
        (square === this.selected ? ' piece-slot--selected' : '');
      layers.push(
        `<g class="${classes}" data-square="${square}">${pieceSvg(entry.color, entry, x, y)}</g>`,
      );
    }

    if (this.selected) {
      const { x, y } = point(fileOf(this.selected), rankOf(this.selected), perspective);
      layers.push(`<circle class="board-selection" cx="${x}" cy="${y}" r="${PIECE_R + 5}" />`);
    }

    // Destination ring sits above the moved piece so it frames it clearly.
    if (last) {
      const { x, y } = point(fileOf(last.to), rankOf(last.to), perspective);
      layers.push(`<circle class="board-lastmove-to" cx="${x}" cy="${y}" r="${PIECE_R + 2}" />`);
    }

    for (const arrow of state.arrows ?? []) layers.push(arrowSvg(arrow, perspective));
    for (const marker of state.markers ?? []) layers.push(markerSvg(marker, perspective));

    return (
      `<svg class="jieqi-board-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" ` +
      `preserveAspectRatio="xMidYMid meet" role="img" aria-label="Jieqi board">` +
      layers.join('') +
      `</svg>`
    );
  }

  private squareFromEvent(event: MouseEvent | PointerEvent): JieqiSquare | null {
    const state = this.current;
    if (!state) return null;
    const svg = this.host.querySelector('svg');
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const { x, y } = pt.matrixTransform(ctm.inverse());
    return nearestSquare(x, y, state.perspective);
  }

  private onClick = (event: MouseEvent): void => {
    const state = this.current;
    if (!state) return;
    const square = this.squareFromEvent(event);
    if (!square) {
      this.selected = null;
      this.handlers.onSelect?.(null);
      this.render(state);
      return;
    }
    this.act(square);
  };

  private act(square: JieqiSquare): void {
    const state = this.current;
    if (!state?.view) return;
    const view = state.view;

    if (this.selected) {
      const move = this.legalTargets().get(square);
      if (move) {
        this.selected = null;
        this.handlers.onSelect?.(null);
        this.handlers.onMove(move);
        return;
      }
      if (square === this.selected) {
        this.selected = null;
        this.handlers.onSelect?.(null);
        this.render(state);
        return;
      }
    }

    const entry = view.board[square];
    const own = state.sideToMove && entry && entry.color === state.sideToMove;
    const canSelect =
      state.interactive && own && view.legalMoves.some((move) => move.from === square);
    if (canSelect) {
      this.selected = square;
      this.handlers.onSelect?.(square);
    } else {
      this.selected = null;
      this.handlers.onSelect?.(null);
    }
    this.render(state);
  }
}

export { CELL, MARGIN, PIECE_R, RIVER, VIEW_H, VIEW_W, fileOf, rankOf };
