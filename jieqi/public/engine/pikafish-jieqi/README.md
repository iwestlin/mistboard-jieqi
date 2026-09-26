# PikaJieQi WebAssembly

Browser build of Pikafish's classical-evaluation `jieqi_old` branch for Reveal
Xiangqi review analysis.

- Upstream source: `official-pikafish/Pikafish`
- Upstream base commit: `23b9466c981f0f3a1133f92de1a6f86406c4eccc`
- Distributed commit: `e75cee3a3698794b4b6f5574a8774f0575bc0c21`
  (`brianhliou/pikafish-jieqi-wasm`, branch `jieqi_old-mistboard`)
- Build toolchain: `emscripten/emsdk:3.1.74`
- License: GPL-3.0-or-later (`COPYING.txt`)
- Network: none; this build uses the branch's handcrafted evaluation

Since 2026-08-31 this is not a stock upstream build. `source.patch` carries the
WASM entry points **and** two engine changes. The server binary carries both:
the analysis board and the bot are deliberately the same engine, and moving one
without the other breaks that.

`src/misc.h` (2026-08-31): `ScoreCalc` no longer lets a forced loss be averaged
away at dark-piece flip nodes. A mate was clamped to ±`DARKVALRATE` (2862) and
then diluted by the other revealed identities, so the engine could report a
comfortable advantage in a position where it was being mated.

`src/search.cpp` (2026-09-03): `qsearch()` checks `Threads.stop`, and the main
thread calls `check_time()`, at its entry. It had neither, and the dark-piece
recursion re-enters qsearch at depth 0 without reducing depth, so a thread
inside one of those tails could not be stopped by `go movetime` and `bestmove`
waited on the slowest helper. Server-side that was the tail of the #335
timeouts; in the browser it is a search that overruns the depth the user asked
for.

The build exposes a persistent `pikajieqi_command(const char*)` UCI entry point.
`worker.js` hosts the module and forwards streaming UCI output to the web client.

Two WASM builds ship side by side and share that same interface:

- `pikajieqi.js` / `pikajieqi.wasm` — Emscripten pthreads build. Fastest, but it
  needs `SharedArrayBuffer` and therefore a cross-origin-isolated document
  (`COOP: same-origin` + `COEP: require-corp`).
- `pikajieqi-st.js` / `pikajieqi-st.wasm` — single-threaded build. No
  `SharedArrayBuffer`, so it runs on any document. The web client selects it
  automatically when `crossOriginIsolated` is false (for example in WeChat's
  in-app browser, which cannot be served COOP/COEP).

Both are produced from the same patched source, so they play identically; the
single-threaded build only gives up the helper thread pool.

`src/thread.cpp` and `src/tt.cpp`: the engine unconditionally constructs
`std::thread` helpers, and Emscripten's non-pthread `std::thread` aborts at
runtime (`Aborted()`), so the single-threaded build defines
`PIKAFISH_SINGLE_THREAD`. That guard makes `Thread` run its search inline,
forces `ThreadPool::set` to one thread, and zeroes the transposition table with
`memset` instead of a thread vector. The pthread build leaves the define off and
compiles the original paths.

## Rebuild

`pikajieqi-source-e75cee3.tar.gz` is the complete corresponding source used for
the distributed binaries. Extract it and run (pass `all` to rebuild both
variants):

```sh
docker run --rm -v "$PWD:/src" -w /src emscripten/emsdk:3.1.74 \
  bash wasm/build.sh all
```

`build.sh [threads|single|all] [out_dir]` writes `pikajieqi.js/.wasm` for the
pthread build and `pikajieqi-st.js/.wasm` for the single-threaded build.

For a smaller audit trail, the same source is reproducible from the exact
upstream commit plus the adjacent `source.patch`:

```sh
git clone https://github.com/official-pikafish/Pikafish.git
cd Pikafish
git checkout 23b9466c981f0f3a1133f92de1a6f86406c4eccc
git apply /path/to/source.patch   # WASM entry points + the misc.h and search.cpp engine fixes
mkdir -p wasm
cp /path/to/build.sh wasm/build.sh
docker run --rm -v "$PWD:/src" -w /src emscripten/emsdk:3.1.74 \
  bash wasm/build.sh all
```

Keep this README, the source archive, `source.patch`, `build.sh`, and
`COPYING.txt` alongside any distributed binary build.
