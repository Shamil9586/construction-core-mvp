/**
 * Разбор HTTP-ответа API.
 *
 * Прокси и middleware отвечают не тем, чем отвечает Nest: express-rate-limit
 * (429) отдаёт text/html, Vite/Caddy на 502/504 — свою HTML-страницу. Прямой
 * `response.json()` на таком теле падает с `SyntaxError: Unexpected token ...`,
 * и пользователь вместо «слишком много запросов» видит ошибку парсера, а
 * вызывающий код — не HTTP-ошибку, а сбой разбора. Поэтому тело читается один
 * раз как текст, и JSON разбирается только там, где он действительно объявлен.
 */
const MAX_TEXT_ERROR = 200;
function jsonMessage(body: string) { try {
    const data = JSON.parse(body);
    const message = data?.message ?? data?.error;
    return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}
catch {
    return undefined;
} }
/**
 * Сообщение об ошибке для non-OK ответа. HTML-разметка наружу не выводится
 * (она не сообщение и может содержать детали инфраструктуры) — вместо неё
 * остаётся `HTTP <status>`.
 */
export function httpErrorMessage(status: number, contentType: string, body: string) { const type = (contentType ?? '').toLowerCase(); if (type.includes('application/json')) {
    const message = jsonMessage(body);
    if (message)
        return message;
} if (type.includes('text/plain')) {
    const text = (body ?? '').trim();
    if (text && !text.includes('<') && text.length <= MAX_TEXT_ERROR)
        return text;
} return 'HTTP ' + status; }
/** Успехом считается только распарсенный JSON успешного ответа. */
export async function parseResponse(response: Response) { const contentType = response.headers.get('content-type') ?? ''; const body = await response.text(); if (!response.ok)
    throw Error(httpErrorMessage(response.status, contentType, body)); try {
    return JSON.parse(body);
}
catch {
    throw Error('Неверный ответ сервера: HTTP ' + response.status);
} }
