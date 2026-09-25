// App shell: header + hash routing between the play and review screens.

import { parseRecord, sessionFromRecord } from '../game/record.js';
import { crossOriginIsolated, engine } from '../engine/ceval.js';
import { h, button } from './dom.js';
import { PlayView } from './play-view.js';
import { ReviewView } from './review-view.js';
import { newGameState, type AppState } from './state.js';

type Mounted = { destroy?: () => void };

export class App {
  private readonly main = h('main', { class: 'view', id: 'view' });
  private readonly status = h('span', { class: 'engine-status', text: '引擎：未加载' });
  private view: Mounted | null = null;

  constructor(
    private readonly root: HTMLElement,
    private state: AppState,
  ) {}

  start(): void {
    this.root.replaceChildren(this.header(), this.main, this.footer());
    window.addEventListener('hashchange', () => this.route());
    this.route();
  }

  private header(): HTMLElement {
    const fileInput = h('input', {
      class: 'file-input',
      attrs: { type: 'file', accept: '.json,application/json' },
      on: {
        change: (event: Event) => {
          const input = event.target as HTMLInputElement;
          const file = input.files?.[0];
          if (file) void this.importFile(file);
          input.value = '';
        },
      },
    });
    return h('header', { class: 'app-header' }, [
      h('div', { class: 'brand' }, [
        h('span', { class: 'brand__mark', text: '揭' }),
        h('div', {}, [
          h('h1', { text: '揭棋 · Jieqi' }),
          h('p', { class: 'muted', text: '浏览器内的揭棋：人机 / 人人 / 复盘分析' }),
        ]),
      ]),
      h('nav', { class: 'nav' }, [
        h('a', { class: 'nav__link', text: '对局', attrs: { href: '#/play' } }),
        h('a', { class: 'nav__link', text: '复盘分析', attrs: { href: '#/review' } }),
        button('导入棋谱', () => fileInput.click()),
        fileInput,
        button('加载引擎', () => void this.loadEngine()),
        this.status,
      ]),
    ]);
  }

  private footer(): HTMLElement {
    return h('footer', { class: 'app-footer' }, [
      h('span', {
        text: 'AI 为 PikaJieQi（Pikafish 揭棋分支）WebAssembly，GPL-3.0-or-later；应用代码 AGPL-3.0-or-later。',
      }),
    ]);
  }

  private async loadEngine(): Promise<void> {
    if (!crossOriginIsolated()) {
      this.status.textContent = '引擎：页面非跨源隔离（需要 COOP/COEP）';
      this.status.className = 'engine-status engine-status--error';
      return;
    }
    this.status.textContent = '引擎：加载中…';
    this.status.className = 'engine-status';
    try {
      await engine.preload();
      this.status.textContent = '引擎：就绪';
      this.status.className = 'engine-status engine-status--ready';
    } catch (error) {
      this.status.textContent = `引擎：失败（${error instanceof Error ? error.message : String(error)}）`;
      this.status.className = 'engine-status engine-status--error';
    }
  }

  private async importFile(file: File): Promise<void> {
    try {
      const parsed = parseRecord(await file.text());
      const session = sessionFromRecord(parsed);
      this.state = {
        session,
        meta: {
          mode: parsed.record.mode ?? 'hvh',
          players: parsed.record.players ?? {
            red: { name: 'Red', kind: 'human' },
            black: { name: 'Black', kind: 'human' },
          },
          gameId: parsed.record.game_id ?? 'imported',
        },
        analysis: null,
        perspective: 'red',
      };
      window.location.hash = '#/review';
      this.route();
    } catch (error) {
      window.alert(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private route(): void {
    this.view?.destroy?.();
    this.view = null;
    this.main.replaceChildren();
    this.main.scrollTop = 0;
    const hash = window.location.hash || '#/play';
    if (hash.startsWith('#/review')) {
      const view = new ReviewView(this.main, this.state);
      this.view = view;
    } else {
      const view = new PlayView(this.main, this.state);
      this.view = view;
    }
  }
}

export { newGameState };
