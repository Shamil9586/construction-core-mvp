/**
 * Vite exposes build-time env vars through `import.meta.env`. Declared
 * explicitly, the same way css-modules.d.ts is, rather than pulling in
 * `vite/client` wholesale (see that file's comment on why).
 */
interface ImportMetaEnv {
  /** F6 provider selection — 'mock' | 'real', see data/selectDataProvider.ts. */
  readonly VITE_DATA_PROVIDER?: string;
  /**
   * Vite's own built-in flag: true under `vite`/`vite dev` (the dev server),
   * false under `vite build` (any built bundle, wherever it is later
   * deployed). `selectDataProvider` uses this — not a test-only parameter —
   * to decide whether an unset `VITE_DATA_PROVIDER` may default to mock
   * (F6-01 corrective).
   */
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
