import path from 'node:path';
import { loadEnv, type Plugin } from 'vite';

/**
 * F7 — the opt-in production build of the internal Core entry (`app.html`).
 *
 * `npm run build` is unchanged: no `rollupOptions.input`, so Vite builds its
 * default single entry, the legacy `index.html`, exactly as before F7. Core
 * reaches a production bundle only through the explicit command
 * `npm run build:core` (`vite build --mode core`), and only this plugin acts
 * on that mode. Nothing here can add Core to a build that did not ask for it,
 * so there is no hidden second production app.
 *
 * The Core build contains both entries, not Core alone: the web image serves
 * one directory, and the legacy app at `/` (where the Bitrix24 launch lands)
 * must keep working in it. `preview.html` is never an input — the preview
 * stays dev-server only in every build.
 *
 * The Core build also refuses to run unless `VITE_DATA_PROVIDER` is
 * explicitly `real` or `mock` — the same values `selectDataProvider` accepts
 * outside the dev server — read through Vite's own `loadEnv`, i.e. exactly
 * the value the bundle would be compiled with. A missing value is caught here,
 * before anything is written, rather than shipped as a bundle that can only
 * show its configuration-error screen. (The runtime still fails closed on its
 * own if a Core bundle is ever produced some other way.)
 *
 * `apply: 'build'`: inert under the dev server, where the F5 dev rewrite
 * (f5AppHtmlFallback.ts) already serves app.html.
 */
export const CORE_BUILD_MODE = 'core';

export const CORE_BUILD_PROVIDERS = ['real', 'mock'] as const;

export function coreBuildInputs(root: string): { index: string; app: string } {
  return {
    index: path.resolve(root, 'index.html'),
    app: path.resolve(root, 'app.html'),
  };
}

export function assertCoreBuildProvider(rawValue: string | undefined): void {
  const value = rawValue?.trim() ?? '';
  if ((CORE_BUILD_PROVIDERS as readonly string[]).includes(value)) return;

  const received = rawValue === undefined ? 'unset' : JSON.stringify(rawValue);
  throw new Error(
    `npm run build:core requires VITE_DATA_PROVIDER to be set explicitly to "real" or "mock" (received: ${received}). ` +
      'The internal Core production build is refused rather than shipped without a data source.',
  );
}

export function coreBuildEntry(): Plugin {
  return {
    name: 'f7-core-build-entry',
    apply: 'build',
    config(userConfig, { mode }) {
      if (mode !== CORE_BUILD_MODE) return null;

      // The same resolution Vite applies to `root` and `envDir` (both relative
      // to the working directory / root), so the check reads the same files.
      const root = path.resolve(userConfig.root ?? '');
      const envDir = userConfig.envDir ? path.resolve(root, userConfig.envDir) : root;
      assertCoreBuildProvider(loadEnv(mode, envDir, 'VITE_').VITE_DATA_PROVIDER);

      return { build: { rollupOptions: { input: coreBuildInputs(root) } } };
    },
  };
}
