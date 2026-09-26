import { defineConfig } from 'vite';

// PikaJieQi ships a pthread build and a single-threaded build. The pthread one
// is used only when the page is cross-origin isolated (COOP/COEP headers, which
// give it SharedArrayBuffer); otherwise the client falls back to the
// single-threaded build, so the app still loads in in-app browsers without
// these headers. Static hosts that can send the two headers get the faster
// pthread build; see README.
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
