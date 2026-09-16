import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ root: 'apps/frontend', plugins: [react()], server: { host: '127.0.0.1', port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:3001', rewrite: p => p.replace(/^\/api/, '') } } }, build: { outDir: '../../dist/frontend', emptyOutDir: true } });
