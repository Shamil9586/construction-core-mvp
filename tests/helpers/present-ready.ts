/**
 * Since the ID-AUTO-1 final gate, a package may only move to PRESENTED (and take the customer-accepted quantity) after the engineer has
 * explicitly chosen how AOSRs are prepared AND a file-backed executive scheme exists. Suites that are about something else (status
 * graph, SDO, locking...) call this before presenting: «АОСР формируются вне Core» needs no Core AOSR, only the scheme file.
 * Idempotent, so it can sit in front of every presentation, including re-presentation after a correction.
 */
const PDF_BASE64 = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64');
export async function readyToPresent(req: (path: string, body?: any, expected?: number) => Promise<any>, packageId: string) {
  const view = await req(`documentation-packages/${packageId}/aosr`);
  if (!view.method) await req(`documentation-packages/${packageId}/aosr-method`, { method: 'EXTERNAL' });
  if (!view.hasFileBackedScheme) await req(`documentation-packages/${packageId}/executive-schemes`, { title: 'Исполнительная схема', fileName: 'scheme.pdf', mimeType: 'application/pdf', base64: PDF_BASE64 });
}
