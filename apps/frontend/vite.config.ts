import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { f5AppHtmlFallback } from './vite-plugins/f5AppHtmlFallback';
import { coreBuildEntry } from './vite-plugins/coreBuildEntry';
// f5AppHtmlFallback: dev-only fix for F5-01 (Work review) — serves app.html
// for a direct open/reload of an /app.html/... deep route instead of Vite's
// default index.html (legacy) SPA fallback. See that file for the full
// explanation; inert during `vite build` (apply: 'serve').
// coreBuildEntry: F7 — adds app.html to the build only under the explicit
// `npm run build:core` (`--mode core`), and refuses that build without an
// explicit VITE_DATA_PROVIDER. Inert for `npm run build` and the dev server.
export default defineConfig({ root: 'apps/frontend', plugins: [react(), f5AppHtmlFallback(), coreBuildEntry()], server: { host: '127.0.0.1', port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:3001', rewrite: p => p.replace(/^\/api/, '') } } }, build: { outDir: '../../dist/frontend', emptyOutDir: true } });
