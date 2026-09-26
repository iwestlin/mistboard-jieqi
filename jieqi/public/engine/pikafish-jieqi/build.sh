#!/usr/bin/env bash
set -euo pipefail

# Builds the PikaJieQi WebAssembly module(s).
#
#   build.sh [threads|single|all] [out_dir]
#
#   threads (default) -> pikajieqi.js / pikajieqi.wasm
#       Emscripten pthreads build. Fastest, but needs a cross-origin isolated
#       document (COOP: same-origin + COEP: require-corp) for SharedArrayBuffer,
#       which in-app browsers such as WeChat's cannot provide.
#   single -> pikajieqi-st.js / pikajieqi-st.wasm
#       Single-threaded build. No SharedArrayBuffer, so it runs anywhere,
#       including WeChat's webview. The web app loads this automatically when
#       the page is not cross-origin isolated.
#   all -> both of the above.
#
# The page picks between them at runtime; ship both files together.

variant="${1:-threads}"
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
src_dir="$repo_root/src"
out_dir="${2:-$repo_root/dist/wasm}"

mkdir -p "$out_dir"

sources=(
  benchmark.cpp
  bitboard.cpp
  evaluate.cpp
  main.cpp
  material.cpp
  misc.cpp
  movegen.cpp
  movepick.cpp
  position.cpp
  psqt.cpp
  search.cpp
  thread.cpp
  timeman.cpp
  tt.cpp
  uci.cpp
  ucioption.cpp
  tune.cpp
  nnue/evaluate_nnue.cpp
  nnue/features/half_ka_v2_hm.cpp
  compression/zip.cpp
)

source_paths=()
for source_file in "${sources[@]}"; do
  source_paths+=("$src_dir/$source_file")
done

build_variant() {
  local kind="$1" name="$2"
  local variant_flags=()
  if [ "$kind" = threads ]; then
    variant_flags=(-DUSE_PTHREADS -pthread -sPTHREAD_POOL_SIZE=4)
  else
    # The engine spawns std::thread helpers unconditionally; Emscripten's
    # non-pthread std::thread aborts at runtime, so the single-threaded build
    # compiles the guarded code paths that never create one.
    variant_flags=(-DPIKAFISH_SINGLE_THREAD)
  fi

  em++ \
    "${source_paths[@]}" \
    -I"$src_dir" \
    -std=c++17 \
    -O3 \
    -DNDEBUG \
    -DIS_64BIT \
    -DNO_PREFETCH \
    "${variant_flags[@]}" \
    -msimd128 \
    -fno-exceptions \
    -sWASM=1 \
    -sMODULARIZE=1 \
    -sEXPORT_NAME=PikaJieQi \
    -sENVIRONMENT=web,worker \
    -sEXPORTED_FUNCTIONS=_pikajieqi_initialize,_pikajieqi_command,_malloc,_free \
    -sEXPORTED_RUNTIME_METHODS=cwrap \
    -sINITIAL_MEMORY=64MB \
    -sALLOW_MEMORY_GROWTH=1 \
    -sSTACK_SIZE=3MB \
    -sNO_EXIT_RUNTIME=1 \
    -o "$out_dir/$name.js"

  cp "$repo_root/Copying.txt" "$out_dir/COPYING.txt"
}

case "$variant" in
  threads) build_variant threads pikajieqi ;;
  single)  build_variant single  pikajieqi-st ;;
  all)
    build_variant threads pikajieqi
    build_variant single  pikajieqi-st
    ;;
  *)
    echo "usage: $0 [threads|single|all] [out_dir]" >&2
    exit 2
    ;;
esac
