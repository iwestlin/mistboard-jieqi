// Headless smoke test: rules + engine + analysis + record round-trip.
// Run with the dev server up: /browser-test.html?auto=1
import {
  createInitialJieqiState,
  createJieqiDeal,
  getJieqiLegalMoves,
  jieqiStateToPikafishFen,
  pikafishUciToJieqiMove,
  isJieqiLegalMove,
  STANDARD_JIEQI_DEAL,
} from './game/index.js';
import { JieqiSession } from './game/session.js';
import { buildRecord, parseRecord, sessionFromRecord } from './game/record.js';
import { analyzeGame, analyzePosition } from './engine/analysis.js';
import { crossOriginIsolated, engine, engineBuild } from './engine/ceval.js';

const logEl = document.getElementById('log')!;
const resultEl = document.getElementById('result')!;
const failures: string[] = [];

function log(line: string): void {
  logEl.textContent += `\n${line}`;
}

function check(name: string, ok: boolean, detail = ''): void {
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

// Deterministic deal so the test is reproducible.
let seed = 1234567;
const rng = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

async function run(): Promise<void> {
  log(`crossOriginIsolated=${crossOriginIsolated()} build=${engineBuild()}`);

  const deal = createJieqiDeal(rng);
  const initial = createInitialJieqiState('smoke', deal);
  const legal = getJieqiLegalMoves(initial);
  check('initial legal moves', legal.length > 0, `${legal.length} moves`);
  check('dark pieces present', Object.values(initial.board).some((p) => p?.faceDown));

  const fen = jieqiStateToPikafishFen(initial);
  log(`start FEN: ${fen}`);
  check('fen has dark markers', /[Xx]/.test(fen));

  const session = new JieqiSession('smoke', { deal });

  // 1) Engine answers on the opening position with a legal move.
  const search = await engine.evaluate({ fen, depth: 4, multiPv: 2 });
  log(`engine bestmove: ${search.best} lines=${search.lines.length}`);
  const parsed = search.best ? pikafishUciToJieqiMove(search.best) : null;
  check('engine bestmove parses', Boolean(parsed), search.best ?? 'null');
  check('engine bestmove legal', Boolean(parsed && isJieqiLegalMove(session.current, parsed)));

  // 2) Play a short game (engine's own choice each ply) and analyze it.
  for (let i = 0; i < 4 && !session.finished; i += 1) {
    const move = session.legalMoves()[0]!;
    session.play(move);
  }
  check('plies recorded', session.plies.length >= 1, `${session.plies.length} plies`);

  const analysis = await analyzeGame(session.positions, { depth: 4, multiPv: 1 });
  check('analysis covers positions', analysis.positions.length === session.positions.length);
  check('analysis has best moves', analysis.positions.every((p) => p.best !== null));
  check('analysis grades moves', analysis.moves.length === session.plies.length);

  // 3) Record round-trip.
  const record = buildRecord(
    session,
    {
      mode: 'hvh',
      players: { red: { name: 'Red', kind: 'human' }, black: { name: 'Black', kind: 'human' } },
      gameId: 'smoke',
    },
    analysis,
  );
  const text = JSON.stringify(record, null, 2);
  const reimported = sessionFromRecord(parseRecord(text));
  check('record round-trip plies', reimported.plies.length === session.plies.length);
  check(
    'record round-trip fen',
    reimported.currentDealtFen() === session.currentDealtFen(),
  );
  check('record keeps analysis', Boolean(record.analysis?.moves.length));

  // 4) Position-only analysis helper.
  const single = await analyzePosition(session.current, session.plies.length, { depth: 4 });
  check('single-position analysis', single.best !== null);

  // 5) Standard deal sanity (no shuffle) still legal.
  const std = new JieqiSession('std', { deal: STANDARD_JIEQI_DEAL });
  check('standard deal legal', std.legalMoves().length > 0);

  resultEl.textContent = failures.length === 0 ? 'PASS' : `FAIL: ${failures.join(', ')}`;
}

run().catch((error: unknown) => {
  log(`ERROR ${error instanceof Error ? error.stack : String(error)}`);
  resultEl.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`;
});
