// Jieqi rules kernel, vendored from Mistboard's `packages/game` (AGPL-3.0-or-later).
//
// `variants-jieqi.ts` owns canonical state (every true identity).
// `getJieqiPlayerView` / `jieqiMaskedBoard` produce the hidden-information
// projection; `jieqi-fen.ts` encodes the redacted FEN the engine is allowed to
// observe. See those files for the full rule and redaction commentary.

export * from './types.js';
export * from './xiangqi-geometry.js';
export * from './variants-jieqi.js';
export * from './dealt-fen.js';
export * from './jieqi-fen.js';
export * from './session.js';
