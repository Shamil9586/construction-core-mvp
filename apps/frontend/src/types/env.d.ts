/**
 * Vite exposes build-time env vars through `import.meta.env`. Declared
 * explicitly, the same way css-modules.d.ts is, rather than pulling in
 * `vite/client` wholesale (see that file's comment on why).
 */
interface ImportMetaEnv {
  /** F6 provider selection — 'mock' | 'real', see data/selectDataProvider.ts. */
  readonly VITE_DATA_PROVIDER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
