/**
 * User-initiated file save for a Blob fetched with the session bearer (a plain <a href> cannot send Authorization).
 *
 * Why this is not a one-liner — the previous implementation clicked a DETACHED anchor and revoked the object URL on the
 * very next line. Inside an embedded (Bitrix24 iframe) page the browser resolves the download's name and bytes from that
 * blob URL asynchronously, so the early revoke raced it: the file arrived under the generic name "download" with no
 * .docx extension (verified in a cross-origin iframe in Chromium), which Word cannot open. Therefore:
 *   - the anchor is attached to the document for the click (some embedded WebViews ignore a detached one);
 *   - the object URL is revoked only after a long delay, never synchronously.
 */
export const REVOKE_DELAY_MS = 60_000;

/** A file name that is safe on every OS and keeps the extension; never empty. */
export function safeDownloadName(candidate: string | null | undefined, fallback: string): string {
  const cleaned = (candidate ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
  return cleaned || fallback;
}

/** Reads the file name from `Content-Disposition` (RFC 5987 `filename*` first, then plain `filename`). */
export function fileNameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/.exec(header)?.[1]?.trim() ?? null;
}

export function saveBlobAsFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
}
