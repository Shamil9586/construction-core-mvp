import type { Plugin } from 'vite';

/**
 * F5-01 corrective fix (Work review).
 *
 * `BrowserRouter basename="/app.html"` (see `src/app/App.tsx`) is a purely
 * client-side setting: it tells React Router which URL segment is its own
 * root once the F5 bundle is already running in the browser. It has no way
 * to make the *dev server* answer a fresh GET for a deeper path — such as
 * `/app.html/company` or `/app.html/object/:objectId/work/:workId` — with
 * `app.html`. Without this plugin, such a request falls through to Vite's
 * own default SPA fallback, which (for `appType: 'spa'`, the default) serves
 * `index.html` — the *legacy* entry (`/src/main.tsx`) — instead. HTTP 200
 * and the correct URL are preserved either way, which is what made the bug
 * easy to miss: only the response body (and, downstream, the rendered
 * screen) is wrong.
 *
 * This plugin is only that missing piece — a dev-only URL rewrite, installed
 * ahead of Vite's own html/SPA-fallback middleware, so that by the time that
 * middleware runs it sees a request for the exact, real `/app.html` file and
 * serves+transforms it exactly as it already does for a direct `/app.html`
 * request. It does not read or write the file itself, does not touch
 * routing, screens, data, the legacy entry, or the preview entry, and is
 * inert during `vite build` (`apply: 'serve'`) — app.html was never part of
 * the production build and still is not.
 *
 * A real (non-dev) deployment needs the equivalent of this at the
 * infrastructure layer (e.g. a history-API-fallback rule scoped to
 * `/app.html/*`) — out of scope here, same as the rest of F5's "do not
 * connect production backend / do not deploy" boundary.
 */
export function f5AppHtmlFallback(): Plugin {
  const PREFIX = '/app.html/';
  const ENTRY = '/app.html';

  return {
    name: 'f5-app-html-fallback',
    apply: 'serve',
    configureServer(server) {
      // Registered directly in the hook body — NOT returned as a post hook —
      // so this runs BEFORE Vite installs its own html/SPA-fallback
      // middleware. The rewrite has to happen before that middleware decides
      // where an unmatched navigation request goes.
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          next();
          return;
        }

        const rawUrl = req.url ?? '';
        const queryIndex = rawUrl.indexOf('?');
        const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
        const search = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1);

        // Exact boundary: only paths *nested under* /app.html/ are this
        // plugin's business. A neighbouring path like /app.html-other does
        // not start with the '/'-terminated prefix and is left untouched;
        // an exact /app.html request already resolves correctly on its own
        // and does not need rewriting.
        if (!pathname.startsWith(PREFIX)) {
          next();
          return;
        }

        // A real asset (script, stylesheet, source map, image, ...) always
        // carries a file extension on its last path segment; no F5 route
        // param does in this application. Leave anything that looks like a
        // file request alone — this is a generic shape check, not a list of
        // known route/demo identifiers.
        const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
        if (/\.[a-zA-Z0-9]+$/.test(lastSegment)) {
          next();
          return;
        }

        req.url = search ? `${ENTRY}?${search}` : ENTRY;
        next();
      });
    },
  };
}
