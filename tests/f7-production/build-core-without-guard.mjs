/**
 * F7 production-like harness helper — NOT a build path for real use.
 *
 * `npm run build:core` refuses to build without an explicit VITE_DATA_PROVIDER
 * (apps/frontend/vite-plugins/coreBuildEntry.ts). To prove the *runtime* also
 * fails safely — a visible configuration-error screen, never a blank page and
 * never demo data — the harness needs a Core bundle that was built without
 * that guard, as a hand-rolled or future build path might produce one. This
 * builds exactly the Core build's two entries through the repository's own
 * vite.config.ts, but in the default mode, where the guard does not act.
 *
 * Usage (from the repository root): node tests/f7-production/build-core-without-guard.mjs <outDir>
 * The caller controls VITE_DATA_PROVIDER through the environment.
 */
import path from 'node:path';
import { build } from 'vite';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: build-core-without-guard.mjs <outDir>');
  process.exit(2);
}

const root = path.resolve('apps/frontend');

await build({
  configFile: path.resolve('apps/frontend/vite.config.ts'),
  mode: 'production',
  logLevel: 'warn',
  build: {
    outDir: path.resolve(outDir),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: path.join(root, 'index.html'), app: path.join(root, 'app.html') },
    },
  },
});
