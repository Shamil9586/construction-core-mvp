/**
 * CSS Modules are resolved by Vite at build time; TypeScript needs to be told
 * what the default export looks like. Declared explicitly rather than through
 * `vite/client` so the two tsconfigs resolve it identically without depending on
 * the `types` field of either.
 */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
