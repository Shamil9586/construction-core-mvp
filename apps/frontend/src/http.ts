/**
 * Разбор HTTP-ответа API.
 *
 * Прокси и middleware отвечают не тем, чем отвечает Nest: express-rate-limit
 * (429) отдаёт text/html, Vite/Caddy на 502/504 — свою HTML-страницу или
 * текст вроде «connect ECONNREFUSED 10.0.0.7:3001». Прямой `response.json()`
 * на таком теле падает с `SyntaxError: Unexpected token ...`, и пользователь
 * вместо «слишком много запросов» видит ошибку парсера, а вызывающий код —
 * не HTTP-ошибку, а сбой разбора. Поэтому тело читается один раз как текст,
 * и JSON разбирается только там, где он действительно объявлен.
 */
function jsonMessage(body: string) { try {
    const data = JSON.parse(body);
    const message = data?.message ?? data?.error;
    return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}
catch {
    return undefined;
} }
/**
 * Сообщение об ошибке для non-OK ответа.
 *
 * Наружу идёт только business-сообщение нашего backend (JSON `message`/`error`)
 * — всё остальное заменяется сообщением по статусу. Тело, пришедшее не от
 * приложения, пользователю не показывается ни при какой длине: HTML-разметка,
 * текст прокси с upstream-адресом и портом, дампы и обрывки JSON одинаково
 * являются деталями инфраструктуры, а не сообщением для пользователя.
 */
export function httpErrorMessage(status: number, contentType: string, body: string) { if ((contentType ?? '').toLowerCase().includes('application/json')) {
    const message = jsonMessage(body);
    if (message)
        return message;
} return status === 429 ? 'Слишком много запросов. Повторите позже.' : 'HTTP ' + status; }
/** Успехом считается только распарсенный JSON успешного ответа. */
export async function parseResponse(response: Response) { const contentType = response.headers.get('content-type') ?? ''; const body = await response.text(); if (!response.ok)
    throw Error(httpErrorMessage(response.status, contentType, body)); try {
    return JSON.parse(body);
}
catch {
    throw Error('Неверный ответ сервера: HTTP ' + response.status);
} }
