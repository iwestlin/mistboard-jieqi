import { defineConfig } from 'vite';

// PikaJieQi is built with Emscripten pthreads, so the page must be
// cross-origin isolated (SharedArrayBuffer). Static hosts need the same two
// headers; see README.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Relative base so the built app can be dropped on any static host/path.
  base: './',
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  build: { target: 'es2022', assetsInlineLimit: 0 },
});
