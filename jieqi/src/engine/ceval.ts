// PikaJieQi browser engine client.
//
// The engine is the classical-evaluation Pikafish `jieqi_old` branch compiled to
// WebAssembly (see public/engine/pikafish-jieqi/README.md). It runs as a
// persistent UCI session inside a dedicated worker and streams
// iterative-deepening MultiPV updates. No server, no NNUE download: this build
// uses the branch's handcrafted evaluation.
//
// Ported from Mistboard's `apps/web/src/review/engine/pikajieqi-ceval.ts` and
// `multipv-burst.ts` (AGPL-3.0-or-later), reduced to the one backend this app
// ships.

import { parseInfo } from './uci-info.js';

export type EngineLine = {
  /** 1-based rank within MultiPV (1 = best). */
  multipv: number;
  depth: number;
  /** Centipawns, side-to-move POV. Null when `mate` is set. */
  scoreCp: number | null;
  /** Signed moves-to-mate, side-to-move POV. Null otherwise. */
  mate: number | null;
  /** Principal variation, Pikafish UCI. */
  pvUci: string[];
};

export type EngineResult = {
  /** Pikafish UCI of the played search's best move, e.g. "e7e6". */
  best: string | null;
  depth: number;
  seldepth: number;
  nodes: number;
  nps: number;
  lines: EngineLine[];
};

export type EvaluateOptions = {
  /** Pikafish-jieqi FEN of the root position. */
  fen: string;
  /** Pikafish UCI moves to replay from `fen`. A reveal cannot be replayed this
   *  way, so callers send per-position FENs and leave this empty. */
  moves?: readonly string[];
  depth?: number;
  /** Soft time budget in ms. When set, the engine iterates until time is up
   *  (deeper as the position allows) instead of stopping at a fixed depth. */
  movetime?: number;
  multiPv?: number;
  signal?: AbortSignal;
  onUpdate?: (partial: EngineResult) => void;
};

const ENGINE_BASE = 'engine/pikafish-jieqi/';
const EMIT_THROTTLE_MS = 80;

const engineAsset = (file: string): string =>
  new URL(`${ENGINE_BASE}${file}`, document.baseURI).href;

const EMPTY: EngineResult = { best: null, depth: 0, seldepth: 0, nodes: 0, nps: 0, lines: [] };

type EngineMessage =
  | { type: 'ready' }
  | { type: 'line'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'error'; error?: string };

export class EngineUnavailableError extends Error {}

/** Cross-origin isolation is what gives Emscripten its SharedArrayBuffer. */
export function crossOriginIsolated(): boolean {
  return typeof globalThis.crossOriginIsolated === 'boolean'
    ? globalThis.crossOriginIsolated
    : typeof SharedArrayBuffer !== 'undefined';
}

/**
 * Which PikaJieQi build the page can actually run. The pthread build needs a
 * SharedArrayBuffer, which browsers only hand to cross-origin isolated
 * documents; in-app browsers such as WeChat's cannot be served COOP/COEP, so
 * there we fall back to the single-threaded build instead of refusing to load.
 */
export type EngineBuild = 'threads' | 'single';

export function engineBuild(): EngineBuild {
  return crossOriginIsolated() ? 'threads' : 'single';
}

/** Assets for each build, relative to `ENGINE_BASE`. */
const ENGINE_FILES: Record<EngineBuild, { js: string; wasm: string }> = {
  threads: { js: 'pikajieqi.js', wasm: 'pikajieqi.wasm' },
  single: { js: 'pikajieqi-st.js', wasm: 'pikajieqi-st.wasm' },
};

/**
 * Complete MultiPV bursts only. The engine re-prints every MultiPV line each
 * time one PV finishes, and un-researched lines carry the previous depth; a
 * mid-burst snapshot pairs the new best line with stale siblings.
 */
function createBurstCollector(multiPv: number) {
  const expected = Math.max(1, Math.floor(multiPv));
  let pending = new Map<number, EngineLine>();
  const take = (): EngineLine[] => {
    const lines = [...pending.values()].sort((a, b) => a.multipv - b.multipv);
    pending = new Map();
    return lines;
  };
  return {
    push(info: ReturnType<typeof parseInfo> & object): EngineLine[] | null {
      if (!info.pvUci.length || info.bound) return null;
      let completed: EngineLine[] | null = null;
      if (info.multipv === 1 && pending.size > 0) completed = take();
      pending.set(info.multipv, {
        multipv: info.multipv,
        depth: info.depth,
        scoreCp: info.scoreCp,
        mate: info.mate,
        pvUci: info.pvUci,
      });
      if (pending.size >= expected) completed = take();
      return completed;
    },
    flush(): EngineLine[] | null {
      return pending.size > 0 ? take() : null;
    },
  };
}

/** Persistent streaming UCI client for the PikaJieQi worker. */
export class JieqiEngine {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private build: EngineBuild | null = null;
  private listeners = new Set<(line: string) => void>();
  private searching = false;
  private token = 0;
  /** Searches are serialized: the engine answers one `go` at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Load the worker + wasm and finish the UCI handshake. Idempotent. */
  preload(): Promise<void> {
    if (!this.ready) this.ready = this.spawn();
    return this.ready;
  }

  isReady(): boolean {
    return this.worker !== null;
  }

  /** Build backing the running engine, or null before the first load. */
  activeBuild(): EngineBuild | null {
    return this.build;
  }

  private async spawn(): Promise<void> {
    const build = engineBuild();
    const files = ENGINE_FILES[build];
    const worker = new Worker(engineAsset('worker.js'));
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<EngineMessage>) => {
      const message = event.data;
      if (message.type === 'line') {
        if (message.line.startsWith('bestmove')) this.searching = false;
        for (const listener of [...this.listeners]) listener(message.line);
      }
    };

    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown): void => {
        worker.terminate();
        this.worker = null;
        this.ready = null; // allow a later preload() to retry
        reject(
          error instanceof EngineUnavailableError
            ? error
            : new EngineUnavailableError(error instanceof Error ? error.message : String(error)),
        );
      };
      const onMessage = (event: MessageEvent<EngineMessage>) => {
        const message = event.data;
        if (message.type === 'ready') {
          worker.removeEventListener('message', onMessage);
          resolve();
        } else if (message.type === 'error') {
          worker.removeEventListener('message', onMessage);
          fail(message.error ?? 'engine worker init failed');
        }
      };
      worker.addEventListener('message', onMessage);
      worker.onerror = (event) => fail(`engine worker error: ${event.message}`);
      worker.postMessage({
        type: 'init',
        build,
        jsUrl: engineAsset(files.js),
        wasmUrl: engineAsset(files.wasm),
      });
    });
    this.build = build;

    const uciOk = this.waitFor((line) => line === 'uciok');
    this.send('uci');
    await uciOk;

    // Keep the branch default of one search thread: changing Threads from inside
    // the dedicated worker blocks while Emscripten provisions another pthread.
    this.send('setoption name Hash value 32');
    this.send('setoption name UCI_AnalyseMode value true');
    const ready = this.waitFor((line) => line === 'readyok');
    this.send('isready');
    await ready;
  }

  private send(command: string): void {
    if (!this.worker) throw new EngineUnavailableError('engine worker is not ready');
    this.worker.postMessage({ type: 'command', command });
  }

  private onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private waitFor(predicate: (line: string) => boolean): Promise<string> {
    return new Promise((resolve) => {
      const off = this.onLine((line) => {
        if (!predicate(line)) return;
        off();
        resolve(line);
      });
    });
  }

  private async stopAndWait(): Promise<void> {
    if (!this.searching) return;
    const stopped = this.waitFor((line) => line.startsWith('bestmove'));
    this.send('stop');
    await stopped;
    this.searching = false;
  }

  /** Run one search to completion (or until `stop()`/a newer `evaluate`). */
  evaluate(req: EvaluateOptions): Promise<EngineResult> {
    const run = (): Promise<EngineResult> => this.evaluateNow(req);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async evaluateNow(req: EvaluateOptions): Promise<EngineResult> {
    if (req.signal?.aborted) return EMPTY;
    await this.preload();
    const myToken = ++this.token;
    await this.stopAndWait();
    if (this.token !== myToken) return EMPTY;

    const multiPv = req.multiPv ?? 1;
    const depth = req.depth ?? 12;
    this.send(`setoption name MultiPV value ${multiPv}`);
    this.send(
      req.moves && req.moves.length
        ? `position fen ${req.fen} moves ${req.moves.join(' ')}`
        : `position fen ${req.fen}`,
    );

    const bursts = createBurstCollector(multiPv);
    let lines: EngineLine[] = [];
    let seldepth = 0;
    let nodes = 0;
    let nps = 0;
    let best: string | null = null;
    const snapshot = (): EngineResult => ({
      best,
      depth: lines[0]?.depth ?? 0,
      seldepth,
      nodes,
      nps,
      lines,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emit = (): void => {
      timer = undefined;
      if (this.token === myToken) req.onUpdate?.(snapshot());
    };
    const schedule = (): void => {
      if (timer === undefined) timer = setTimeout(emit, EMIT_THROTTLE_MS);
    };

    return await new Promise<EngineResult>((resolve) => {
      const off = this.onLine((line) => {
        if (this.token !== myToken) return;
        if (line.startsWith('info ')) {
          const info = parseInfo(line);
          if (!info) return;
          if (info.seldepth) seldepth = info.seldepth;
          if (info.nodes) nodes = info.nodes;
          if (info.nps) nps = info.nps;
          const burst = bursts.push(info);
          if (burst) {
            lines = burst;
            if (req.onUpdate) schedule();
          }
          return;
        }
        if (!line.startsWith('bestmove')) return;
        off();
        this.searching = false;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        const tail = bursts.flush();
        if (tail) lines = tail;
        const token = line.split(/\s+/)[1];
        best = token && token !== '(none)' ? token : null;
        const result = snapshot();
        req.onUpdate?.(result);
        resolve(result);
      });
      this.searching = true;
      this.send(
        req.movetime && req.movetime > 0
          ? `go movetime ${Math.round(req.movetime)}`
          : `go depth ${depth}`,
      );
    });
  }

  /** Supersede any in-flight search. */
  stop(): void {
    this.token++;
    if (this.searching && this.worker) this.send('stop');
  }

  dispose(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.listeners.clear();
    this.searching = false;
  }
}

/** One shared engine instance for the whole app. */
export const engine = new JieqiEngine();
