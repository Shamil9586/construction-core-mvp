import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse, httpErrorMessage } from '../apps/frontend/src/http';

const json = (status: number, body: any) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const html = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const rejection = (r: Response) => parseResponse(r).then(() => null, (e: Error) => e);

test('API error parsing: non-JSON HTTP errors never surface as JSON SyntaxError', async (t) => {
  await t.test('Успешный JSON-ответ возвращается как раньше', async () => {
    assert.deepEqual(await parseResponse(json(200, { id: 'x', version: 2 })), { id: 'x', version: 2 });
    assert.deepEqual(await parseResponse(json(201, [1, 2])), [1, 2]);
  });

  await t.test('Business-ошибка backend сохраняет своё сообщение', async () => {
    await assert.rejects(() => parseResponse(json(409, { statusCode: 409, message: 'Данные изменены другим пользователем. Обновите страницу.', requestId: 'r' })), /Обновите страницу/);
    await assert.rejects(() => parseResponse(json(403, { statusCode: 403, message: 'Недостаточно прав: object.write' })), /Недостаточно прав/);
  });

  await t.test('429 лимитера (text/html) — обычная HTTP-ошибка, а не сбой парсера', async () => {
    // Тело в точности такое, каким его отдаёт express-rate-limit по умолчанию.
    const error = await rejection(html(429, 'Too many requests, please try again later.'));
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'Error');
    assert.equal(error.message, 'HTTP 429');
    assert.doesNotMatch(error.message, /is not valid JSON|Unexpected token|JSON/i);
  });

  await t.test('HTML-страница прокси (502/504) не выводится пользователю как разметка', async () => {
    for (const status of [502, 504]) {
      const page = '<!doctype html><html><head><title>' + status + '</title></head><body><h1>' + status + ' Gateway</h1><pre>upstream 10.0.0.7:3001</pre></body></html>';
      const error = await rejection(html(status, page));
      assert.equal(error!.message, 'HTTP ' + status);
      assert.ok(!error!.message.includes('<'));
      assert.ok(!error!.message.includes('10.0.0.7'));
    }
  });

  await t.test('text/plain-ошибка показывается как есть, если это сообщение, а не разметка', async () => {
    await assert.rejects(() => parseResponse(new Response('Gateway Timeout', { status: 504, headers: { 'content-type': 'text/plain' } })), (e: Error) => e.message === 'Gateway Timeout');
    // Длинный дамп и разметка внутри text/plain наружу не идут.
    assert.equal(httpErrorMessage(500, 'text/plain', 'x'.repeat(5000)), 'HTTP 500');
    assert.equal(httpErrorMessage(500, 'text/plain', '<script>alert(1)</script>'), 'HTTP 500');
  });

  await t.test('JSON-ошибка без message и пустое тело дают честный HTTP-статус', async () => {
    await assert.rejects(() => parseResponse(json(400, { statusCode: 400 })), (e: Error) => e.message === 'HTTP 400');
    await assert.rejects(() => parseResponse(new Response('', { status: 503 })), (e: Error) => e.message === 'HTTP 503');
    // Обрезанный JSON в теле ошибки тоже не должен всплывать как SyntaxError.
    await assert.rejects(() => parseResponse(new Response('{"message":"tru', { status: 500, headers: { 'content-type': 'application/json' } })), (e: Error) => e.message === 'HTTP 500');
  });

  await t.test('Успешный ответ без валидного JSON — понятная ошибка, а не SyntaxError', async () => {
    const error = await rejection(html(200, '<!doctype html><html></html>'));
    assert.equal(error!.name, 'Error');
    assert.match(error!.message, /Неверный ответ сервера: HTTP 200/);
    assert.doesNotMatch(error!.message, /Unexpected token/);
  });
});
