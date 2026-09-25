// Play screen: human vs human (hotseat) and human vs PikaJieQi. All local — the
// engine runs in a worker, the game state in memory.

import {
  getJieqiLegalMoves,
  jieqiTruthView,
  oppositeJieqiColor,
  pikafishUciToJieqiMove,
  type JieqiColor,
  type JieqiMove,
  type JieqiPlayerBoard,
} from '../game/index.js';
import { buildRecord, download, recordFilename, recordToText } from '../game/record.js';
import { analyzePosition, type PositionAnalysis } from '../engine/analysis.js';
import { engine, crossOriginIsolated } from '../engine/ceval.js';
import { h, button, clear, select } from './dom.js';
import { JieqiBoard, type BoardArrow } from './board.js';
import { coordLabel, pvLabels, uciLabel } from './notation.js';
import { ROLE_GLYPH } from './pieces.js';
import { navigate, newGameState, randomId, type AppState } from './state.js';

export type PlayMode = 'hvh' | 'hvai';

const DEPTHS = [4, 6, 8, 10, 12, 14, 16] as const;

// Adaptive strength: shallow in the opening (fast), deeper as material comes off
// and the endgame needs precision. Depth is interpolated over remaining pieces.
const AUTO_MIN_DEPTH = 8;
const AUTO_MAX_DEPTH = 18;
const START_PIECES = 32;

export class PlayView {
  private readonly board: JieqiBoard;
  private readonly boardHost = h('div', { class: 'board-host' });
  private readonly topBar = h('div', { class: 'turn-bar' });
  private readonly captures = h('div', { class: 'captures' });
  private readonly sideColumn = h('aside', { class: 'side-column' });

  private mode: PlayMode;
  private engineColor: JieqiColor;
  private adaptive = true;
  private depth: number;
  private autoFlip = false;

  private hint: PositionAnalysis | null = null;
  private hintPly = -1;
  private aiThinking = false;
  private aiToken = 0;
  private message = '';

  constructor(
    private readonly root: HTMLElement,
    private readonly state: AppState,
  ) {
    this.mode = state.meta.mode;
    this.engineColor = state.meta.players.black.kind === 'engine' ? 'black' : 'red';
    this.depth = 10;
    this.board = new JieqiBoard(this.boardHost, {
      onMove: (move) => this.playMove(move),
    });
    this.mount();
  }

  private mount(): void {
    this.root.replaceChildren(
      h('div', { class: 'play-layout' }, [
        h('section', { class: 'board-column' }, [this.topBar, this.boardHost, this.captures]),
        this.sideColumn,
      ]),
    );
    this.render();
    this.maybeRunEngine();
    if (!crossOriginIsolated()) {
      this.message = '当前页面不是跨源隔离的，PikaJieQi 引擎无法加载（需要 COOP/COEP 响应头）。';
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  private render(): void {
    const session = this.state.session;
    const turn = session.turn;

    const board: JieqiPlayerBoard =
      this.mode === 'hvh' && session.finished
        ? jieqiTruthView(session.current).board
        : session.maskedBoard();

    const legalMoves =
      turn && this.canHumanMove(turn) && !this.aiThinking ? getJieqiLegalMoves(session.current) : [];

    const checkSquare = this.checkSquare();

    this.board.render({
      view: { board, legalMoves, lastMove: session.current.lastMove ?? null },
      perspective: this.state.perspective,
      sideToMove: turn,
      interactive: Boolean(turn && this.canHumanMove(turn) && !this.aiThinking),
      arrows: this.hintArrows(),
      checkSquare,
    });

    this.renderTopBar();
    this.renderCaptures();
    this.renderSideColumn();
  }

  private canHumanMove(turn: JieqiColor): boolean {
    if (this.mode === 'hvh') return true;
    return turn !== this.engineColor;
  }

  /** Engine depth for the current position: fixed, or scaled by remaining material. */
  private effectiveDepth(): number {
    if (!this.adaptive) return this.depth;
    const board = this.state.session.current.board;
    let pieces = 0;
    for (const square in board) if (board[square]) pieces++;
    const phase = 1 - Math.min(1, pieces / START_PIECES);
    return Math.round(AUTO_MIN_DEPTH + phase * (AUTO_MAX_DEPTH - AUTO_MIN_DEPTH));
  }

  private checkSquare(): string | null {
    const session = this.state.session;
    const status = session.status();
    if (status.type !== 'playing') return null;
    for (const [square, entry] of Object.entries(session.current.board)) {
      if (entry?.role === 'general' && entry.color === status.turn) {
        return session.playerView(status.turn).inCheck ? square : null;
      }
    }
    return null;
  }

  private hintArrows(): BoardArrow[] {
    if (!this.hint || this.hintPly !== this.state.session.plies.length) return [];
    const arrows: BoardArrow[] = [];
    if (this.hint.bestMove) {
      arrows.push({ from: this.hint.bestMove.from, to: this.hint.bestMove.to, kind: 'best' });
    }
    return arrows;
  }

  private renderTopBar(): void {
    const session = this.state.session;
    const status = session.status();
    const parts: (Node | string)[] = [];
    if (status.type === 'playing') {
      const name = status.turn === 'red' ? '红方' : '黑方';
      const who = this.mode === 'hvai' && status.turn === this.engineColor ? '（引擎）' : '';
      parts.push(h('span', { class: `turn-pill turn-pill--${status.turn}`, text: `${name}走棋${who}` }));
      if (session.playerView(status.turn).inCheck) parts.push(h('span', { class: 'badge badge--check', text: '将军' }));
    } else if (status.type === 'finished') {
      const text =
        status.winner === null
          ? `和棋 · ${reasonLabel(status.reason)}`
          : `${status.winner === 'red' ? '红方' : '黑方'}胜 · ${reasonLabel(status.reason)}`;
      parts.push(h('span', { class: 'result-pill', text }));
    }
    if (this.aiThinking) parts.push(h('span', { class: 'badge badge--thinking', text: '引擎思考中…' }));
    if (this.message) parts.push(h('span', { class: 'badge badge--warn', text: this.message }));
    this.topBar.replaceChildren(...parts);
  }

  private renderCaptures(): void {
    const session = this.state.session;
    const view = this.mode === 'hvai' ? session.playerView(this.state.perspective) : jieqiTruthView(session.current);
    const forColor = (owner: JieqiColor) =>
      view.captured
        .filter((c) => c.owner === owner)
        .map((c) => (c.role ? ROLE_GLYPH[owner][c.role] : '?'))
        .join(' ');
    this.captures.replaceChildren(
      h('div', { class: 'capture-row capture-row--red' }, [
        h('span', { class: 'capture-label', text: '红方损失' }),
        h('span', { class: 'capture-pieces', text: forColor('red') || '—' }),
      ]),
      h('div', { class: 'capture-row capture-row--black' }, [
        h('span', { class: 'capture-label', text: '黑方损失' }),
        h('span', { class: 'capture-pieces', text: forColor('black') || '—' }),
      ]),
    );
  }

  private renderSideColumn(): void {
    clear(this.sideColumn);
    this.sideColumn.append(this.renderControls(), this.renderMoves(), this.renderEngine());
  }

  private renderControls(): HTMLElement {
    const session = this.state.session;
    const card = h('div', { class: 'card' });
    card.append(h('h2', { text: '对局' }));

    card.append(
      h('div', { class: 'row' }, [
        h('label', { class: 'field-label', text: '模式' }),
        select(
          [
            { value: 'hvh', label: '人人对战' },
            { value: 'hvai', label: '人机对战' },
          ],
          this.mode,
          (value) => {
            this.mode = value;
            if (value === 'hvh') {
              this.state.meta.mode = 'hvh';
              this.state.meta.players.red = { name: 'Red', kind: 'human' };
              this.state.meta.players.black = { name: 'Black', kind: 'human' };
            } else {
              this.state.meta.mode = 'hvai';
            }
            this.render();
            this.maybeRunEngine();
          },
        ),
      ]),
    );

    if (this.mode === 'hvai') {
      card.append(
        h('div', { class: 'row' }, [
          h('label', { class: 'field-label', text: '我方执' }),
          select(
            [
              { value: 'red', label: '红方（先手）' },
              { value: 'black', label: '黑方（后手）' },
            ],
            this.engineColor === 'red' ? 'black' : 'red',
            (value) => {
              this.setHumanColor(value as JieqiColor);
            },
          ),
        ]),
      );
      card.append(
        h('div', { class: 'row' }, [
          h('label', { class: 'field-label', text: '引擎强度' }),
          select(
            [
              { value: 'auto', label: '自适应（开局浅 / 残局深）' },
              ...DEPTHS.map((d) => ({ value: String(d), label: `深度 ${d}` })),
            ],
            this.adaptive ? 'auto' : String(this.depth),
            (value) => {
              if (value === 'auto') {
                this.adaptive = true;
              } else {
                this.adaptive = false;
                this.depth = Number(value);
              }
              this.render();
            },
          ),
        ]),
      );
      card.append(
        h('p', {
          class: 'hint-text',
          text: this.adaptive
            ? `AI 使用 PikaJieQi WASM；当前深度 ${this.effectiveDepth()}，随子力减少逐渐加深（${AUTO_MIN_DEPTH}→${AUTO_MAX_DEPTH}）。`
            : `AI 使用 PikaJieQi WASM（Pikafish 揭棋分支），运行在你的浏览器里，无需服务器。`,
        }),
      );
    } else {
      card.append(
        h('label', { class: 'checkbox-row' }, [
          h('input', {
            attrs: { type: 'checkbox', checked: this.autoFlip },
            on: {
              change: (event: Event) => {
                this.autoFlip = (event.target as HTMLInputElement).checked;
              },
            },
          }),
          h('span', { text: '自动翻转棋盘（轮到黑方时）' }),
        ]),
      );
    }

    card.append(
      h('div', { class: 'row row--buttons' }, [
        button('新对局', () => this.newGame()),
        button('悔棋', () => this.undo(), { disabled: session.plies.length === 0 }),
        button('认输', () => this.resign(), {
          disabled: session.finished || session.plies.length === 0,
        }),
        button('翻转棋盘', () => {
          this.state.perspective = oppositeJieqiColor(this.state.perspective);
          this.render();
        }),
      ]),
    );

    card.append(
      h('div', { class: 'row row--buttons' }, [
        button('导出棋谱 (JSON)', () => this.exportRecord('json'), {
          disabled: session.plies.length === 0,
        }),
        button('导出记谱 (TXT)', () => this.exportRecord('txt'), {
          disabled: session.plies.length === 0,
        }),
        button('去复盘分析 →', () => navigate('#/review'), { class: 'btn--primary' }),
      ]),
    );
    return card;
  }

  private renderMoves(): HTMLElement {
    const card = h('div', { class: 'card card--grow' });
    card.append(h('h2', { text: '着法' }));
    const session = this.state.session;
    if (session.plies.length === 0) {
      card.append(h('p', { class: 'muted', text: '还没有着法。' }));
      return card;
    }
    const list = h('ol', { class: 'move-list' });
    for (let i = 0; i < session.plies.length; i += 2) {
      const red = session.plies[i]!;
      const black = session.plies[i + 1];
      list.append(
        h('li', {}, [
          h('span', { class: 'move-number', text: `${i / 2 + 1}.` }),
          h('span', { class: 'move move--red', text: `${coordLabel(red.move)}${tagsOf(red)}` }),
          h('span', {
            class: 'move move--black',
            text: black ? `${coordLabel(black.move)}${tagsOf(black)}` : '',
          }),
        ]),
      );
    }
    card.append(h('div', { class: 'scroll' }, [list]));
    return card;
  }

  private renderEngine(): HTMLElement {
    const card = h('div', { class: 'card' });
    card.append(h('h2', { text: '引擎提示' }));
    card.append(
      h('div', { class: 'row row--buttons' }, [
        button('分析当前局面', () => this.runHint(), {
          disabled: this.state.session.finished || this.aiThinking,
        }),
        button('清除', () => {
          this.hint = null;
          this.hintPly = -1;
          this.render();
        }),
      ]),
    );
    if (this.hint && this.hintPly === this.state.session.plies.length) {
      const line = this.hint.lines[0];
      card.append(
        h('p', { class: 'engine-line' }, [
          h('strong', { text: this.hint.best ? uciLabel(this.hint.best) : '—' }),
          h('span', {
            class: 'muted',
            text: `  深度 ${this.hint.depth}  ${scoreLabel(this.hint)}`,
          }),
        ]),
      );
      const pv = pvLabels(line?.pvUci ?? []);
      if (pv.length) card.append(h('p', { class: 'muted', text: `主变：${pv.slice(0, 6).join(' ')}` }));
    } else {
      card.append(h('p', { class: 'muted', text: '点击按钮让引擎给出推荐着法（棋盘上以箭头显示）。' }));
    }
    return card;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  /** Stop any in-flight engine work when this view is unmounted. */
  destroy(): void {
    this.aiToken++;
    this.aiThinking = false;
  }

  private playMove(move: JieqiMove): void {
    const session = this.state.session;
    if (!session.play(move)) return;
    this.hint = null;
    this.hintPly = -1;
    this.afterMove();
  }

  private afterMove(): void {
    const session = this.state.session;
    if (this.autoFlip && this.mode === 'hvh') {
      const turn = session.turn;
      if (turn) this.state.perspective = turn;
    }
    this.state.analysis = null;
    this.render();
    this.maybeRunEngine();
  }

  private maybeRunEngine(): void {
    const session = this.state.session;
    if (this.mode !== 'hvai') return;
    const turn = session.turn;
    if (!turn || turn !== this.engineColor || session.finished) return;
    const token = ++this.aiToken;
    this.aiThinking = true;
    this.render();

    void engine
      .evaluate({ fen: session.fenFor(this.engineColor), depth: this.effectiveDepth(), multiPv: 1 })
      .then((result) => {
        if (token !== this.aiToken) return;
        this.aiThinking = false;
        const parsed = result.best ? pikafishUciToJieqiMove(result.best) : null;
        let played = parsed ? session.play(parsed) : null;
        if (!played) {
          // The engine's move was rejected by the kernel: retry once at a shallower
          // depth, then fall back to the first legal move so the game never stalls.
          const legal = session.legalMoves();
          played = legal.length ? session.play(legal[0]!) : null;
        }
        if (!played) {
          this.message = '引擎没有可走的着法。';
          this.render();
          return;
        }
        this.afterMove();
      })
      .catch((error: unknown) => {
        if (token !== this.aiToken) return;
        this.aiThinking = false;
        this.message = `引擎出错：${error instanceof Error ? error.message : String(error)}`;
        this.render();
      });
  }

  private runHint(): void {
    const session = this.state.session;
    const ply = session.plies.length;
    this.message = '';
    void analyzePosition(session.current, ply, { depth: this.effectiveDepth(), multiPv: 2 })
      .then((analysis) => {
        if (this.state.session.plies.length !== ply || this.state.session !== session) return;
        this.hint = analysis;
        this.hintPly = ply;
        this.render();
      })
      .catch((error: unknown) => {
        this.message = `引擎出错：${error instanceof Error ? error.message : String(error)}`;
        this.render();
      });
  }

  private undo(): void {
    const session = this.state.session;
    if (session.plies.length === 0) return;
    this.aiToken++;
    this.aiThinking = false;
    this.message = '';
    this.hint = null;
    this.state.analysis = null;
    session.undo();
    if (this.mode === 'hvai' && session.turn === this.engineColor && session.plies.length > 0) {
      session.undo();
    }
    this.render();
    this.maybeRunEngine();
  }

  private resign(): void {
    const session = this.state.session;
    const loser =
      this.mode === 'hvai' ? (this.engineColor === 'red' ? 'black' : 'red') : session.turn;
    if (!loser) return;
    session.resign(loser);
    this.aiToken++;
    this.aiThinking = false;
    this.render();
  }

  private newGame(): void {
    this.aiToken++;
    this.aiThinking = false;
    this.hint = null;
    this.message = '';
    const mode = this.mode;
    const humanColor = this.engineColor === 'red' ? 'black' : 'red';
    const fresh = newGameState({
      gameId: randomId(),
      mode,
      players:
        mode === 'hvai'
          ? {
              red: humanColor === 'red' ? { name: 'You', kind: 'human' } : { name: 'PikaJieQi', kind: 'engine' },
              black: humanColor === 'black' ? { name: 'You', kind: 'human' } : { name: 'PikaJieQi', kind: 'engine' },
            }
          : { red: { name: 'Red', kind: 'human' }, black: { name: 'Black', kind: 'human' } },
    });
    this.state.session = fresh.session;
    this.state.meta = fresh.meta;
    this.state.analysis = null;
    this.state.perspective = 'red';
    this.render();
    this.maybeRunEngine();
  }

  private setHumanColor(color: JieqiColor): void {
    this.aiToken++;
    this.aiThinking = false;
    this.engineColor = oppositeJieqiColor(color);
    this.state.perspective = color;
    this.state.meta.mode = 'hvai';
    this.state.meta.players = {
      red: color === 'red' ? { name: 'You', kind: 'human' } : { name: 'PikaJieQi', kind: 'engine' },
      black: color === 'black' ? { name: 'You', kind: 'human' } : { name: 'PikaJieQi', kind: 'engine' },
    };
    this.render();
    this.maybeRunEngine();
  }

  private exportRecord(kind: 'json' | 'txt'): void {
    const record = buildRecord(this.state.session, this.state.meta);
    if (kind === 'json') {
      download(recordFilename(record), JSON.stringify(record, null, 2));
      return;
    }
    download(recordFilename(record).replace(/\.json$/, '.txt'), recordToText(record), 'text/plain');
  }
}

function tagsOf(ply: { revealed: string | null; captured: { role: string } | null; check: boolean }): string {
  const tags: string[] = [];
  if (ply.revealed) tags.push('揭');
  if (ply.captured) tags.push('吃');
  if (ply.check) tags.push('将');
  return tags.length ? ` ${tags.join('')}` : '';
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

function scoreLabel(analysis: PositionAnalysis): string {
  const line = analysis.lines[0];
  if (!line) return '—';
  if (line.mate !== null) return `${line.mate > 0 ? '+' : '-'}M${Math.abs(line.mate)}`;
  if (line.scoreCp === null) return '—';
  const pawns = line.scoreCp / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
}
