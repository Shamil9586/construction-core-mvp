import type { SchemeFileMime, SchemeFilePayload } from '../data/aosrApi';

const MIME_BY_EXTENSION: Record<string, SchemeFileMime> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
export const SCHEME_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const SCHEME_FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg';

/** Reads a chosen file into the upload payload; throws a user-facing Russian message when the file cannot be accepted. */
export async function readSchemeFile(file: File): Promise<SchemeFilePayload> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = (['application/pdf', 'image/png', 'image/jpeg'] as const).find((m) => m === file.type) ?? MIME_BY_EXTENSION[extension];
  if (!mimeType) throw Error('Допустимы файлы PDF, PNG или JPEG');
  if (file.size === 0 || file.size > SCHEME_FILE_MAX_BYTES) throw Error('Файл схемы: от 1 байта до 5 МБ');
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
  return { fileName: file.name, mimeType, base64 };
}
