// Replay + analysis screen. Every ply is graded against PikaJieQi's choice, and
// the engine's recommended move for the current position is drawn on the board.
// The game record (棋谱) exports as JSON or a readable TXT score sheet.

import {
  getJieqiPlayerView,
  jieqiMaskedBoard,
  jieqiTruthView,
  type JieqiPlayerBoard,
} from '../game/index.js';
import { buildRecord, download, recordFilename, recordToText } from '../game/record.js';
import {
  analyzeGame,
  analyzePosition,
  buildGameAnalysis,
  type GameAnalysis,
  type MoveReview,
  type PositionAnalysis,
} from '../engine/analysis.js';
import { winPercent } from '../engine/eval.js';
import { crossOriginIsolated, engine } from '../engine/ceval.js';
import { h, button, clear, select } from './dom.js';
import { JieqiBoard, type BoardArrow, type BoardMarker } from './board.js';
import { coordLabel, pvLabels, uciLabel } from './notation.js';
import { navigate, type AppState } from './state.js';

const DEPTHS = [6, 8, 10, 12, 14, 16, 18] as const;

const JUDGMENT_TEXT: Record<'blunder' | 'mistake' | 'inaccuracy', string> = {
  blunder: '??',
  mistake: '?',
  inaccuracy: '?!',
};

export class ReviewView {
  private readonly headerCard = h('div', { class: 'card' });
  private readonly boardHost = h('div', { class: 'board-host' });
  private readonly boardColumn = h('div', { class: 'board-column' });
  private readonly sideColumn = h('aside', { class: 'side-column' });
  private readonly board: JieqiBoard;

  private cursor: number;
  private depth = 12;
  private revealAll = true;
  private analyzing = false;
  private cursorAnalyzing = false;
  private progress = '';
  private message = '';
  /** Positions analyzed so far in the running sweep (live feedback). */
  private live: PositionAnalysis[] = [];
  private abort: AbortController | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly state: AppState,
  ) {
    this.cursor = state.session.plies.length;
    this.board = new JieqiBoard(this.boardHost, { onMove: () => {} });
    this.boardColumn.append(this.headerCard, this.boardHost);
    this.root.replaceChildren(h('div', { class: 'review-layout' }, [this.boardColumn, this.sideColumn]));
    this.root.addEventListener('keydown', this.onKey);
    this.render();
  }

  destroy(): void {
    this.root.removeEventListener('keydown', this.onKey);
    this.abort?.abort();
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  private render(): void {
    this.renderHeader();
    this.renderBoard();
    this.renderSide();
  }

  /** Final analysis if the sweep finished, else the partial sweep. */
  private analysis(): GameAnalysis | null {
    if (this.state.analysis) return this.state.analysis;
    if (this.live.length === 0) return null;
    return buildGameAnalysis(
      this.state.session.positions,
      [...this.live].sort((a, b) => a.index - b.index),
      this.depth,
    );
  }

  private reviewFrom(index: number): MoveReview | undefined {
    return this.analysis()?.moves.find((m) => m.ply === index + 1);
  }

  private renderHeader(): void {
    const session = this.state.session;
    const status = session.status();
    const meta = this.state.meta;
    clear(this.headerCard);

    const resultText =
      status.type === 'playing'
        ? '进行中'
        : status.type === 'aborted'
          ? '中止'
          : status.winner === null
            ? '和棋'
            : `${status.winner === 'red' ? '红方' : '黑方'}胜`;
    const termination = status.type === 'finished' ? reasonLabel(status.reason) : '对局未结束';
    const analysis = this.state.analysis;
    const accuracy = analysis
      ? `准确率 红 ${analysis.accuracy.red.toFixed(1)}% · 黑 ${analysis.accuracy.black.toFixed(1)}%`
      : this.analyzing
        ? this.progress
        : '尚未分析';

    this.headerCard.append(
      h('div', { class: 'review-head' }, [
        h('div', {}, [
          h('h2', { text: `${meta.players.red.name} vs ${meta.players.black.name}` }),
          h('p', { class: 'muted', text: `${resultText} · ${termination} · ${session.plies.length} 手` }),
        ]),
        h('div', { class: 'accuracy', text: accuracy }),
      ]),
    );

    this.headerCard.append(
      h('div', { class: 'row row--buttons' }, [
        button(this.analyzing ? '分析中…' : '分析全局', () => this.runAnalysis(), {
          class: 'btn--primary',
          disabled: this.analyzing || this.cursorAnalyzing || session.plies.length === 0,
        }),
        button('停止', () => this.stopAnalysis(), { disabled: !this.analyzing && !this.cursorAnalyzing }),
        button(
          this.cursorAnalyzing ? '分析中…' : '分析当前局面',
          () => this.analyzeCursor(),
          { disabled: this.analyzing || this.cursorAnalyzing },
        ),
        button('导出棋谱 (JSON)', () => this.exportRecord('json')),
        button('导出记谱 (TXT)', () => this.exportRecord('txt')),
        button('回到对局', () => navigate('#/play')),
      ]),
    );

    this.headerCard.append(
      h('div', { class: 'row' }, [
        h('label', { class: 'field-label', text: '分析深度' }),
        select(
          DEPTHS.map((d) => ({ value: String(d), label: `深度 ${d}` })),
          String(this.depth),
          (value) => {
            this.depth = Number(value);
            this.render();
          },
        ),
        h('label', { class: 'checkbox-row' }, [
          h('input', {
            attrs: { type: 'checkbox', checked: this.revealAll },
            on: {
              change: (event: Event) => {
                this.revealAll = (event.target as HTMLInputElement).checked;
                this.render();
              },
            },
          }),
          h('span', { text: '显示真实棋子（复盘视角）' }),
        ]),
        this.message ? h('span', { class: 'badge badge--warn', text: this.message }) : null,
      ]),
    );
  }

  private renderBoard(): void {
    const positions = this.state.session.positions;
    const index = Math.max(0, Math.min(this.cursor, positions.length - 1));
    const state = positions[index]!;
    const board: JieqiPlayerBoard = this.revealAll
      ? jieqiTruthView(state).board
      : jieqiMaskedBoard(state);

    const analysis = this.analysis();
    const positionAnalysis = analysis?.positions.find((p) => p.index === index) ?? null;
    const arrows: BoardArrow[] = [];
    if (positionAnalysis?.bestMove) {
      arrows.push({
        from: positionAnalysis.bestMove.from,
        to: positionAnalysis.bestMove.to,
        kind: 'best',
      });
    }

    const markers: BoardMarker[] = [];
    const played = this.reviewFrom(index);
    if (played?.judgment) {
      markers.push({ square: played.move.to, text: JUDGMENT_TEXT[played.judgment], tone: 'bad' });
    } else if (played?.playedBest) {
      markers.push({ square: played.move.to, text: '★', tone: 'good' });
    }

    const checkSquare =
      state.status.type === 'playing' && getJieqiPlayerView(state, state.status.turn).inCheck
        ? findGeneral(state.board, state.status.turn)
        : null;

    this.board.render({
      view: { board, legalMoves: [], lastMove: state.lastMove ?? null },
      perspective: this.state.perspective,
      sideToMove: state.status.type === 'playing' ? state.status.turn : null,
      interactive: false,
      arrows,
      markers,
      checkSquare,
    });
  }

  private renderSide(): void {
    clear(this.sideColumn);
    this.sideColumn.append(this.renderEvalBar(), this.renderMoves(), this.renderEnginePanel());
  }

  private renderEvalBar(): HTMLElement {
    const card = h('div', { class: 'card' });
    const analysis = this.analysis();
    if (!analysis) {
      card.append(h('h2', { text: '形势' }), h('p', { class: 'muted', text: '点击「分析全局」查看每步评分。' }));
      return card;
    }
    const graph = analysis.graph;
    const index = Math.max(0, Math.min(this.cursor, graph.length - 1));
    const point = graph[index];
    const redWin = point ? winPercent(point.cp, point.mate) : 50;
    card.append(
      h('h2', { text: '形势' }),
      h('div', { class: 'eval-bar' }, [
        h('div', { class: 'eval-bar__red', attrs: { style: `width:${redWin.toFixed(1)}%` } }),
      ]),
      h('p', { class: 'muted', text: `红方胜率 ${redWin.toFixed(1)}%` }),
      sparkline(graph.map((g) => winPercent(g.cp, g.mate)), index),
    );
    return card;
  }

  private renderMoves(): HTMLElement {
    const card = h('div', { class: 'card card--grow' });
    card.append(h('h2', { text: '着法' }));
    const session = this.state.session;
    const analysis = this.analysis();
    const reviewOf = (ply: number): MoveReview | undefined =>
      analysis?.moves.find((m) => m.ply === ply);

    const list = h('ol', { class: 'move-list' });
    for (let i = 0; i < session.plies.length; i += 2) {
      const cells: Node[] = [h('span', { class: 'move-number', text: `${i / 2 + 1}.` })];
      for (const j of [i, i + 1]) {
        const ply = session.plies[j];
        if (!ply) {
          cells.push(h('span', { class: 'move', text: '' }));
          continue;
        }
        const plyIndex = j + 1;
        const review = reviewOf(plyIndex);
        const mark = review?.judgment
          ? JUDGMENT_TEXT[review.judgment]
          : review?.playedBest
            ? '★'
            : '';
        const cls = [
          'move',
          `move--${ply.mover}`,
          plyIndex === this.cursor ? 'move--current' : '',
          review?.judgment ? `move--${review.judgment}` : review?.playedBest ? 'move--best' : '',
        ]
          .filter(Boolean)
          .join(' ');
        cells.push(
          h('button', {
            class: cls,
            text: `${coordLabel(ply.move)}${mark ? ` ${mark}` : ''}`,
            title: `第 ${plyIndex} 手`,
            attrs: { type: 'button' },
            on: { click: () => this.goTo(plyIndex) },
          }),
        );
      }
      list.append(h('li', {}, cells));
    }
    card.append(h('div', { class: 'scroll scroll--moves' }, [list]));
    return card;
  }

  private renderEnginePanel(): HTMLElement {
    const card = h('div', { class: 'card' });
    card.append(h('h2', { text: 'AI 推荐' }));
    const analysis = this.analysis();
    const index = this.cursor;
    const position = analysis?.positions.find((p) => p.index === index) ?? null;
    if (!position) {
      card.append(h('p', { class: 'muted', text: '该局面还没有分析结果。' }));
      return card;
    }
    const line = position.lines[0];
    card.append(
      h('p', { class: 'engine-line' }, [
        h('strong', { text: position.best ? uciLabel(position.best) : '—' }),
        h('span', { class: 'muted', text: `  深度 ${position.depth}  ${scoreLabel(position)}` }),
      ]),
    );
    const pv = pvLabels(line?.pvUci ?? []);
    if (pv.length) card.append(h('p', { class: 'muted', text: `主变：${pv.slice(0, 8).join(' ')}` }));

    const review = this.reviewFrom(index);
    if (review) {
      card.append(h('hr', { class: 'rule' }));
      card.append(h('p', { class: 'muted', text: `实战：${coordLabel(review.move)}` }));
      const verdict = review.playedBest
        ? '与引擎首选一致 ★'
        : `引擎首选 ${review.bestUci ? uciLabel(review.bestUci) : '—'}`;
      card.append(
        h('p', {
          class: review.judgment ? `verdict verdict--${review.judgment}` : 'verdict',
          text: `${verdict}${review.judgment ? ` · ${judgmentLabel(review.judgment)}` : ''}`,
        }),
      );
      card.append(
        h('p', {
          class: 'muted',
          text: `胜率 ${review.winBefore.toFixed(1)}% → ${review.winAfter.toFixed(1)}%`,
        }),
      );
    } else if (this.cursor >= this.state.session.plies.length) {
      card.append(h('p', { class: 'muted', text: '这是终局局面。' }));
    }
    return card;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  private goTo(index: number): void {
    this.cursor = Math.max(0, Math.min(index, this.state.session.plies.length));
    this.render();
    this.sideColumn.querySelector('.move--current')?.scrollIntoView({ block: 'nearest' });
  }

  private onKey = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowLeft') {
      this.goTo(this.cursor - 1);
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      this.goTo(this.cursor + 1);
      event.preventDefault();
    } else if (event.key === 'Home') {
      this.goTo(0);
    } else if (event.key === 'End') {
      this.goTo(this.state.session.plies.length);
    }
  };

  private runAnalysis(): void {
    if (this.analyzing) return;
    if (!crossOriginIsolated()) {
      this.message = '当前页面不是跨源隔离的，引擎无法加载（需要 COOP/COEP）。';
      this.render();
      return;
    }
    this.analyzing = true;
    this.live = [];
    this.state.analysis = null;
    this.message = '';
    this.progress = '准备中…';
    this.abort = new AbortController();
    this.render();

    void analyzeGame(this.state.session.positions, {
      depth: this.depth,
      multiPv: 2,
      signal: this.abort.signal,
      onProgress: (done, total, latest) => {
        this.live = this.live.filter((a) => a.index !== latest.index).concat(latest);
        this.progress = `分析中… ${done}/${total}`;
        this.render();
      },
    })
      .then((analysis) => {
        this.state.analysis = analysis;
        this.live = [];
        this.analyzing = false;
        this.progress = '';
        this.render();
      })
      .catch((error: unknown) => {
        this.analyzing = false;
        this.message = `分析失败：${error instanceof Error ? error.message : String(error)}`;
        this.render();
      });
  }

  private stopAnalysis(): void {
    this.abort?.abort();
    this.abort = null;
    engine.stop();
    this.analyzing = false;
    this.cursorAnalyzing = false;
    this.progress = '';
    this.render();
  }

  private analyzeCursor(): void {
    const index = this.cursor;
    this.message = '';
    this.cursorAnalyzing = true;
    this.abort = new AbortController();
    this.render();
    void analyzePosition(this.state.session.positions[index]!, index, {
      depth: this.depth,
      multiPv: 2,
      signal: this.abort.signal,
    })
      .then((analysis) => {
        this.cursorAnalyzing = false;
        this.abort = null;
        this.live = this.live.filter((a) => a.index !== index).concat(analysis);
        this.render();
      })
      .catch((error: unknown) => {
        this.cursorAnalyzing = false;
        this.abort = null;
        this.message = `引擎出错：${error instanceof Error ? error.message : String(error)}`;
        this.render();
      });
  }

  private exportRecord(kind: 'json' | 'txt'): void {
    const record = buildRecord(this.state.session, this.state.meta, this.state.analysis ?? undefined);
    if (kind === 'json') {
      download(recordFilename(record), JSON.stringify(record, null, 2));
    } else {
      download(recordFilename(record).replace(/\.json$/, '.txt'), recordToText(record), 'text/plain');
    }
  }
}

function findGeneral(board: JieqiPlayerBoard | Record<string, unknown>, color: string): string | null {
  for (const [square, entry] of Object.entries(board)) {
    const piece = entry as { role?: string; color?: string } | undefined;
    if (piece?.role === 'general' && piece.color === color) return square;
  }
  return null;
}

function sparkline(values: readonly number[], cursor: number): SVGSVGElement {
  const width = 260;
  const height = 48;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'sparkline');
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const y = (v: number): number => height - (Math.max(0, Math.min(100, v)) / 100) * height;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const mid = document.createElementNS(ns, 'line');
  mid.setAttribute('x1', '0');
  mid.setAttribute('x2', String(width));
  mid.setAttribute('y1', String(height / 2));
  mid.setAttribute('y2', String(height / 2));
  mid.setAttribute('class', 'sparkline__mid');
  const poly = document.createElementNS(ns, 'polyline');
  poly.setAttribute('points', points);
  poly.setAttribute('class', 'sparkline__line');
  svg.append(mid, poly);
  if (values.length > 0) {
    const at = Math.min(cursor, values.length - 1);
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', String(at * step));
    dot.setAttribute('cy', String(y(values[at] ?? 50)));
    dot.setAttribute('r', '3.5');
    dot.setAttribute('class', 'sparkline__cursor');
    svg.append(dot);
  }
  return svg;
}

function scoreLabel(position: PositionAnalysis): string {
  const line = position.lines[0];
  if (!line) return '—';
  if (line.mate !== null) return `${line.mate > 0 ? '+' : '-'}M${Math.abs(line.mate)}`;
  if (line.scoreCp === null) return '—';
  const pawns = line.scoreCp / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

function judgmentLabel(judgment: 'blunder' | 'mistake' | 'inaccuracy'): string {
  return judgment === 'blunder' ? '漏着' : judgment === 'mistake' ? '失误' : '不精确';
}

function reasonLabel(reason: string): string {
  const map: Record<string, string> = {
    checkmate: '将死',
    stalemate: '困毙',
    'no-capture-clock': '60 回合无吃子',
    timeout: '超时',
    resignation: '认输',
    abandonment: '离席',
  };
  return map[reason] ?? reason;
}
