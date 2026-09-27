// Replay + analysis screen. Every ply is graded against PikaJieQi's choice, and
// the engine's recommended move for the current position is drawn on the board.
// The game record (棋谱) exports as JSON or a readable TXT score sheet.

import {
  getJieqiPlayerView,
  jieqiMaskedBoard,
  jieqiTruthView,
  oppositeJieqiColor,
  type JieqiPlayerBoard,
} from '../game/index.js';
// 棋谱导出暂时下线，恢复「导出」按钮时一并启用：
// import { buildRecord, download, recordFilename, recordToText } from '../game/record.js';
import {
  AnalysisCache,
  analyzePosition,
  buildGameAnalysis,
  type GameAnalysis,
  type MoveReview,
  type PositionAnalysis,
} from '../engine/analysis.js';
import { winPercent } from '../engine/eval.js';
import { engine } from '../engine/ceval.js';
import { h, button, clear, select } from './dom.js';
import { JieqiBoard, type BoardArrow, type BoardMarker } from './board.js';
import { captureRow } from './captures.js';
import { coordLabel, pvLabels, uciLabel } from './notation.js';
import type { AppState } from './state.js';

const DEPTHS = [6, 8, 10, 12, 14, 16, 18] as const;

const JUDGMENT_TEXT: Record<'blunder' | 'mistake' | 'inaccuracy', string> = {
  blunder: '??',
  mistake: '?',
  inaccuracy: '?!',
};

export class ReviewView {
  private readonly headerCard = h('div', { class: 'card' });
  private readonly boardHost = h('div', { class: 'board-host' });
  private readonly capturesTop = h('div', { class: 'captures captures--top' });
  private readonly capturesBottom = h('div', { class: 'captures captures--bottom' });
  private readonly boardColumn = h('div', { class: 'board-column' });
  private readonly sideColumn = h('aside', { class: 'side-column' });
  private readonly board: JieqiBoard;

  private cursor: number;
  private depth = 12;
  private revealAll = false;
  private autoAnalyze = true;
  private analyzing = false;
  private cursorAnalyzing = false;
  /** Invalidates an in-flight single-position search when a newer one starts. */
  private cursorToken = 0;
  private progress = '';
  private message = '';
  /** Reuses per-position results; stepping revisits positions constantly. */
  private readonly cache = new AnalysisCache();
  /** Positions analyzed so far in the running sweep (live feedback). */
  private live: PositionAnalysis[] = [];
  private abort: AbortController | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly state: AppState,
  ) {
    this.cursor = state.session.plies.length;
    this.board = new JieqiBoard(this.boardHost, { onMove: () => {} });
    this.boardColumn.append(this.headerCard, this.capturesTop, this.boardHost, this.capturesBottom);
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
    this.renderCaptures();
    this.renderBoard();
    this.renderSide();
  }

  /** Final analysis if the sweep finished, else the partial sweep. */
  private analysis(): GameAnalysis | null {
    const base = this.state.analysis;
    if (!base && this.live.length === 0) return null;
    // Manual per-position results override the (partial or completed) sweep so a
    // re-analysis of the current position actually updates what is shown.
    const byIndex = new Map((base?.positions ?? []).map((p) => [p.index, p]));
    for (const analysis of this.live) byIndex.set(analysis.index, analysis);
    return buildGameAnalysis(
      this.state.session.positions,
      [...byIndex.values()].sort((a, b) => a.index - b.index),
      base?.depth ?? this.depth,
    );
  }

  private reviewFrom(index: number): MoveReview | undefined {
    return this.analysis()?.moves.find((m) => m.ply === index + 1);
  }

  /** Engine result for the position the cursor sits on, if one exists yet. */
  private cursorAnalysis(): PositionAnalysis | null {
    return this.analysis()?.positions.find((p) => p.index === this.cursor) ?? null;
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
    const global = this.state.analysis;
    const merged = this.analysis();
    const cursorDone = Boolean(merged?.positions.some((p) => p.index === this.cursor));
    // A per-position analysis (from 自动分析 or 分析当前局面) has no whole-game
    // accuracy, but it must still show that the position was analyzed.
    const accuracy = global
      ? `准确率 红 ${global.accuracy.red.toFixed(1)}% · 黑 ${global.accuracy.black.toFixed(1)}%`
      : this.analyzing
        ? this.progress
        : merged
          ? `已分析 ${merged.positions.length}/${session.positions.length} 个局面`
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
        // 「分析全局」耗时较长，暂时下线；恢复时取消注释即可。
        // button(this.analyzing ? '分析中…' : '分析全局', () => this.runAnalysis(), {
        //   class: 'btn--primary',
        //   disabled: this.analyzing || this.cursorAnalyzing || session.plies.length === 0,
        // }),
        button(
          this.cursorAnalyzing ? '分析中…' : cursorDone ? '重新分析当前局面' : '分析当前局面',
          () => this.analyzeCursor(),
          { disabled: this.analyzing || this.cursorAnalyzing },
        ),
        button('停止', () => this.stopAnalysis(), { disabled: !this.analyzing && !this.cursorAnalyzing }),
        button('上一步', () => this.step(-1), {
          disabled: this.analyzing || this.cursorAnalyzing || this.cursor <= 0,
        }),
        button('下一步', () => this.step(1), {
          disabled: this.analyzing || this.cursorAnalyzing || this.cursor >= session.plies.length,
        }),
        // 导出与返回入口暂时下线。
        // button('导出棋谱 (JSON)', () => this.exportRecord('json')),
        // button('导出记谱 (TXT)', () => this.exportRecord('txt')),
        // button('回到对局', () => navigate('#/play')),
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
        h('label', { class: 'checkbox-row' }, [
          h('input', {
            attrs: { type: 'checkbox', checked: this.autoAnalyze },
            on: {
              change: (event: Event) => {
                this.autoAnalyze = (event.target as HTMLInputElement).checked;
                this.render();
              },
            },
          }),
          h('span', { text: '自动分析' }),
        ]),
        this.message ? h('span', { class: 'badge badge--warn', text: this.message }) : null,
      ]),
    );
  }

  /**
   * Captured pieces for the position at the cursor. Unlike the live table this is
   * always full-information: the opponent's capture of a still-dark piece is
   * revealed too (drawn with a 暗 badge), independent of the board's reveal toggle.
   */
  private renderCaptures(): void {
    const positions = this.state.session.positions;
    const index = Math.max(0, Math.min(this.cursor, positions.length - 1));
    const state = positions[index]!;
    const view = jieqiTruthView(state);
    const bottomColor = this.state.perspective;
    const topColor = oppositeJieqiColor(bottomColor);
    // Near each side: the pieces it captured (the opposite side's losses).
    this.capturesTop.replaceChildren(captureRow(bottomColor, view.captured));
    this.capturesBottom.replaceChildren(captureRow(topColor, view.captured));
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
    const index = this.cursor;
    const position = this.cursorAnalysis();
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
    this.revealCurrentMove();
  }

  /**
   * Keep the highlighted move inside the move list. Adjusting the list's own
   * scrollTop does that without moving the page, unlike scrollIntoView, which
   * also scrolls every scrollable ancestor.
   */
  private revealCurrentMove(): void {
    const list = this.sideColumn.querySelector<HTMLElement>('.scroll--moves');
    const current = list?.querySelector<HTMLElement>('.move--current');
    if (!list || !current) return;
    const listRect = list.getBoundingClientRect();
    const moveRect = current.getBoundingClientRect();
    if (moveRect.top < listRect.top) list.scrollTop -= listRect.top - moveRect.top;
    else if (moveRect.bottom > listRect.bottom) list.scrollTop += moveRect.bottom - listRect.bottom;
  }

  /** Step one ply and, when 自动分析 is on, analyze the position we land on. */
  private step(delta: number): void {
    const next = this.cursor + delta;
    if (next < 0 || next > this.state.session.plies.length) return;
    this.goTo(next);
    // A whole-game sweep already owns the engine; let it finish first.
    if (this.autoAnalyze && !this.analyzing) this.analyzeCursor();
  }

  private onKey = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowLeft') {
      this.step(-1);
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      this.step(1);
      event.preventDefault();
    } else if (event.key === 'Home') {
      this.goTo(0);
    } else if (event.key === 'End') {
      this.goTo(this.state.session.plies.length);
    }
  };

  // 「分析全局」耗时较长，暂时下线：按钮和这个方法一起注释，恢复时取消注释，
  // 并把上面的 analyzeGame 重新加回 import。
  /*
  private runAnalysis(): void {
    if (this.analyzing) return;
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
      cache: this.cache,
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
  */

  private stopAnalysis(): void {
    this.abort?.abort();
    this.abort = null;
    engine.stop();
    this.cursorToken += 1;
    this.analyzing = false;
    this.cursorAnalyzing = false;
    this.progress = '';
    this.render();
  }

  private analyzeCursor(): void {
    const index = this.cursor;
    const token = ++this.cursorToken;
    const controller = new AbortController();
    this.message = '';
    this.cursorAnalyzing = true;
    this.abort = controller;
    this.render();
    void analyzePosition(this.state.session.positions[index]!, index, {
      depth: this.depth,
      multiPv: 2,
      signal: controller.signal,
      cache: this.cache,
    })
      .then((analysis) => {
        if (token !== this.cursorToken) return;
        this.cursorAnalyzing = false;
        if (this.abort === controller) this.abort = null;
        this.live = this.live.filter((a) => a.index !== index).concat(analysis);
        this.render();
      })
      .catch((error: unknown) => {
        if (token !== this.cursorToken) return;
        this.cursorAnalyzing = false;
        if (this.abort === controller) this.abort = null;
        this.message = `引擎出错：${error instanceof Error ? error.message : String(error)}`;
        this.render();
      });
  }

  // 棋谱导出暂时下线：按钮和这个方法一起注释，恢复时取消注释，并加回上面
  // record.js 与 state.js 的 navigate 导入。
  /*
  private exportRecord(kind: 'json' | 'txt'): void {
    const record = buildRecord(this.state.session, this.state.meta, this.state.analysis ?? undefined);
    if (kind === 'json') {
      download(recordFilename(record), JSON.stringify(record, null, 2));
    } else {
      download(recordFilename(record).replace(/\.json$/, '.txt'), recordToText(record), 'text/plain');
    }
  }
  */
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
