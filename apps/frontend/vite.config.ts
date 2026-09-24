import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { f5AppHtmlFallback } from './vite-plugins/f5AppHtmlFallback';
// f5AppHtmlFallback: dev-only fix for F5-01 (Work review) — serves app.html
// for a direct open/reload of an /app.html/... deep route instead of Vite's
// default index.html (legacy) SPA fallback. See that file for the full
// explanation; inert during `vite build` (apply: 'serve').
export default defineConfig({ root: 'apps/frontend', plugins: [react(), f5AppHtmlFallback()], server: { host: '127.0.0.1', port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:3001', rewrite: p => p.replace(/^\/api/, '') } } }, build: { outDir: '../../dist/frontend', emptyOutDir: true } });
